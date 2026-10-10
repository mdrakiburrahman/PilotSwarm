# Headless development: Windows → WSL → devcontainer

The editor and terminal use the same source-built Ubuntu 24.04 workspace.
Docker Engine lives in WSL; the container runs commands as `vscode` and reaches
that daemon through its socket. No Azure CLI, tenant or subscription is needed.
There is no published devcontainer image.

## Reset the Windows host

Start with [CONTRIBUTING.md](../../CONTRIBUTING.md). Back up WSL data outside
WSL before running the reset. From elevated PowerShell 7:

```powershell
$GIT_ROOT = git rev-parse --show-toplevel
& "$GIT_ROOT\dev\bootstrap-dev-env.ps1"
```

Choose a drive from the same numbered picker as the reference workflow. The
destination is `<drive>:\VHD\PilotSwarm` and is deleted and recreated after WSL
distributions are unregistered. Automatic deletion is restricted to that dedicated
path and rejects junctions/symlinks. The script inventories
the actual host and checks prerequisites before deleting **all WSL distributions
and Docker Desktop data**, without a typed reset confirmation. It also changes Defender exclusions,
backs up/replaces global `.wslconfig`, and installs Ubuntu-24.04. This is a
fresh-machine operation, not a normal update command.

For headless execution, supply the path instead of using the drive picker:

```powershell
.\dev\bootstrap-dev-env.ps1 -VhdPath C:\VHD\PilotSwarm
```

`-DryRun` prints the plan without inventory or changes. OS elevation, reboot
requirements and first-launch Linux user setup cannot be bypassed by Nx.
Use `-VhdPath <path> -PreflightOnly` for read-only host inspection.

## Clone and bootstrap WSL

Finish Ubuntu's first-launch user setup. Then, as that normal user:

```bash
sudo install -d -m 0775 -o "$USER" -g "$USER" /workspaces
cd /workspaces
read -rp "Enter your name (for example, FirstName LastName): " user_name
read -rp "Enter your email: " user_email
read -rp "Enter your fork URL: " git_fork_url
git config --global user.name "$user_name"
git config --global user.email "$user_email"
git clone "$git_fork_url" PilotSwarm
cd PilotSwarm
GIT_ROOT=$(git rev-parse --show-toplevel)
chmod +x "$GIT_ROOT/dev/bootstrap-dev-env.sh"
"$GIT_ROOT/dev/bootstrap-dev-env.sh"
npm ci
```

The Linux bootstrap preserves existing Docker containers, volumes and daemon
configuration. It installs native Node 24, Git 2.46+, Docker Engine,
Compose/Buildx, GitHub CLI and shell prerequisites. Reopen the WSL terminal
after Docker group changes. If systemd needs enabling, restart WSL as instructed
and rerun the bootstrap. Docker group membership is root-equivalent access;
the socket is not made world-writable.

Do not clone under `/mnt/c`. For an unpublished local branch on this same host,
clone the Windows checkout with `git clone --no-hardlinks`, then apply its
binary diff and explicit new-file archive. Record the base SHA and patch hash;
do not include ignored configuration, dependencies or browser profiles.
Published branch validation should instead clone the remote and select its
exact SHA. Neither approach requires copying private environment files.

## Build, start and enter

From the WSL checkout:

```bash
npx nx run devcontainer:build
npx nx run devcontainer:up
npx nx run devcontainer:doctor
npx --no-install devcontainer exec --workspace-folder . --config .devcontainer/devcontainer.json bash
```

These use the pinned Dev Containers CLI. The shared initialization hook builds
the local image from `.devcontainer/devcontainer.build.json`; both VS Code and
headless entry use `.devcontainer/devcontainer.json` to start that image.
Post-create installs repository dependencies. Root and
nested workspace `node_modules` are separate container volumes, so host
`npm ci` cannot replace Linux platform dependencies.
The additional `devcontainer:exec -- <command>` target dispatches to that same
CLI/config; it is optional, not a different entry workflow. `devcontainer:test`
starts the workspace and runs script contracts before container verification,
matching the reference target ordering.

Dispatch the same flow from Windows:

```powershell
wsl.exe -d Ubuntu-24.04 --cd /workspaces/PilotSwarm -- bash -lc `
  "npm ci && npx nx run devcontainer:up && npx nx run devcontainer:doctor"
