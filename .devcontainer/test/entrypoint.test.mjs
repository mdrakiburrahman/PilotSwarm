import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { repositoryRoot } from "../scripts/config.mjs";

function bashExecutable() {
    if (process.platform !== "win32") return "bash";
    const gitExecPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
    const executable = path.join(path.resolve(gitExecPath, "../../.."), "bin", "bash.exe");
    assert.ok(existsSync(executable), "Git Bash is required for shell contract tests");
    return executable;
}

const source = readFileSync(path.join(repositoryRoot, ".devcontainer", "scripts", "entrypoint.sh"), "utf8")
    .replace(/\r\n/g, "\n");
const definition = source.match(/    resolve_socket_group\(\) \{[\s\S]*?\n    \}/)?.[0];
assert.ok(definition, "entrypoint must resolve the socket group explicitly");

function resolveGroup(status, entry = "") {
    const program = `
set -euo pipefail
getent() { printf '%s' "$FAKE_ENTRY"; return "$FAKE_STATUS"; }
groupadd() { printf 'GROUPADD:%s\\n' "$*"; }
${definition}
resolve_socket_group 987
printf 'RESOLVED:%s\\n' "$group"
`;
    return spawnSync(bashExecutable(), ["-c", program], {
        encoding: "utf8",
        env: { ...process.env, FAKE_STATUS: String(status), FAKE_ENTRY: entry },
    });
}

test("entrypoint creates a socket group when getent reports no matching group", () => {
    const result = resolveGroup(2);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /GROUPADD:--gid 987 host-docker/);
    assert.match(result.stdout, /RESOLVED:host-docker/);
});

test("entrypoint reuses the existing socket group without groupadd", () => {
    const result = resolveGroup(0, "existing-docker:x:987:");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESOLVED:existing-docker/);
    assert.doesNotMatch(result.stdout, /GROUPADD:/);
});

test("entrypoint fails explicitly for group lookup errors rather than treating them as absence", () => {
    const result = resolveGroup(3);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /group lookup failed \(exit 3\)/);
    assert.doesNotMatch(result.stdout, /GROUPADD:|RESOLVED:/);
});

test("entrypoint rejects an empty successful group lookup", () => {
    const result = resolveGroup(0);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /returned an empty group/);
    assert.doesNotMatch(result.stdout, /GROUPADD:|RESOLVED:/);
});

test("entrypoint propagates group creation failures", () => {
    const program = `
set -euo pipefail
getent() { return 2; }
groupadd() { return 7; }
${definition}
resolve_socket_group 987
printf 'UNREACHABLE\\n'
`;
    const result = spawnSync(bashExecutable(), ["-c", program], { encoding: "utf8" });
    assert.equal(result.status, 7);
    assert.doesNotMatch(result.stdout, /UNREACHABLE/);
});

test("entrypoint captures mount enumeration before ownership changes and propagates failure", () => {
    const mountBlock = source.match(/mount_paths=.*\nwhile IFS=[\s\S]*?done <<< "\$mount_paths"/)?.[0];
    assert.ok(mountBlock, "capture node output before the loop rather than using process substitution");
    const failed = spawnSync(bashExecutable(), ["-c", `
set -euo pipefail
node() { return 9; }
chown() { printf 'CHOWN_CALLED\\n'; }
${mountBlock}
printf 'UNREACHABLE\\n'
`], { encoding: "utf8" });
    assert.equal(failed.status, 9);
    assert.doesNotMatch(failed.stdout, /CHOWN_CALLED|UNREACHABLE/);
    const passed = spawnSync(bashExecutable(), ["-c", `
set -euo pipefail
node() { printf '/workspace/node_modules\\n/workspace/packages/app/node_modules\\n'; }
chown() { printf 'CHOWN:%s\\n' "$*"; }
${mountBlock}
`], { encoding: "utf8" });
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /CHOWN:vscode:vscode \/workspace\/node_modules/);
    assert.match(passed.stdout, /CHOWN:vscode:vscode \/workspace\/packages\/app\/node_modules/);
});
