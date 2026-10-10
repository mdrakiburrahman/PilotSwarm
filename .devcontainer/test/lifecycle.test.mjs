import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { cleanEnvironment, commandPlan, resolveToken } from "../scripts/container.mjs";
import { composeOverride, dependencyPaths, hostGhDirectory, initialize, initializeLocalConfigs, localConfig, projectName, repositoryRoot } from "../scripts/config.mjs";
import { assertHost, lifecycleEnvironment, lifecyclePlan } from "../scripts/lifecycle.mjs";

const lock = {
    packages: {
        "": {},
        "packages/app": {},
        "packages/sdk": {},
        "tools/auth-automation": {},
        "packages/app/node_modules/vite": {},
        "node_modules/playwright": { version: "1.62.0-alpha-2026-07-20" },
        "node_modules/pilotswarm": { link: true, resolved: "packages/app" },
    },
};

test("mounts cover root and workspace-nested modules without exposing host modules", () => {
    assert.deepEqual(dependencyPaths(lock), [
        "node_modules",
        "packages/app/node_modules",
        "packages/sdk/node_modules",
        "tools/auth-automation/node_modules",
    ]);
    const override = composeOverride("/workspaces/PilotSwarm", lock);
    assert.equal(override.services.workspace.volumes.length, 5);
    const dependencies = override.services.workspace.volumes.filter((mount) => mount.target.endsWith("/node_modules"));
    assert.ok(dependencies.every((mount) => mount.type === "volume" && mount.volume.nocopy));
    assert.equal(Object.keys(override.volumes).length, 4);
    assert.equal(override.services.workspace.image, `${projectName("/workspaces/PilotSwarm")}-workspace:local`);
    assert.ok(!override.services.workspace.build);
});

test("every checked-in workspace package has an isolated dependency mount", () => {
    const actual = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    const mounts = dependencyPaths(actual);
    for (const workspace of ["packages/sdk", "packages/app", "packages/horizon-store"]) {
        assert.ok(mounts.includes(`${workspace}/node_modules`), workspace);
    }
});

test("mount names and project identity are stable and scoped to the checkout", () => {
    const root = "/workspaces/PilotSwarm";
    assert.equal(projectName(root), projectName(root));
    assert.notEqual(projectName(root), projectName("/workspaces/another-checkout"));
    const a = composeOverride(root, lock);
    const b = composeOverride(root, { packages: Object.fromEntries(Object.entries(lock.packages).reverse()) });
    assert.deepEqual(a, b);
    assert.match(a.name, /^pilotswarm-dev-[0-9a-f]{12}$/);
});

test("malformed lockfile paths and unpinned browser version fail closed", () => {
    for (const key of ["../external", "packages/../../external", "/absolute", "packages/a:b"]) {
        assert.throws(() => dependencyPaths({ packages: { [key]: {} } }), /Unsafe/);
    }
    assert.throws(() => composeOverride("/repo", { packages: {} }), /locked Playwright/);
    assert.throws(() => composeOverride("/repo", { packages: { "node_modules/playwright": { version: "1;echo" } } }), /locked Playwright/);
});

test("host lifecycle requires a native Linux checkout and rejects recursive container invocation", () => {
    assert.doesNotThrow(() => assertHost({ platform: "linux", env: {}, root: "/workspaces/PilotSwarm" }));
    assert.throws(() => assertHost({ platform: "win32", env: {}, root: "C:\\git\\PilotSwarm" }), /WSL/);
    assert.throws(() => assertHost({ platform: "linux", env: {}, root: "/mnt/c/git/PilotSwarm" }), /native WSL/);
    assert.throws(() => assertHost({ platform: "linux", env: { PILOTSWARM_DEVCONTAINER: "1" } }), /cannot run inside/);
});