```

Keep a WSL terminal or the Remote Containers editor open while using the
workspace. For headless runs spanning multiple Windows commands, keep this
command running in a separate PowerShell window:

```powershell
wsl.exe -d Ubuntu-24.04 --exec sleep infinity
```

Stop it with `Ctrl+C` after teardown. WSL can shut down when its last client
exits; the systemd Docker daemon does not keep the distribution alive.

## Authenticate without copying credentials

The WSL user's GitHub CLI config directory is mounted into the workspace.
Login/logout changes are shared with that WSL user, not copied into Git.
Windows browser-assisted login targets that WSL installation:

```powershell
node tools\auth-automation\src\cli.mjs browser-install
node tools\auth-automation\src\cli.mjs login --wsl Ubuntu-24.04
node tools\auth-automation\src\cli.mjs status --wsl Ubuntu-24.04
```

The equivalent pinned Nx targets are `auth-automation:browser-install`,
`auth-automation:login -- --wsl Ubuntu-24.04`, and
`auth-automation:status -- --wsl Ubuntu-24.04`.
Windows needs Node 24 and `npm ci` in its checkout to run these browser tools;
that install is not a native Windows application build.

The tool uses a dedicated PilotSwarm Edge profile, outside the repository.
It may enter the emitted short-lived device code and click allowlisted GitHub
authorization controls. It does not automate usernames, passwords, MFA,
passkeys or identity challenges. On those pages, complete authentication
manually with `gh auth login` and retry status. A fresh dedicated profile may
require that manual step; existing normal-browser cookies are never borrowed.

Alternatively, inside the devcontainer:

```bash
gh auth login --hostname github.com --web
npx nx run auth-automation:status -- --current
```

GitHub CLI authentication is not proof of Copilot entitlement. The local
integration tests and portal smoke must separately confirm real model access.
Token material is resolved in memory for child processes, not written to the
generated config or logged.

## Verify the whole local environment

From WSL, run credential-free checks inside the exact workspace:

```bash
npx nx run devcontainer:test
npx nx run devcontainer:exec -- node node_modules/nx/dist/bin/nx.js run app:test-e2e --skip-nx-cache
```

Inside the container, run the complete stock PostgreSQL gate:

```bash
npx nx run repo:test-local
npx nx run local:up
npx nx run local:smoke
npx nx run local:restart
```

The ignored `.devcontainer/.state/test.env` selects `test-db`; `portal.env`
selects `portal-db`. Each has its own data volume and 1500-connection capacity.
The portal listens through a WSL-host loopback mapping at
`http://localhost:3001`, reachable from Windows. Test two dev personas when
checking ownership or per-user workspace behavior.

`repo:test-local` reuses `scripts/run-tests.sh` with eight concurrent test files.
It does not silently substitute mocks, retry cases, or reduce concurrency.
The Docker environment supplies stock PostgreSQL, not HorizonDB; real
HorizonDB release qualification remains a separate protected CI gate.
Missing Copilot/model access is a blocked live gate, not a successful test.

## Nx target inventory

| Project | Targets | Execution layer |
| --- | --- | --- |
| sdk | build, typecheck, test-unit, verify | Container; existing native checks remain supported |
| app | build, test-unit, test-e2e, verify | Container |
| horizon-store | build, test-unit, verify | Container; no live HorizonDB claims |
| repo | test-scripts, check-privacy, verify | Container |
| repo | test-local | Container with Copilot credentials |
| devcontainer | build, up, exec, doctor, test, down | WSL host |
| devcontainer | scripts-test, verify | Host or container |
| local | up, restart, smoke, down, logs | Container |
| auth-automation | login, status, browser-install | Explicit target/browser host |
| auth-automation | typecheck, test, verify | Host or container |

`npx nx run-many -t verify --all` is credential-free and never launches
interactive auth or recursively starts containers. Tests/lifecycle/auth targets
are uncached. Use `--skip-nx-cache` for an evidence run.

## Monitor and stop

Inside the container:

```bash
npx nx run local:logs
npx nx run local:down
```

From WSL:

```bash
npx nx run devcontainer:down
npx nx run devcontainer:down -- --volumes
```

The second command additionally removes only this checkout's database,
dependency and workspace volumes. Neither command logs out the mounted gh
profile or performs global Docker pruning.

For unattended work, use `tmux` in WSL and save redacted logs outside Git:

```bash
tmux new-session -s pilotswarm-dev
npx nx run devcontainer:test
```

Detach with `Ctrl-b d`; return with `tmux attach-session -t pilotswarm-dev`.
For Windows-driven headless runs, keep the explicit WSL client above open too.

## Evidence and CI boundaries

Record the exact source SHA (and unpublished patch hash), execution layer,
target, exit code and sanitized output. Exercise build/up/exec/doctor,
verification, browser E2E, full local integration, portal startup/restart,
and scoped down/up/volume cleanup. Test ordinary host bootstrap twice and
check that unrelated sentinel Docker resources survive normal cleanup.

PR checks run source-container/Nx checks on hosted Linux without credentials.
They preserve native Windows/Linux checks and do not prove the Windows/WSL
leg or live login/model coverage. A fresh-host regression must actually run
from Windows through WSL to the container; report any missing leg explicitly.
