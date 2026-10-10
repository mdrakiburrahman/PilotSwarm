/**
 * Remote execution over Azure Relay hybrid connections, using `az` to list
 * and authorize the connections and `privy` (https://github.com/mdrakiburrahman/privy)
 * to run commands on the machine that listens on one.
 *
 * Provider settings (all from the environment):
 *   PS_RELAY_SUBSCRIPTION    Azure subscription id of the Relay namespace
 *   PS_RELAY_RESOURCE_GROUP  its resource group
 *   PS_RELAY_NAMESPACE       the Relay namespace
 *   PS_RELAY_KEYRULE         authorization rule on each connection (default: all)
 *   PS_REMOTE_REPO_ROOT      the repo checkout on the remote side (default: /__w/1/s)
 *   PS_REMOTE_AZ_BIN / PS_REMOTE_PRIVY_BIN   program names (default: az, privy)
 *
 * The relay key is read through `az` for each connection, kept in memory for
 * a few minutes, and handed to privy only through the child's environment.
 */
import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";

const TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,259}$/;
const KEY_TTL_MS = 5 * 60_000;
const LIST_TTL_MS = 5_000;
export const DEFAULT_REPO_ROOT = "/__w/1/s";
export const MAX_OUTPUT_CHARS = 60_000;

export function defaultRun(file, args, { env, timeoutMs } = {}) {
    return new Promise((resolve) => {
        execFile(file, args, {
            env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
        }, (error, stdout, stderr) => {
            resolve({
                code: error ? (typeof error.code === "number" ? error.code : -1) : 0,
                stdout: String(stdout ?? ""),
                stderr: String(stderr ?? ""),
                spawnError: error && typeof error.code !== "number" ? error : null,
            });
        });
    });
}

/** `az` on Windows ends its output lines with CRLF; a key with a stray \r fails the relay signature. */
const clean = (text) => String(text ?? "").replace(/\r/g, "").trim();

/** Cut long output in the middle so the start and the end (errors) both survive. */
export function truncateMiddle(text, max = MAX_OUTPUT_CHARS) {
    const value = String(text ?? "");
    if (value.length <= max) return value;
    const keep = Math.floor(max / 2);
    return `${value.slice(0, keep)}\n... [${value.length - 2 * keep} characters omitted] ...\n${value.slice(-keep)}`;
}

export function assertTargetName(name) {
    if (typeof name !== "string" || !TARGET_PATTERN.test(name)) {
        throw new Error(`invalid remote target name: ${JSON.stringify(name)}`);
    }
    return name;
}

/** POSIX single-quote a value for the remote bash. */
export function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function relayConfigFromEnv(env = process.env) {
    const config = {
        subscription: env.PS_RELAY_SUBSCRIPTION || "",
        resourceGroup: env.PS_RELAY_RESOURCE_GROUP || "",
        namespace: env.PS_RELAY_NAMESPACE || "",
        keyRule: env.PS_RELAY_KEYRULE || "all",
        repoRoot: env.PS_REMOTE_REPO_ROOT || DEFAULT_REPO_ROOT,
        azBin: env.PS_REMOTE_AZ_BIN || "az",
        privyBin: env.PS_REMOTE_PRIVY_BIN || "privy",
        // Optional: a file holding an ARM bearer token (refreshed from outside,
        // see scripts/relay-token.sh). When set, the relay is read over ARM REST
        // and `az` is not needed in the process.
        tokenFile: env.PS_RELAY_ARM_TOKEN_FILE || "",
    };
    const missing = [
        ["PS_RELAY_SUBSCRIPTION", config.subscription],
        ["PS_RELAY_RESOURCE_GROUP", config.resourceGroup],
        ["PS_RELAY_NAMESPACE", config.namespace],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) throw new Error(`remote relay provider needs ${missing.join(", ")}`);
    return config;
}

/**
 * @param {object} options
 * @param {ReturnType<typeof relayConfigFromEnv>} options.config
 * @param {typeof defaultRun} [options.run]   child-process runner (tests pass a fake)
 * @param {NodeJS.ProcessEnv} [options.env]   environment handed to children
 * @param {() => number} [options.now]
 */