test("direct source build and Compose up use pinned CLI, with no Compose image build", () => {
    const build = lifecyclePlan("build", [], "/repo");
    assert.equal(build.length, 1);
    assert.equal(build[0][0], "node");
    assert.match(build[0][1], /node_modules[\\/]@devcontainers[\\/]cli[\\/]devcontainer\.js$/);
    assert.equal(build[0][2], "build");
    assert.ok(!build.flat().includes("--push"));
    const up = lifecyclePlan("up", [], "/repo");
    assert.equal(up.length, 1);
    assert.equal(up[0][2], "up");
    assert.equal(build[0][build[0].indexOf("--config") + 1], path.join("/repo", ".devcontainer", "devcontainer.build.json"));
    assert.equal(build[0].at(-1), `${projectName("/repo")}-workspace:local`);
    assert.deepEqual(lifecyclePlan("initialize", [], "/repo"), build,
        "VS Code and CLI up initialization must build the same local source image");
    assert.equal(up[0][up[0].indexOf("--workspace-folder") + 1], "/repo");
    assert.equal(up[0][up[0].indexOf("--config") + 1], path.join("/repo", ".devcontainer", "devcontainer.json"));
    assert.ok(up[0].includes("--user-data-folder"));
    assert.ok(!up[0].includes("--skip-post-create"));
});

test("source build scratch path is scoped without altering filesystem security, Bake or BuildKit", () => {
    const inherited = { PATH: "/bin", COMPOSE_BAKE: "true", BUILDX_BAKE_ENTITLEMENTS_FS: "1" };
    for (const action of ["build", "up", "initialize"]) {
        const env = lifecycleEnvironment(action, "/repo", inherited);
        assert.equal(env.COMPOSE_BAKE, "true");
        assert.equal(env.TMPDIR, path.join("/repo", ".devcontainer", ".state", "build-tmp"));
        assert.equal(env.BUILDX_BAKE_ENTITLEMENTS_FS, "1");
        assert.ok(!("DOCKER_BUILDKIT" in env));
        assert.equal(env.PATH, "/bin");
    }
    assert.equal(inherited.COMPOSE_BAKE, "true");
    assert.ok(!("TMPDIR" in inherited));
    for (const action of ["exec", "doctor", "test", "down"]) {
        assert.deepEqual(lifecycleEnvironment(action, "/repo", inherited), inherited);
    }
});

test("cleanup removes only exact Compose project resources; data removal is explicit", () => {
    const down = lifecyclePlan("down", [], "/repo")[0];
    assert.ok(down.includes(projectName("/repo")));
    assert.equal(down.at(-1), "down");
    assert.ok(!down.includes("--volumes"));
    const reset = lifecyclePlan("down", ["--volumes"], "/repo")[0];
    assert.deepEqual(reset.slice(-2), ["down", "--volumes"]);
    assert.ok(!reset.includes("prune"));
    assert.throws(() => lifecyclePlan("down", ["--all"], "/repo"), /Usage/);
});

test("exec passes arguments unchanged through the exact CLI without shell evaluation", () => {
    const args = ["--", "node", "-e", "console.log('literal ; value')"];
    const command = lifecyclePlan("exec", args, "/repo")[0];
    assert.deepEqual(command.slice(-3), args.slice(1));
    assert.equal(command[2], "exec");
    assert.equal(command.at(-4), "--");
    assert.deepEqual(command.slice(3, -4), lifecyclePlan("up", [], "/repo")[0].slice(3));
    assert.throws(() => lifecyclePlan("exec", [], "/repo"), /requires/);
});

test("host test is credential-free verification, never full integration or recursive lifecycle", () => {
    const command = lifecyclePlan("test", [], "/repo")[0];
    assert.deepEqual(command.slice(-3), ["node", ".devcontainer/scripts/container.mjs", "verify"]);
    assert.deepEqual(commandPlan("verify"), [
        "npm", ["exec", "--", "nx", "run-many", "-t", "verify", "--all", "--skip-nx-cache"],
    ]);
    assert.deepEqual(commandPlan("test-local", ["--suite=smoke"]), ["bash", ["scripts/run-tests.sh", "--suite=smoke"]]);
    assert.throws(() => commandPlan("test-local", ["--all-providers"]), /PostgreSQL/);
    assert.throws(() => commandPlan("test-local", ["--with-horizondb"]), /PostgreSQL/);
});

