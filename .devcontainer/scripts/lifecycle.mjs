import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initialize, projectName, repositoryRoot, sourceImage } from "./config.mjs";

export function assertHost({ platform = process.platform, env = process.env, root = repositoryRoot } = {}) {
    if (env.PILOTSWARM_DEVCONTAINER === "1") throw new Error("Host lifecycle targets cannot run inside the container");
    if (platform !== "linux") throw new Error("Run this target in the Ubuntu 24.04 WSL checkout, not Windows");
    if (/^\/mnt\/[a-z](?:\/|$)/i.test(root)) throw new Error("Use a native WSL checkout, not a Windows drive mount");
}

export function lifecyclePlan(action, args = [], root = repositoryRoot) {
    const compose = ["docker", "compose", "--project-name", projectName(root), "--file",
        path.join(root, ".devcontainer", "compose.yml"), "--file",
        path.join(root, ".devcontainer", ".state", "mounts.json")];
    const cli = ["node", path.join(root, "node_modules", "@devcontainers", "cli", "devcontainer.js")];
    const flags = ["--workspace-folder", root, "--config", path.join(root, ".devcontainer", "devcontainer.json"),
        "--user-data-folder", path.join(root, ".devcontainer", ".state", "cli")];
    const exec = [...cli, "exec", ...flags];
    const build = [...cli, "build", "--workspace-folder", root, "--config",
        path.join(root, ".devcontainer", "devcontainer.build.json"),
        "--user-data-folder", path.join(root, ".devcontainer", ".state", "cli"),
        "--image-name", sourceImage(root)];
    const inside = ["node", ".devcontainer/scripts/container.mjs"];
    switch (action) {
        case "initialize": if (args.length) break; return [build];
        case "build": if (args.length) break; return [build];
        case "up": if (args.length) break; return [[...cli, "up", ...flags]];
        case "exec": {
            const command = args[0] === "--" ? args.slice(1) : args;
            if (!command.length) throw new Error("exec requires -- followed by a command");
            return [[...exec, "--", ...command]];
        }
        case "doctor": if (args.length) break; return [[...exec, "--", ...inside, "doctor"]];
        case "test": if (args.length) break; return [[...exec, "--", ...inside, "verify"]];
        case "down":
            if (args.length === 0 || (args.length === 1 && args[0] === "--volumes")) {
                return [[...compose, "down", ...(args.length ? ["--volumes"] : [])]];
            }
            break;
    }
    throw new Error("Usage: lifecycle.mjs initialize|build|up|exec -- <command>|doctor|test|down [--volumes]");
}

export function lifecycleEnvironment(action, root, inherited = process.env) {
    if (!["build", "up", "initialize"].includes(action)) return { ...inherited };
    // Direct CLI image builds avoid Compose #14285 entirely. Keep generated
    // build files in the checkout rather than the system temporary directory.
    return {
        ...inherited,
        TMPDIR: path.join(root, ".devcontainer", ".state", "build-tmp"),
    };
}

export function main(args = process.argv.slice(2), run = spawnSync) {
    const root = realpathSync(repositoryRoot);
    assertHost({ root });
    const plan = lifecyclePlan(args[0], args.slice(1), root);
    const playwrightVersion = initialize(root);
    const env = lifecycleEnvironment(args[0], root);
    if (["build", "up", "initialize"].includes(args[0])) {
        mkdirSync(env.TMPDIR, { recursive: true, mode: 0o700 });
        env.PILOTSWARM_BUILD_PLAYWRIGHT_VERSION = playwrightVersion;
    }
    for (const [command, ...commandArgs] of plan) {
        const result = run(command === "node" ? process.execPath : command, commandArgs, { cwd: root, stdio: "inherit", env });
        if (result.error) throw new Error("Dev Container command could not start; run WSL bootstrap and host npm ci first");
        if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = main(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
