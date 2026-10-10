/**
 * Remote execution over Azure Relay (examples/remote-relay): listing, key
 * handling and privy invocation, with `az` and `privy` replaced by a fake.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createRelayProvider, relayConfigFromEnv, shQuote, truncateMiddle } from "../../examples/remote-relay/relay.mjs";
import { createRemoteTools } from "../../examples/remote-relay/tools.mjs";

const ENV = { PS_RELAY_SUBSCRIPTION: "sub-1", PS_RELAY_RESOURCE_GROUP: "rg", PS_RELAY_NAMESPACE: "ns" };
const KEY = "a2V5LWZvci10ZXN0cy1vbmx5LTAxMjM0NTY3ODkwMTI=";

function fakeRun({ listeners = { "box-1": 1, "box-2": 0 }, privy } = {}) {
    const calls = [];
    const run = async (file, args, options) => {
        calls.push({ file, args, env: options?.env });
        if (file === "az" && args[2] === "list") {
            return { code: 0, stderr: "", stdout: JSON.stringify(Object.entries(listeners).map(([name, listenerCount]) => ({ name, listenerCount }))) };
        }
        if (file === "az" && args[2] === "authorization-rule") {
            return { code: 0, stderr: "", stdout: `${KEY}\r\n` };
        }
        if (file === "privy") return privy ? privy(args, options) : { code: 0, stderr: "", stdout: JSON.stringify({ exit_code: 0, stdout: "ok\n", stderr: "", timed_out: false, error: null }) };
        throw new Error(`unexpected ${file}`);
    };
    return { run, calls };
}

const provider = (opts) => {
    const fake = fakeRun(opts);
    return { ...fake, provider: createRelayProvider({ config: relayConfigFromEnv(ENV), run: fake.run, env: { PATH: "/bin" } }) };
};

test("config requires the relay namespace settings", () => {
    assert.throws(() => relayConfigFromEnv({}), /PS_RELAY_SUBSCRIPTION, PS_RELAY_RESOURCE_GROUP, PS_RELAY_NAMESPACE/);
    assert.equal(relayConfigFromEnv(ENV).repoRoot, "/__w/1/s");
});

test("listTargets marks connections with listeners available and sorts them first", async () => {
    const { provider: p } = provider({ listeners: { "b-box": 0, "a-box": 0, "z-box": 2 } });
    const targets = await p.listTargets();
    assert.deepEqual(targets.map((t) => [t.id, t.available, t.listenerCount]), [["z-box", true, 2], ["a-box", false, 0], ["b-box", false, 0]]);
});

test("exec passes the CR-stripped key to privy through the environment only", async () => {
    const { provider: p, calls } = provider();
    const result = await p.exec("box-1", "echo hi", { timeoutS: 30 });
    assert.deepEqual([result.exitCode, result.stdout, result.timedOut], [0, "ok\n", false]);
    const privyCall = calls.find((c) => c.file === "privy");
    assert.equal(privyCall.env.PRIVY_RELAY_KEY, KEY);
    assert.equal(privyCall.env.PRIVY_RELAY_PATH, "box-1");
    assert.equal(privyCall.env.PRIVY_RELAY_NAMESPACE, "ns");
    assert.ok(!privyCall.args.join(" ").includes(KEY), "the key must not appear in argv");
    assert.deepEqual(privyCall.args.slice(0, 5), ["client", "--json", "--timeout-s", "30", "--bash"]);
    assert.equal(privyCall.args[5], "echo hi");
});

test("exec refuses a target with no listener or an unknown/unsafe name, and caches the key", async () => {
    const { provider: p, calls } = provider();
    await assert.rejects(p.exec("box-2", "true"), /no listener/);
    await assert.rejects(p.exec("nope", "true"), /unknown remote target/);
    await assert.rejects(p.exec("box-1; rm -rf /", "true"), /invalid remote target name/);
    await p.exec("box-1", "true");
    await p.exec("box-1", "true");
    assert.equal(calls.filter((c) => c.args[2] === "authorization-rule").length, 1);
});

test("exec reports a non-zero exit and redacts the key from output", async () => {
    const { provider: p } = provider({
        privy: () => ({ code: 0, stderr: "", stdout: JSON.stringify({ exit_code: 3, stdout: "", stderr: `bad ${KEY}\n`, timed_out: false, error: null }) }),
    });
    const result = await p.exec("box-1", "false");
    assert.equal(result.exitCode, 3);
    assert.ok(!result.stderr.includes(KEY));
    assert.match(result.stderr, /\[redacted\]/);
});

test("exec reports a privy failure that prints no result", async () => {
    const { provider: p } = provider({ privy: () => ({ code: 1, stdout: "", stderr: `relay request failed ${KEY}` }) });
    const result = await p.exec("box-1", "true");
    assert.equal(result.exitCode, null);
    assert.equal(result.error, "privy did not return a result");
    assert.ok(!result.stderr.includes(KEY));
});

test("loadContext reads the repo instruction files from the repo root", async () => {
    let script = "";
    const { provider: p } = provider({
        privy: (args) => { script = args[args.length - 1]; return { code: 0, stderr: "", stdout: JSON.stringify({ exit_code: 0, stdout: "===== AGENTS.md =====\nhello", stderr: "", timed_out: false, error: null }) }; },
    });
    const context = await p.loadContext("box-1");
    assert.match(script, /cd '\/__w\/1\/s'/);
    assert.match(script, /\.github\/copilot-instructions\.md/);
    assert.match(context.text, /AGENTS\.md/);
});

test("tools expose list, load-context and bash and call the provider", async () => {
    const { provider: p } = provider();
    const tools = createRemoteTools({ provider: p });
    assert.deepEqual(tools.map((t) => t.name), ["remote_list_targets", "remote_load_context", "remote_bash"]);
    const bash = tools.find((t) => t.name === "remote_bash");
    assert.match(bash.description, /\/__w\/1\/s/);
    assert.equal(JSON.parse(await bash.handler({ target: "box-1", command: "true" })).exitCode, 0);
    const list = JSON.parse(await tools[0].handler({}));
    assert.equal(list[0].id, "box-1");
});

test("shQuote and truncateMiddle", () => {
    assert.equal(shQuote("it's"), `'it'\\''s'`);
    const out = truncateMiddle("x".repeat(100), 20);
    assert.ok(out.includes("omitted") && out.startsWith("x".repeat(10)) && out.endsWith("x".repeat(10)));
});