test("configuration uses separate Compose DNS databases, unchanged parallelism and no token", () => {
    const testConfig = localConfig("test");
    const portalConfig = localConfig("portal");
    assert.match(testConfig, /@test-db:5432\/pilotswarm_test/);
    assert.match(portalConfig, /@portal-db:5432\/pilotswarm_portal/);
    assert.match(testConfig, /MIN_PG_MAX_CONNECTIONS=1500/);
    assert.match(testConfig, /PS_TEST_MAX_WORKERS=8/);
    for (const config of [testConfig, portalConfig]) {
        assert.ok(!config.includes("localhost"));
        assert.ok(!config.includes("GITHUB_TOKEN"));
    }
    assert.match(testConfig, /packages\/sdk\/test\/fixtures\/model-providers.test.json/);
    assert.match(portalConfig, /deploy\/config\/model_providers.local-docker.json/);
    assert.throws(() => localConfig("remote"), /Unknown/);
});

test("host initialization is idempotent; container config initialization never rewrites host mounts", () => {
    const fixture = path.join(repositoryRoot, ".devcontainer", ".state", `fixture-${process.pid}`);
    mkdirSync(fixture, { recursive: true });
    try {
        writeFileSync(path.join(fixture, "package-lock.json"), JSON.stringify(lock));
        const options = { ghDirectory: "/home/wsl/.config/gh", prepareGhDirectory: false };
        const originalMarker = process.env.PILOTSWARM_DEVCONTAINER;
        delete process.env.PILOTSWARM_DEVCONTAINER;
        try { initialize(fixture, options); }
        finally {
            if (originalMarker === undefined) delete process.env.PILOTSWARM_DEVCONTAINER;
            else process.env.PILOTSWARM_DEVCONTAINER = originalMarker;
        }
        const state = path.join(fixture, ".devcontainer", ".state");
        assert.equal(readFileSync(path.join(state, "test.env"), "utf8"), localConfig("test"));
        assert.equal(readFileSync(path.join(state, "portal.env"), "utf8"), localConfig("portal"));
        assert.ok(!existsSync(path.join(fixture, ".env")));
        assert.ok(!existsSync(path.join(fixture, ".env.remote")));
        assert.ok(!existsSync(path.join(fixture, ".model_providers.json")));
        const custom = `${localConfig("test")}# custom developer setting\n`;
        writeFileSync(path.join(state, "test.env"), custom);
        const updated = structuredClone(lock);
        updated.packages["packages/new-workspace"] = {};
        writeFileSync(path.join(fixture, "package-lock.json"), JSON.stringify(updated));
        const originalMounts = readFileSync(path.join(state, "mounts.json"), "utf8");
        initializeLocalConfigs(fixture);
        assert.equal(readFileSync(path.join(state, "mounts.json"), "utf8"), originalMounts);
        const marker = process.env.PILOTSWARM_DEVCONTAINER;
        process.env.PILOTSWARM_DEVCONTAINER = "1";
        try { assert.throws(() => initialize(fixture, options), /must not be regenerated/); }
        finally {
            if (marker === undefined) delete process.env.PILOTSWARM_DEVCONTAINER;
            else process.env.PILOTSWARM_DEVCONTAINER = marker;
        }
        delete process.env.PILOTSWARM_DEVCONTAINER;
        try { initialize(fixture, options); }
        finally {
            if (marker !== undefined) process.env.PILOTSWARM_DEVCONTAINER = marker;
        }
        assert.equal(readFileSync(path.join(state, "test.env"), "utf8"), custom);
        const generated = JSON.parse(readFileSync(path.join(state, "mounts.json"), "utf8"));
        assert.ok(generated.services.workspace.volumes.some((mount) => mount.target.endsWith("/packages/new-workspace/node_modules")));
    } finally {
        rmSync(fixture, { recursive: true, force: true });
    }
});

