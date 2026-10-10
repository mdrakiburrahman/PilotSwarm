# Remote Execution (Azure Relay + privy)

Remote Execution lets the PilotSwarm UI run an agent's shell work on another machine, such as a CI
devcontainer that already has the repository checked out. It is an optional provider, kept out of
core: `packages/sdk/examples/remote-relay/`.

## How it works

1. The remote machine runs `privy server`, which listens on an Azure Relay hybrid connection.
2. PilotSwarm lists the namespace's hybrid connections with `az relay hyco list`. A connection with
   `listenerCount > 0` has a live listener and is shown green (`●`); others are grey (`○`).
3. Choosing a green target starts a **Remote Operator** chat. Its tools are `remote_list_targets`,
   `remote_load_context` and `remote_bash`; `remote_bash` runs
   `privy client --bash "<command>"` against that target.
4. At the start of the chat the agent calls `remote_load_context`, which reads the remote repo's
   `.github/copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, instruction files and skill headers.

"In Spark Orchestrator, build the JAR" becomes
`cd /__w/1/s && npx nx run spark-orchestrator:build-jar --verbose`.

## Configure

| Variable | Meaning |
|---|---|
| `PS_RELAY_SUBSCRIPTION`, `PS_RELAY_RESOURCE_GROUP`, `PS_RELAY_NAMESPACE` | The relay namespace |
| `PS_RELAY_KEYRULE` | Authorization rule used for `privy` (default `all`; prefer a Send-only rule) |
| `PS_REMOTE_REPO_ROOT` | Remote checkout (default `/__w/1/s`) |
| `PS_REMOTE_EXECUTION_MODULE` | Provider module the portal/TUI imports; enables the feature |
| `PS_REMOTE_EXECUTION_START` | Open the target picker on start |
| `PILOTSWARM_EXTENSION_MODULES` | Must include the same module so workers register the tools |
| `PLUGIN_DIRS` | Must include `packages/sdk/examples/remote-relay/plugin` |

Docker: `compose.ui.yml` builds the portal image with `REMOTE_EXECUTION=true` (Azure CLI plus `privy`,
checked against the pinned `PRIVY_SHA256`; bump it deliberately) and reads the relay with an ARM token from your host `az`: run `scripts/relay-token.sh --loop` (refreshes every 30 minutes) before `local:ui-up`. The container needs no login. `PS_RELAY_ARM_TOKEN_FILE` selects this path; without it the provider shells out to `az`.
`compose.ui.yml` defaults to the relay and `privy` download used by the monitoring devcontainer; override with `PS_RELAY_SUBSCRIPTION`, `PS_RELAY_RESOURCE_GROUP`, `PS_RELAY_NAMESPACE`, `PS_PRIVY_URL` and `PS_PRIVY_SHA256`. Note: these defaults are live identifiers, so `npm run check:privacy` reports them until they are allow-listed.

Without Docker: `PS_LOCAL_REMOTE_EXEC=on scripts/local-pilotswarm.sh up` (needs `az` signed in and `privy` on PATH).

## Using it

- Portal: the ⇄ button in the Sessions toolbar. TUI: `Shift+X`.
- Unavailable targets cannot be started.

## Security

- The relay key grants a remote shell. It is fetched with `az` per use, cached in memory for five
  minutes, passed to `privy` only through the child process environment, and redacted from output.
  Use a Send-only authorization rule for PilotSwarm instead of `all`.
- The ARM token file is short-lived and readable by the container: local development only.
- Only the session owner (and admins) can drive a session's tools.
- The agent is told to confirm destructive commands before running them.
