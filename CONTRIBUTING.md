# Contributing

## How to use, on a Linux machine

1. Get a fresh new WSL machine up, from PowerShell 7 **as Administrator**:

   ```powershell
   $GIT_ROOT = git rev-parse --show-toplevel
   & "$GIT_ROOT\dev\bootstrap-dev-env.ps1"
   ```

   Choose the VHD drive when prompted. **This deletes all existing WSL
   distributions and Docker Desktop data without a reset confirmation.**
   Back up WSL data first; do not use this to update an existing checkout.

1. Clone the repo, and open VS Code in it:

   ```bash
   sudo install -d -m 0775 -o "$USER" -g "$USER" /workspaces
   cd /workspaces

   read -rp "Enter your name: " user_name
   read -rp "Enter your email: " user_email
   read -rp "Enter your fork URL: " git_fork_url
   git config --global user.name "$user_name"
   git config --global user.email "$user_email"
   git clone "$git_fork_url" PilotSwarm

   cd PilotSwarm
   code .
   ```

   Use the WSL filesystem, not `/mnt/c`. To reuse Git for Windows credentials:

   ```bash
   git config --global credential.helper \
     '/mnt/c/"Program Files"/Git/mingw64/bin/git-credential-manager.exe'
   ```

1. Run the bootstrapper script, which installs all host tools idempotently:

   ```bash
   GIT_ROOT=$(git rev-parse --show-toplevel)
   chmod +x "$GIT_ROOT/dev/bootstrap-dev-env.sh" && "$GIT_ROOT/dev/bootstrap-dev-env.sh"
   npm ci
   ```

   It installs Docker, Node.js, Git and `gh`; `npm ci` installs the pinned Nx
   and Dev Containers CLI. Reopen WSL after Docker group changes. Existing
   Docker data is preserved.

1. Launch devcontainer:

   ```bash
   cd /workspaces/PilotSwarm
   npx --no-install nx run devcontainer:up
   HEX=$(printf '%s' "$(wslpath -w .)" | od -An -tx1 | tr -d '[:space:]')
   code --folder-uri "vscode-remote://dev-container+${HEX}/workspaces/PilotSwarm"
   ```

   Or run the same environment headlessly, from the WSL checkout:

   ```bash
   npx --no-install nx run devcontainer:build
   npx --no-install nx run devcontainer:up
   npx --no-install nx run devcontainer:test
   npx --no-install nx run devcontainer:down
   ```

   To enter it without VS Code:

   ```bash
   npx --no-install devcontainer exec \
     --workspace-folder . \
     --config .devcontainer/devcontainer.json \
     bash
   ```

1. Authenticate GitHub tooling inside the devcontainer:

   ```bash
   gh auth login
   ```

   `gh` is already installed. Credentials are shared with WSL through
   `~/.config/gh`, never copied into Git. Live tests require Copilot entitlement
   and model access in addition to GitHub login.

1. Build and test inside the devcontainer:

   ```bash
   npx nx run-many -t build --all
   npx nx run-many -t verify --all
   npx nx run app:test-e2e
   npx nx run repo:test-local
   ```

   The last command runs the complete stock PostgreSQL integration suite.
   No Azure account is required; live HorizonDB coverage is separate.

1. Run the local platform inside the devcontainer:

   ```bash
   npx nx run local:up
   npx nx run local:smoke
   ```

   Open `http://localhost:3001` on Windows and choose a dev persona.
   After code changes, run `npx nx run local:restart`. Stop the platform with
   `npx nx run local:down`, then run `npx nx run devcontainer:down` from WSL.
   Add `-- --volumes` only to delete this workspace's volumes; cleanup never
   prunes unrelated Docker resources.

For terminal-only operation and diagnostics, see
[Headless operations](docs/devcontainer/headless-operations.md).
For contribution rules, see
[Working on PilotSwarm](docs/developer/contributing/working-on-pilotswarm.md).
