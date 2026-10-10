import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { catalogPath, dependencyPaths, initializeLocalConfigs, repositoryRoot, stateDirectory, testCatalogPath } from "./config.mjs";
import { smoke } from "./smoke.mjs";

export function cleanEnvironment(env) {
    const clean = { ...env };
    for (const key of Object.keys(clean)) {
        if (/^(?:HORIZON_|AZURE_|ANTHROPIC_|OPENAI_|COPILOT_|GH_TOKEN$|GITHUB_TOKEN$|DATABASE_URL$|TEST_DATABASE_URL$|PS_TEST_DATABASE_URL$|PILOTSWARM_(?:RUNTIME|SESSION_CATALOG|DUROXIDE|FACTSTORE|GRAPH|EMBED)|MODEL_PROVIDERS_PATH$)/.test(key)) {
            delete clean[key];
        }
    }
    return { ...clean, PS_MODEL_PROVIDERS_PATH: catalogPath, NX_DAEMON: "false" };
}

export function commandPlan(action, args = []) {
    switch (action) {
        case "install":
            if (!args.length) return ["npm", ["ci", "--no-audit", "--no-fund"]];
            break;
        case "verify":
            if (!args.length) return ["npm", ["exec", "--", "nx", "run-many", "-t", "verify", "--all", "--skip-nx-cache"]];
            break;
        case "test-local":
            if (args.some((arg) => /horizon|all-providers/.test(arg))) throw new Error("This container gate covers stock PostgreSQL only");
            return ["bash", ["scripts/run-tests.sh", ...args]];
        case "local":
            if (args.length === 1 && ["up", "restart", "down", "logs"].includes(args[0])) {
                return ["bash", ["scripts/local-pilotswarm.sh", args[0]]];
            }
            break;
    }
    throw new Error("Usage: container.mjs install|doctor|verify|test-local [suite args]|local up|restart|down|logs|smoke");
}

export function resolveToken(env, run = spawnSync) {
    if (env.GITHUB_TOKEN) return env.GITHUB_TOKEN;
    if (env.GH_TOKEN) return env.GH_TOKEN;
    const result = run("gh", ["auth", "token", "--hostname", "github.com"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0 || !result.stdout?.trim()) {
        throw new Error("Live Copilot tests need GitHub credentials: run gh auth login inside this workspace");
    }
    return result.stdout.trim();
}

export function runDoctor(run = spawnSync) {
    const checks = [
        ["node", ["-e", "if (process.getuid() === 0 || Number(process.versions.node.split('.')[0]) !== 24) process.exit(1)"]],
        ["bash", ["-c", "source /etc/os-release; [[ $ID == ubuntu && $VERSION_ID == 24.04 ]] && dpkg --compare-versions \"$(git version | cut -d' ' -f3)\" ge 2.46"]],
        ["git", ["-C", repositoryRoot, "rev-parse", "--is-inside-work-tree"]],
        ["gh", ["--version"]],
        ["docker", ["version"]],
        ["docker", ["compose", "version"]],
        ["docker", ["buildx", "version"]],
        ["bash", ["-c", "test -S /var/run/docker.sock && [[ $(stat -c '%a' /var/run/docker.sock) != *[2367] ]]"]],
        ["bash", ["-c", "for host in test-db portal-db; do pg_isready -h \"$host\" -U pilotswarm -q || exit; [[ $(PGPASSWORD=local-development-only psql -h \"$host\" -U pilotswarm -d \"pilotswarm_${host%-db}\" -Atc 'SHOW max_connections') -ge 1500 ]] || exit 1; done"]],
        ["node", ["-e", "const { chromium, webkit } = require('playwright'); (async () => { for (const browser of [chromium, webkit]) { const b = await browser.launch({ timeout: 15000 }); await b.close(); } })().catch(error => { console.error(error.message); process.exit(1); })"]],
    ];
    const lock = JSON.parse(readFileSync(path.join(repositoryRoot, "package-lock.json"), "utf8"));
    for (const target of dependencyPaths(lock)) {
        checks.push(["mountpoint", ["--quiet", path.join(repositoryRoot, target)]]);
    }
    for (const [command, args] of checks) {
        const result = run(command, args, { cwd: repositoryRoot, stdio: "inherit", timeout: 45000 });
        if (result.status !== 0) throw new Error(`Doctor failed: ${command} prerequisite (details above)`);
    }
    console.log("Doctor passed: non-root Ubuntu/Node/Git, Docker, isolated dependencies, both databases and browsers");
}

export async function main(args = process.argv.slice(2), run = spawnSync) {
    if (process.env.PILOTSWARM_DEVCONTAINER !== "1" || process.getuid?.() === 0) {
        throw new Error("Run this command as vscode inside the PilotSwarm devcontainer");
    }
    const [action, ...rest] = args;
    if (action === "doctor" && !rest.length) { runDoctor(run); return 0; }
    if (action === "local" && rest.length === 1 && rest[0] === "smoke") {
        await smoke();
        return 0;
    }
    const [command, commandArgs] = commandPlan(action, rest);
    initializeLocalConfigs();
    const env = cleanEnvironment(process.env);
    env.PS_TEST_ENV_FILE = path.join(stateDirectory, "test.env");
    if (action === "test-local") env.PS_MODEL_PROVIDERS_PATH = testCatalogPath;
    if (action === "test-local" || (action === "local" && ["up", "restart"].includes(rest[0]))) {
        env.GITHUB_TOKEN = resolveToken(process.env, run);
    }
    if (action === "local") {
        Object.assign(env, {
            PS_LOCAL_ENV_FILE: path.join(stateDirectory, "portal.env"),
            PORTAL_ENV_FILE: path.join(stateDirectory, "portal.env"),
            PS_LOCAL_MANAGED_DATABASE: "1",
            PS_LOCAL_DIR: "/home/vscode/pilotswarm-local",
            PORTAL_HOST: "0.0.0.0",
            PORT: "3001",
        });
    }
    const result = run(command, commandArgs, { cwd: repositoryRoot, stdio: "inherit", env });
    if (result.error) throw new Error(`Could not start ${command}`);
    return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { process.exitCode = await main(); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
}
