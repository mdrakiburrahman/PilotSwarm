import assert from "node:assert/strict";

async function createClients(persona, apiUrl) {
    const { ApiClient } = await import("pilotswarm-sdk/api");
    const { PilotSwarmClient } = await import("pilotswarm-sdk");
    const api = new ApiClient({
        apiUrl,
        getAccessToken: async () => `dev:${persona}`,
        fetchImpl: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(30000) }),
    });
    return { api, client: new PilotSwarmClient({ apiUrl, api }) };
}

export async function smoke({
    apiUrl = "http://127.0.0.1:3001",
    clients = createClients,
    log = console.log,
} = {}) {
    const alice = await clients("alice", apiUrl);
    const bob = await clients("bob", apiUrl);
    const sessions = [];
    try {
        assert.equal((await alice.api.getAuthConfig()).provider, "dev", "Smoke requires explicit dev authentication");
        await Promise.all([alice.api.getBootstrap(), bob.api.getBootstrap()]);
        const a = await alice.client.createSession();
        sessions.push(a);
        const b = await bob.client.createSession();
        sessions.push(b);
        await assert.rejects(
            bob.client.resumeSession(a.sessionId),
            (error) => error.status === 403 || error.status === 404,
            "Bob must not read Alice's private session",
        );
        await assert.rejects(
            alice.client.resumeSession(b.sessionId),
            (error) => error.status === 403 || error.status === 404,
            "Alice must not read Bob's private session",
        );
        const responses = await Promise.all([
            a.sendAndWait("Reply with exactly LOCAL_DEV_SMOKE_OK.", 120000),
            b.sendAndWait("Reply with exactly LOCAL_DEV_SMOKE_OK.", 120000),
        ]);
        for (const response of responses) {
            assert.ok(response?.includes("LOCAL_DEV_SMOKE_OK"), "Default model must answer the live smoke prompt");
        }
        const workspaces = await Promise.all([
            alice.api.call("listSessionWorkspaceFolders", { sessionId: a.sessionId }),
            bob.api.call("listSessionWorkspaceFolders", { sessionId: b.sessionId }),
        ]);
        for (const workspace of workspaces) {
            assert.ok(Array.isArray(workspace.folders) && workspace.folders.length > 0,
                "Local session must expose its configured workspace folders");
        }
    } finally {
        const results = await Promise.allSettled(sessions.map((session) => session.destroy()));
        for (const result of results) {
            if (result.status === "rejected") {
                log("Smoke session cleanup failed; inspect this disposable portal database");
            }
        }
        await Promise.all([alice.api.stop(), bob.api.stop()]);
        if (results.some((result) => result.status === "rejected")) {
            throw new Error("Local smoke cleanup failed");
        }
    }
    log("Local smoke passed: two dev personas, private-session isolation, workspace folders and a real Copilot turn");
}
