import assert from "node:assert/strict";
import test from "node:test";
import { smoke } from "../scripts/smoke.mjs";

function fixture({ leak = false, failTurn = false, failCleanup = false } = {}) {
    const destroyed = [];
    const turned = new Set();
    const clients = async (persona) => ({
        api: {
            getAuthConfig: async () => ({ provider: "dev" }),
            getBootstrap: async () => ({}),
            call: async () => {
                assert.ok(turned.has(persona), "Workspace defaults are established by the first turn");
                return { folders: [{ name: "home" }] };
            },
            async stop() {},
        },
        client: {
            createSession: async () => ({
                sessionId: persona,
                sendAndWait: async () => {
                    if (failTurn) throw new Error("Live turn failed");
                    turned.add(persona);
                    return "LOCAL_DEV_SMOKE_OK";
                },
                destroy: async () => {
                    destroyed.push(persona);
                    if (failCleanup) throw new Error("Cleanup failed");
                },
            }),
            resumeSession: async () => {
                if (leak) return {};
                throw Object.assign(new Error("Forbidden"), { status: 403 });
            },
        },
    });
    return { clients, destroyed, log() {} };
}

test("local smoke exercises both personas and cleans up its own sessions", async () => {
    const state = fixture();
    await smoke(state);
    assert.deepEqual(state.destroyed, ["alice", "bob"]);
});

test("local smoke fails loudly on an ownership leak or failed live model turn", async () => {
    for (const options of [{ leak: true }, { failTurn: true }]) {
        const state = fixture(options);
        await assert.rejects(smoke(state));
        assert.deepEqual(state.destroyed, ["alice", "bob"]);
    }
});

test("local smoke never reports success if cleanup fails", async () => {
    await assert.rejects(smoke(fixture({ failCleanup: true })), /cleanup failed/);
});