test("gh bind shares the selected WSL profile without copying credentials into the checkout", () => {
    const directory = hostGhDirectory({}, path.join(path.parse(repositoryRoot).root, "home", "wsl"));
    assert.match(directory, /[\\/]home[\\/]wsl[\\/]\.config[\\/]gh$/);
    const custom = path.join(path.parse(repositoryRoot).root, "profiles", "gh");
    assert.equal(hostGhDirectory({ GH_CONFIG_DIR: custom }), custom);
    const override = composeOverride("/repo", lock, custom);
    const mount = override.services.workspace.volumes.find((item) => item.target === "/home/vscode/.config/gh");
    assert.deepEqual(mount, { type: "bind", source: custom, target: "/home/vscode/.config/gh" });
    assert.throws(() => composeOverride("/repo", lock, "/repo/.config/gh"), /outside the repository/);
});

test("credential-free child environment removes inherited cloud/model routing and secrets", () => {
    const clean = cleanEnvironment({
        PATH: "/bin",
        GITHUB_TOKEN: "never-print",
        GH_TOKEN: "never-print",
        HORIZON_DATABASE_URL: "never-use",
        AZURE_CLIENT_SECRET: "never-use",
        OPENAI_API_KEY: "never-use",
        ANTHROPIC_API_KEY: "never-use",
        COPILOT_TOKEN: "never-use",
        DATABASE_URL: "never-use",
        TEST_DATABASE_URL: "never-use",
        PS_TEST_DATABASE_URL: "never-use",
        PILOTSWARM_RUNTIME_URL: "never-use",
        MODEL_PROVIDERS_PATH: "private-file",
        PS_MODEL_PROVIDERS_PATH: "private-file",
    });
    assert.equal(clean.PATH, "/bin");
    assert.equal(clean.NX_DAEMON, "false");
    assert.match(clean.PS_MODEL_PROVIDERS_PATH, /model_providers.local-docker.json$/);
    assert.ok(!Object.values(clean).includes("never-use"));
    assert.ok(!Object.values(clean).includes("never-print"));
    assert.ok(!Object.values(clean).includes("private-file"));
});

test("live token stays in memory; auth errors never reveal gh stdout or stderr", () => {
    let calls = 0;
    const run = (command, args, options) => {
        calls++;
        assert.equal(command, "gh");
        assert.deepEqual(args, ["auth", "token", "--hostname", "github.com"]);
        assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
        return { status: 0, stdout: "memory-token\n" };
    };
    assert.equal(resolveToken({}, run), "memory-token");
    assert.equal(calls, 1);
    assert.equal(resolveToken({ GITHUB_TOKEN: "existing-token" }, run), "existing-token");
    assert.equal(calls, 1);
    assert.throws(() => resolveToken({}, () => ({ status: 1, stdout: "secret", stderr: "secret" })), (error) => {
        assert.ok(!error.message.includes("secret"));
        return /gh auth login/.test(error.message);
    });
});

test("local wrapper reuses maintained launcher and validates action names", () => {
    for (const action of ["up", "restart", "down", "logs"]) {
        assert.deepEqual(commandPlan("local", [action]), ["bash", ["scripts/local-pilotswarm.sh", action]]);
    }
    assert.throws(() => commandPlan("local", ["reset"]), /Usage/);
    assert.throws(() => commandPlan("build"), /Usage/);
});

test("source image excludes repository/credentials and includes no cloud provisioning SDK", () => {
    const dockerfile = readFileSync(path.join(repositoryRoot, ".devcontainer", "Dockerfile"), "utf8");
    const ignore = readFileSync(path.join(repositoryRoot, ".devcontainer", ".dockerignore"), "utf8");
    assert.match(dockerfile, /FROM ubuntu:24\.04/);
    assert.match(dockerfile, /NODE_VERSION=24\./);
    assert.match(dockerfile, /install --with-deps chromium firefox webkit/);
    assert.match(dockerfile, /docker-ce-cli docker-buildx-plugin docker-compose-plugin/);
    assert.match(dockerfile, /sha256sum -c/);
    assert.match(ignore, /^\*\*\r?\n!Dockerfile/);
    assert.ok(!/azure-cli|az login|COPY \.\s|COPY.*\.env|chmod.*666/.test(dockerfile));
});

