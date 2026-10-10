/**
 * Agent tools for remote execution. Each call names the relay connection
 * (`target`) the session was started on; the provider checks the connection
 * has a listener before it runs anything.
 *
 *   remote_list_targets()                  the connections and whether each has a listener
 *   remote_load_context({ target })        the remote repo's copilot instructions, AGENTS.md and skills
 *   remote_bash({ target, command, ... })  run a bash command on the remote machine
 */
const json = (value) => JSON.stringify(value, null, 2);

export function createRemoteTools({ provider }) {
    return [
        {
            name: "remote_list_targets",
            description: "List the remote execution targets (relay connections) and whether each has a listener right now.",
            parameters: { type: "object", properties: {} },
            handler: async () => json(await provider.listTargets({ fresh: true })),
        },
        {
            name: "remote_load_context",
            description: "Read the remote repo's .github/copilot-instructions.md, AGENTS.md, instruction files and skill headers from "
                + "the remote checkout. Call it once at the start of a remote session and follow what it says.",
            parameters: {
                type: "object",
                properties: { target: { type: "string", description: "The remote target this session works on" } },
                required: ["target"],
            },
            handler: async (args) => json(await provider.loadContext(args.target)),
        },
        {
            name: "remote_bash",
            description: "Run a bash command on the remote machine (privy over Azure Relay). The repo checkout is at "
                + `${provider.config.repoRoot}: start commands with cd to it. Returns exit code, stdout and stderr. `
                + "Each call is a fresh shell, so cd and exports do not carry over. Long commands are fine; set timeoutSeconds.",
            parameters: {
                type: "object",
                properties: {
                    target: { type: "string", description: "The remote target this session works on" },
                    command: { type: "string", description: "Bash code to run remotely" },
                    timeoutSeconds: { type: "number", description: "Timeout in seconds (default 600, max 3600)" },
                },
                required: ["target", "command"],
            },
            handler: async (args) => json(await provider.exec(args.target, args.command, { timeoutS: args.timeoutSeconds })),
        },
    ];
}
