/**
 * Remote execution over Azure Relay: the optional provider module.
 *
 * Workers load it as an extension module (it registers the remote tools):
 *   PILOTSWARM_EXTENSION_MODULES=/app/packages/sdk/examples/remote-relay/index.mjs
 *
 * The portal loads it through `createProvider` to list the connections:
 *   PS_REMOTE_EXECUTION_MODULE=/app/packages/sdk/examples/remote-relay/index.mjs
 *
 * Settings and the privy/az requirements are in relay.mjs.
 */
import { createRelayProvider, relayConfigFromEnv } from "./relay.mjs";
import { createRemoteTools } from "./tools.mjs";

/** The provider contract the portal consumes: { listTargets(), exec(), loadContext() }. */
export function createProvider(env = process.env, options = {}) {
    return createRelayProvider({ config: relayConfigFromEnv(env), env, ...options });
}

export async function register(worker, context = {}) {
    const env = context.env ?? process.env;
    let provider;
    try {
        provider = createProvider(env);
    } catch (error) {
        // An unconfigured stack still starts; the remote tools just are not offered.
        context.log?.(`remote execution disabled: ${error.message}`);
        return;
    }
    worker.registerTools(createRemoteTools({ provider }));
    context.log?.(`remote execution: relay ${provider.config.namespace}, repo root ${provider.config.repoRoot}`);
}
