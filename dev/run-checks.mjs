import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const env = {
    ...process.env,
    PS_MODEL_PROVIDERS_PATH: resolve(root, ".model_providers.example.json"),
};

function run(command, args, cwd = root) {
    const result = spawnSync(command, args, {
        cwd,
        env,
        stdio: "inherit",
        shell: process.platform === "win32" && command === "npm",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

function nodeTests(patterns, flags = []) {
    const files = globSync(patterns, { cwd: root }).sort();
    if (files.length === 0) throw new Error(`No tests found: ${patterns.join(", ")}`);
    run(process.execPath, [...flags, "--test", ...files]);
}

switch (process.argv[2]) {
    case "sdk":
        nodeTests(["packages/sdk/test/unit/*.test.mjs", "packages/sdk/api/test/*.test.mjs"]);
        break;
    case "app":
        run("npm", ["test", "--workspace=packages/app"]);
        break;
    case "repo":
        run("npm", ["run", "test:deploy-scripts"]);
        nodeTests([".github/scripts/test/*.test.mjs", ".github/scripts/integration/*.test.mjs"]);
        nodeTests(["scripts/test/*.test.mjs", "dev/test/*.test.mjs"]);
        break;
    default:
        throw new Error("Usage: node dev/run-checks.mjs sdk|app|repo");
}
