import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const workspaceRoot = "/workspaces/PilotSwarm";
export const stateDirectory = path.join(repositoryRoot, ".devcontainer", ".state");
export const catalogPath = `${workspaceRoot}/deploy/config/model_providers.local-docker.json`;
export const testCatalogPath = `${workspaceRoot}/packages/sdk/test/fixtures/model-providers.test.json`;

export function projectName(root) {
    return `pilotswarm-dev-${createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12)}`;
}

export function sourceImage(root) {
    return `${projectName(root)}-workspace:local`;
}

export function dependencyPaths(lock) {
    const paths = new Set(["node_modules"]);
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
        if (key && !key.includes("node_modules") && !value.link) paths.add(`${key}/node_modules`);
    }
    for (const key of Object.keys(lock.packages ?? {})) {
        const index = key.indexOf("/node_modules/");
        if (index > 0 && !key.slice(0, index).includes("node_modules")) {
            paths.add(`${key.slice(0, index)}/node_modules`);
        }
    }
    for (const target of paths) {
        if (!/^(?:[A-Za-z0-9_.-]+\/)*node_modules$/.test(target) || target.split("/").includes("..")) {
            throw new Error("Unsafe dependency mount path in package-lock.json");
        }
    }
    return [...paths].sort();
}

export function hostGhDirectory(env = process.env, home = os.homedir()) {
    return path.resolve(env.GH_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "gh"));
}

export function composeOverride(root, lock, ghDirectory = hostGhDirectory()) {
    const relativeGhDirectory = path.relative(path.resolve(root), path.resolve(ghDirectory));
    if (!relativeGhDirectory || (!relativeGhDirectory.startsWith(`..${path.sep}`) && relativeGhDirectory !== ".." && !path.isAbsolute(relativeGhDirectory))) {
        throw new Error("Keep the WSL gh profile outside the repository");
    }
    const paths = dependencyPaths(lock);
    const volumes = {};
    const mounts = paths.map((target) => {
        const source = `deps-${createHash("sha256").update(target).digest("hex").slice(0, 12)}`;
        volumes[source] = { labels: { "io.pilotswarm.devcontainer": "source" } };
        return { type: "volume", source, target: `${workspaceRoot}/${target}`, volume: { nocopy: true } };
    });
    mounts.push({ type: "bind", source: ghDirectory, target: "/home/vscode/.config/gh" });
    const playwright = lock.packages?.["node_modules/playwright"]?.version;
    if (!playwright || !/^[0-9A-Za-z.+-]+$/.test(playwright)) {
        throw new Error("A locked Playwright version is required for matching image browsers");
    }
    return {
        name: projectName(root),
        services: {
            workspace: {
                image: sourceImage(root),
                volumes: mounts,
            },
        },
        volumes,
    };
}

export function localConfig(kind) {
    if (!["test", "portal"].includes(kind)) throw new Error("Unknown local configuration");
    const database = kind === "test" ? "pilotswarm_test" : "pilotswarm_portal";
    return [
        `DATABASE_URL=postgresql://pilotswarm:local-development-only@${kind}-db:5432/${database}`,
        `PS_MODEL_PROVIDERS_PATH=${kind === "test" ? testCatalogPath : catalogPath}`,
        "MIN_PG_MAX_CONNECTIONS=1500",
        ...(kind === "test" ? ["PS_TEST_MAX_WORKERS=8"] : []),
        "",
    ].join("\n");
}

export function initializeLocalConfigs(root = repositoryRoot) {
    const state = path.join(root, ".devcontainer", ".state");
    mkdirSync(state, { recursive: true, mode: 0o700 });
    for (const kind of ["test", "portal"]) {
        const file = path.join(state, `${kind}.env`);
        if (!existsSync(file)) writeFileSync(file, localConfig(kind), { mode: 0o600, flag: "wx" });
    }
}

export function initialize(root = repositoryRoot, { ghDirectory = hostGhDirectory(), prepareGhDirectory = true } = {}) {
    if (process.env.PILOTSWARM_DEVCONTAINER === "1") {
        throw new Error("Host Compose metadata must not be regenerated inside the container");
    }
    const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const override = composeOverride(root, lock, ghDirectory);
    initializeLocalConfigs(root);
    if (prepareGhDirectory) mkdirSync(ghDirectory, { recursive: true, mode: 0o700 });
    const state = path.join(root, ".devcontainer", ".state");
    writeFileSync(path.join(state, "mounts.json"), `${JSON.stringify(override, null, 2)}\n`);
    return lock.packages["node_modules/playwright"].version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] !== "mount-paths") throw new Error("Usage: config.mjs mount-paths");
    const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    console.log(dependencyPaths(lock).map((target) => `${workspaceRoot}/${target}`).join("\n"));
}
