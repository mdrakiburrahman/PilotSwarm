import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (file) => readFileSync(path.join(root, file), "utf8");
const json = (file) => JSON.parse(read(file));

test("Nx exposes only explicit targets without caching external state", () => {
    assert.equal(json("nx.json").useDaemonProcess, false);
    assert.equal(json("nx.json").targetDefaults["nx:run-commands"].cache, false);
    for (const dir of ["", "packages/sdk/", "packages/app/", "packages/horizon-store/"]) {
        assert.deepEqual(json(`${dir}package.json`).nx.includedScripts, []);
    }
    const projects = [
        ["project.json", "repo"],
        ["packages/sdk/project.json", "sdk"],
        ["packages/app/project.json", "app"],
        ["packages/horizon-store/project.json", "horizon-store"],
        [".devcontainer/project.json", "devcontainer"],
        ["dev/project.json", "local"],
        ["tools/auth-automation/project.json", "auth-automation"],
    ];
    for (const [file, name] of projects) {
        const project = json(file);
        assert.equal(project.name, name);
        for (const target of Object.values(project.targets)) {
            assert.equal(target.executor, "nx:run-commands");
            assert.notEqual(target.cache, true);
        }
    }
});

test("build graph retains workspace ordering and existing npm commands", () => {
    assert.deepEqual(json("packages/app/project.json").implicitDependencies, ["sdk", "horizon-store"]);
    assert.deepEqual(json("packages/horizon-store/project.json").implicitDependencies, ["sdk"]);
    for (const dir of ["sdk", "app", "horizon-store"]) {
        assert.match(json(`packages/${dir}/project.json`).targets.build.options.command, /npm run build/);
    }
    assert.match(json("package.json").scripts.build, /packages\/sdk.*pilotswarm-horizon-store.*pilotswarm/);
});

test("devcontainer test starts the same workspace before running checks", () => {
    assert.deepEqual(json(".devcontainer/project.json").targets.test.dependsOn, ["up", "scripts-test"]);
    const contributing = read("CONTRIBUTING.md");
    assert.match(contributing, /& "\$GIT_ROOT\\dev\\bootstrap-dev-env\.ps1"/);
    assert.match(contributing, /git clone https:\/\/github\.com\/mdrakiburrahman\/PilotSwarm\.git/);
    assert.match(contributing, /## How to use, on a Linux machine/);
    assert.match(contributing, /Or run the same environment headlessly:/);
    assert.match(contributing, /npx --no-install nx run devcontainer:test/);
    assert.doesNotMatch(contributing, /AcceptFullReset|CQ:\\/);
});

test("verify aggregation excludes live gates, lifecycle and interactive auth", () => {
    const projects = ["project.json", "packages/sdk/project.json", "packages/app/project.json",
        "packages/horizon-store/project.json", ".devcontainer/project.json", "tools/auth-automation/project.json"];
    for (const file of projects) {
        const project = json(file);
        const stack = ["verify"];
        const seen = new Set();
        while (stack.length) {
            const name = stack.pop();
            if (typeof name === "object") {
                assert.equal(name.target, "build");
                continue;
            }
            if (name.startsWith("^") || seen.has(name)) continue;
            seen.add(name);
            assert.ok(!["up", "down", "exec", "test-local", "login", "status", "logs", "test-e2e"].includes(name), `${file}: ${name}`);
            const target = project.targets[name];
            assert.ok(target, `${file}: missing ${name}`);
            stack.push(...(target.dependsOn ?? []));
        }
    }
    assert.equal(json("dev/project.json").targets.verify, undefined);
});

test("local launchers accept dedicated configuration without changing default .env", () => {
    const local = read("scripts/local-pilotswarm.sh");
    const portal = read("scripts/portal-start.sh");
    const tests = read("scripts/run-tests.sh");
    assert.match(local, /LOCAL_ENV_FILE="\$\{PS_LOCAL_ENV_FILE:-\.env\}"/);
    assert.match(local, /PS_LOCAL_MANAGED_DATABASE/);
    assert.match(local, /PORTAL_ENV_FILE="\$LOCAL_ENV_FILE"/);
    assert.match(portal, /ENV_FILE="\$\{PORTAL_ENV_FILE:-\.env\}"/);
    assert.match(tests, /ENV_FILE="\$\{PS_TEST_ENV_FILE:-\.env\}"/);
    assert.ok(!/chmod.*666|docker system prune/.test(local));
});

test("PR container coverage preserves existing native check jobs and requires no secrets", () => {
    const workflow = read(".github/workflows/pr-checks.yml");
    assert.match(workflow, /sdk-unit-windows:/);
    assert.match(workflow, /\n  basic:/);
    const container = workflow.slice(workflow.indexOf("  devcontainer:"), workflow.indexOf("  sdk-unit-windows:"));
    assert.match(container, /devcontainer:up/);
    assert.match(container, /devcontainer:test/);
    assert.match(container, /app:test-e2e/);
    assert.match(container, /if: always\(\)/);
    assert.ok(!/secrets\.|pull_request_target|azure|test-local/i.test(container));
});