test("base Compose isolates PostgreSQL, capacity and forwarding without public database ports", () => {
    const compose = readFileSync(path.join(repositoryRoot, ".devcontainer", "compose.yml"), "utf8");
    assert.equal((compose.match(/max_connections=1500/g) ?? []).length, 2);
    assert.equal((compose.match(/pg_isready/g) ?? []).length, 2);
    assert.equal((compose.match(/service_healthy/g) ?? []).length, 2);
    assert.match(compose, /127\.0\.0\.1:3001:3001/);
    assert.ok(!compose.includes("5432:5432"));
    assert.ok(!compose.includes("privileged:"));
    assert.ok(!compose.includes("container_name:"));
    assert.ok(!/^\s+build:/m.test(compose));
});

test("VS Code initializes generated workspace mounts and uses the same source Compose", () => {
    const config = JSON.parse(readFileSync(path.join(repositoryRoot, ".devcontainer", "devcontainer.json"), "utf8"));
    assert.deepEqual(config.dockerComposeFile, ["compose.yml", ".state/mounts.json"]);
    assert.equal(config.remoteUser, "vscode");
    assert.equal(config.workspaceFolder, "/workspaces/PilotSwarm");
    assert.ok(config.initializeCommand.includes("initialize"));
    assert.ok(config.postCreateCommand.includes("install"));
    const builder = JSON.parse(readFileSync(path.join(repositoryRoot, ".devcontainer", "devcontainer.build.json"), "utf8"));
    assert.equal(builder.build.dockerfile, "Dockerfile");
    assert.equal(builder.build.context, ".");
    assert.equal(builder.build.args.PLAYWRIGHT_VERSION, "${localEnv:PILOTSWARM_BUILD_PLAYWRIGHT_VERSION}");
    assert.ok(!builder.initializeCommand, "the builder must never recursively initialize itself");
});

test("Nx verification runs only script contracts and cannot recursively invoke host lifecycle", () => {
    const project = JSON.parse(readFileSync(path.join(repositoryRoot, ".devcontainer", "project.json"), "utf8"));
    assert.deepEqual(project.targets.verify.dependsOn, ["scripts-test"]);
    assert.ok(!/lifecycle\.mjs/.test(project.targets.verify.options.command));
    assert.match(project.targets["scripts-test"].options.command, /node --test/);
    assert.ok(!/lifecycle\.mjs/.test(project.targets["scripts-test"].options.command));
});

test("entrypoint grants socket group access without modifying socket permissions or host ownership", () => {
    const entrypoint = readFileSync(path.join(repositoryRoot, ".devcontainer", "scripts", "entrypoint.sh"), "utf8");
    assert.match(entrypoint, /usermod -aG/);
    assert.match(entrypoint, /exec runuser -u vscode/);
    assert.match(entrypoint, /git config --global --add safe\.directory \/workspaces\/PilotSwarm/);
    assert.ok(!/chown.*\/home\/vscode\/\.config\/gh|chmod.*\/home\/vscode\/\.config\/gh/.test(entrypoint));
    assert.ok(!/chmod.*socket|chmod.*666|chown -R|docker.*prune/.test(entrypoint));
});

test("full test wrapper accepts dedicated configuration in baseline and unit phases", () => {
    const script = readFileSync(path.join(repositoryRoot, "scripts", "run-tests.sh"), "utf8");
    assert.match(script, /ENV_FILE="\$\{PS_TEST_ENV_FILE:-\.env\}"/);
    assert.match(script, /--env-file-if-exists="\$ENV_FILE"/);
});