export function createRelayProvider({ config, run = defaultRun, env = process.env, now = Date.now, fetchImpl = globalThis.fetch, readFile = (file) => fsReadFile(file, "utf8") }) {
    const keys = new Map();
    let listCache = null;

    const azBase = ["relay", "hyco"];
    const scope = ["--subscription", config.subscription, "--resource-group", config.resourceGroup, "--namespace-name", config.namespace];

    const armBase = `https://management.azure.com/subscriptions/${encodeURIComponent(config.subscription)}`
        + `/resourceGroups/${encodeURIComponent(config.resourceGroup)}/providers/Microsoft.Relay/namespaces/${encodeURIComponent(config.namespace)}`;

    async function arm(method, path) {
        let token;
        try { token = clean(await readFile(config.tokenFile)); } catch { token = ""; }
        if (!token) throw new Error(`no ARM token in ${config.tokenFile}; run scripts/relay-token.sh on the host`);
        const response = await fetchImpl(`${armBase}${path}api-version=2021-11-01`, { method, headers: { authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error(`ARM ${response.status}: ${clean(await response.text()).slice(0, 200)}`);
        return response.json();
    }

    async function listTargets({ fresh = false } = {}) {
        if (!fresh && listCache && now() - listCache.at < LIST_TTL_MS) return listCache.targets;
        if (config.tokenFile) {
            const body = await arm("GET", "/hybridConnections?");
            const targets = (body.value || []).map((row) => {
                const listenerCount = Number(row?.properties?.listenerCount ?? 0) || 0;
                return { id: String(row?.name ?? ""), label: String(row?.name ?? ""), listenerCount, available: listenerCount > 0 };
            }).sort((a, b) => Number(b.available) - Number(a.available) || a.id.localeCompare(b.id));
            listCache = { at: now(), targets };
            return targets;
        }
        const result = await run(config.azBin, [...azBase, "list", ...scope, "--output", "json"], { env, timeoutMs: 60_000 });
        if (result.code !== 0) {
            throw new Error(`could not list relay connections: ${clean(result.stderr || result.spawnError?.message || "az failed").slice(0, 500)}`);
        }
        let rows;
        try { rows = JSON.parse(clean(result.stdout) || "[]"); } catch { throw new Error("could not list relay connections: az returned invalid JSON"); }
        const targets = (Array.isArray(rows) ? rows : [])
            .map((row) => {
                const listenerCount = Number(row?.listenerCount ?? 0) || 0;
                return { id: String(row?.name ?? ""), label: String(row?.name ?? ""), listenerCount, available: listenerCount > 0 };
            })
            .filter((target) => TARGET_PATTERN.test(target.id))
            .sort((a, b) => Number(b.available) - Number(a.available) || a.id.localeCompare(b.id));
        listCache = { at: now(), targets };
        return targets;
    }

    async function getKey(target) {
        assertTargetName(target);
        const cached = keys.get(target);
        if (cached && now() - cached.at < KEY_TTL_MS) return cached.key;
        if (config.tokenFile) {
            const body = await arm("POST", `/hybridConnections/${encodeURIComponent(target)}/authorizationRules/${encodeURIComponent(config.keyRule)}/listKeys?`);
            const armKey = clean(body.primaryKey || "");
            if (!armKey) throw new Error(`could not get the relay key for ${target}`);
            keys.set(target, { at: now(), key: armKey });
            return armKey;
        }
        const result = await run(config.azBin, [
            ...azBase, "authorization-rule", "keys", "list", ...scope,
            "--hybrid-connection-name", target, "--name", config.keyRule,
            "--query", "primaryKey", "--output", "tsv",
        ], { env, timeoutMs: 60_000 });
        const key = clean(result.stdout);
        if (result.code !== 0 || !key) {
            throw new Error(`could not get the relay key for ${target}: ${clean(result.stderr || "no key returned").slice(0, 300)}`);
        }
        keys.set(target, { at: now(), key });
        return key;
    }

    const redact = (text, key) => (key ? String(text).split(key).join("[redacted]") : String(text));

    /**
     * Run a bash command on the machine listening on `target`.
     * @returns {{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, error: string|null }}
     */
    async function exec(target, command, { timeoutS = 600 } = {}) {
        assertTargetName(target);
        if (typeof command !== "string" || !command.trim()) throw new Error("command is required");
        const targets = await listTargets();
        const row = targets.find((entry) => entry.id === target);
        if (!row) throw new Error(`unknown remote target: ${target}`);
        if (!row.available) throw new Error(`remote target ${target} has no listener (start the listener, then retry)`);
        const key = await getKey(target);
        const seconds = Math.max(1, Math.min(Number(timeoutS) || 600, 3600));
        const result = await run(config.privyBin, ["client", "--json", "--timeout-s", String(seconds), "--bash", command], {
            env: {
                ...env,
                PRIVY_RELAY_NAMESPACE: config.namespace,
                PRIVY_RELAY_PATH: target,
                PRIVY_RELAY_KEYRULE: config.keyRule,
                PRIVY_RELAY_KEY: key,
            },
            timeoutMs: (seconds + 60) * 1000,
        });
        const text = result.stdout.trim();
        let parsed = null;
        try { parsed = text ? JSON.parse(text.split("\n").filter(Boolean).pop()) : null; } catch { /* reported below */ }
        if (!parsed) {
            return {
                exitCode: null, stdout: "", timedOut: false,
                stderr: truncateMiddle(redact(clean(result.stderr || result.spawnError?.message || text), key)),
                error: "privy did not return a result",
            };
        }
        return {
            exitCode: Number.isInteger(parsed.exit_code) ? parsed.exit_code : null,
            stdout: truncateMiddle(redact(parsed.stdout ?? "", key)),
            stderr: truncateMiddle(redact(parsed.stderr ?? "", key)),
            timedOut: Boolean(parsed.timed_out),
            error: parsed.error ? String(parsed.error) : null,
        };
    }

    /** The repo's instruction files, so the agent follows the repo's own rules. */
    async function loadContext(target, { maxChars = 40_000 } = {}) {
        const script = [
            `cd ${shQuote(config.repoRoot)} 2>/dev/null || { echo "repo root not found: ${config.repoRoot}"; exit 0; }`,
            `echo "## repo root: $(pwd)"; git log -1 --format='## HEAD: %h %s' 2>/dev/null || true`,
            `for f in .github/copilot-instructions.md AGENTS.md CLAUDE.md .github/instructions/*.md; do`,
            `  [ -f "$f" ] && { echo; echo "===== $f ====="; cat "$f"; }`,
            "done",
            `for f in .github/skills/*/SKILL.md; do [ -f "$f" ] && { echo; echo "===== skill: $f ====="; sed -n '1,12p' "$f"; }; done`,
            "true",
        ].join("\n");
        const result = await exec(target, script, { timeoutS: 120 });
        return {
            repoRoot: config.repoRoot,
            exitCode: result.exitCode,
            text: truncateMiddle(result.stdout, maxChars),
            error: result.error || (result.exitCode ? truncateMiddle(result.stderr, 2000) : null),
        };
    }

    return { config, listTargets, exec, loadContext };
}
