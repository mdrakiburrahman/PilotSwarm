# Contributing

If you use Windows, use it only to enter WSL. All development happens on
Linux inside the repository's VS Code devcontainer. CI uses the same
source-built environment. No Azure account or Docker Desktop is required.

## Enter the devcontainer

After completing the one-time setup below, run these commands from WSL:

```bash
cd /workspaces/PilotSwarm
npm ci
npx nx run devcontainer:up
WORKSPACE_HEX=$(printf '%s' "$(wslpath -w .)" | od -An -tx1 | tr -d '[:space:]')
code --folder-uri "vscode-remote://dev-container+${WORKSPACE_HEX}/workspaces/PilotSwarm"
```

To enter the same container from a terminal without VS Code:

```bash
npx --no-install devcontainer exec \
  --workspace-folder . \
  --config .devcontainer/devcontainer.json \
  bash
```

## First-time setup

1. Install VS Code and its WSL and Dev Containers extensions from PowerShell:

   ```powershell
   winget install -e --id Microsoft.VisualStudioCode
   code --install-extension ms-vscode-remote.remote-wsl
   code --install-extension ms-vscode-remote.remote-containers
   ```

2. Run the Windows bootstrap from PowerShell 7 **as Administrator**:

   ```powershell
   $GIT_ROOT = git rev-parse --show-toplevel
   & "$GIT_ROOT\dev\bootstrap-dev-env.ps1"
   ```

   **This resets the developer machine:** it removes existing WSL
   distributions and Docker Desktop, configures WSL/Defender, and installs
   Ubuntu 24.04. Choose a drive when prompted; there is no reset confirmation.
   Back up WSL data first. Do not run it to update an existing checkout.

3. Enter Ubuntu 24.04, clone your fork into the WSL filesystem, and configure
   your Git identity:

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
   ```

   Do not put the development checkout under `/mnt/c`.
   To reuse Git for Windows credentials from WSL:

   ```bash
   git config --global credential.helper \
     '/mnt/c/"Program Files"/Git/mingw64/bin/git-credential-manager.exe'
   ```

4. Run the idempotent Linux host bootstrap:

   ```bash
   GIT_ROOT=$(git rev-parse --show-toplevel)
   chmod +x "$GIT_ROOT/dev/bootstrap-dev-env.sh"
   "$GIT_ROOT/dev/bootstrap-dev-env.sh"
   ```

   It installs native Docker, Node.js, Git and GitHub CLI. Reopen the WSL
   terminal after Docker group changes. Existing Docker data is preserved.

5. Start and enter the devcontainer:

   ```bash
   npm ci
   npx nx run devcontainer:up
   WORKSPACE_HEX=$(printf '%s' "$(wslpath -w .)" | od -An -tx1 | tr -d '[:space:]')
   code --folder-uri "vscode-remote://dev-container+${WORKSPACE_HEX}/workspaces/PilotSwarm"
   ```

   Host `npm ci` installs the pinned Nx and Dev Containers CLI. Container
   dependencies are installed by its post-create command. GitHub CLI
   credentials are shared with WSL through `~/.config/gh`, never copied into Git.

6. Authenticate inside the devcontainer when needed:

   ```bash
   gh auth login
   ```

## Build and test

Inside the container:

```bash
npx nx run-many -t build --all
npx nx run-many -t verify --all
npx nx run app:test-e2e
```

For live Copilot tests, authenticate first, then run the complete
stock PostgreSQL suite:

```bash
gh auth login --hostname github.com --web
npx nx run repo:test-local
```

GitHub login alone does not grant Copilot entitlement or model access.
HorizonDB coverage requires a real external service and is not part of this
local Docker environment. Tests keep their existing parallelism and assertions.

## Run the platform

Inside the container, with a Copilot-enabled GitHub login:

```bash
npx nx run local:up
npx nx run local:smoke
```

Open `http://localhost:3001` on Windows. Sign in as one of the local dev
personas. The portal and test suite use **different PostgreSQL databases**.
After a code change, run `npx nx run local:restart`.

## Stop

Inside the container:

```bash
npx nx run local:down
```

Then, from the WSL checkout:

```bash
npx nx run devcontainer:down
```

Add `-- --volumes` only to delete this workspace's local database and dependency
volumes. Normal cleanup never prunes unrelated Docker resources.

For Windows browser-assisted GitHub login, unattended operation and the
complete target inventory, see [Headless operations](docs/devcontainer/headless-operations.md).
For contribution rules and the repository map, see
[Working on PilotSwarm](docs/developer/contributing/working-on-pilotswarm.md).
Durable orchestration changes require
[replay-safe versioning](docs/architecture/orchestration/design.md).
Keep the [privacy check](.github/REPOSITORY-PRIVACY.md) green before committing,
and retain the complete [MIT license](LICENSE) when distributing packages.
