# Contributing

On Windows, use PowerShell to enter WSL. Build and test inside the
Ubuntu 24.04 devcontainer. No Azure account or Docker Desktop is required.

## First-time setup

1. From PowerShell 7 **as Administrator**, run the Windows bootstrap:

   ```powershell
   Set-Location C:\git\PilotSwarm
   .\dev\bootstrap-dev-env.ps1 -VhdPath C:\VHD\PilotSwarm -FullReset
   ```

   **This resets the developer machine:** it removes existing WSL
   distributions and Docker Desktop, configures WSL/Defender, and installs
   Ubuntu 24.04. Read the inventory and confirmation before continuing.
   Do not run it to update an existing checkout.
   Choose an empty VHD directory on a drive with sufficient free space.

2. In Ubuntu 24.04, clone into the Linux filesystem and bootstrap the host:

   ```bash
   sudo install -d -m 0775 -o "$USER" -g "$USER" /workspaces
   cd /workspaces
   git clone <your-fork-url> PilotSwarm
   cd PilotSwarm
   git switch <your-branch>
   bash dev/bootstrap-dev-env.sh
   ```

   Reopen the WSL terminal if the bootstrap added you to the Docker group.
   Do not put the development checkout under `/mnt/c`.

3. Install host tooling and start the source-built workspace:

   ```bash
   npm ci
   npx nx run devcontainer:up
   WORKSPACE_HEX=$(printf '%s' "$(wslpath -w .)" | od -An -tx1 | tr -d '[:space:]')
   code --folder-uri "vscode-remote://dev-container+${WORKSPACE_HEX}/workspaces/PilotSwarm"
   ```

   Terminal-only entry:

   ```bash
   npx nx run devcontainer:exec -- bash
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
