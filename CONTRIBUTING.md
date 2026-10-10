# Contributing

## How to use, on a Linux machine

1. Get a fresh new WSL machine up:

   ```powershell
   $GIT_ROOT = git rev-parse --show-toplevel
   & "$GIT_ROOT\dev\bootstrap-dev-env.ps1"
   ```

   Run PowerShell 7 as Administrator. This deletes all WSL distributions and
   Docker Desktop data and recreates the selected `<drive>:\VHD\PilotSwarm`
   directory; back up first. Skip this step for an existing WSL machine.

1. Clone the repo:

   ```bash
   sudo install -d -m 0775 -o "$USER" -g "$USER" /workspaces
   cd /workspaces

   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   git clone https://github.com/mdrakiburrahman/PilotSwarm.git

   cd PilotSwarm/
   git checkout dev/mdrrahman/explore
   ```

1. Run the bootstrapper script, that installs all tools idempotently:

   ```bash
   GIT_ROOT=$(git rev-parse --show-toplevel)
   chmod +x ${GIT_ROOT}/dev/bootstrap-dev-env.sh && ${GIT_ROOT}/dev/bootstrap-dev-env.sh
   ```

   It installs native Node 24/npm, Git, GitHub CLI, Docker Engine and Compose,
   build prerequisites, and repository-pinned Nx tooling with `npm ci`.
   Existing Docker data is preserved. If Docker group membership changed,
   reopen WSL or run `newgrp docker`; do not make the socket world-writable.

1. Authenticate GitHub CLI:

   ```bash
   gh auth login
   ```

   Live agents need a GitHub account with Copilot access.

1. Run the full UI stack (PostgreSQL plus the web portal with two workers)
   using `compose.ui.yml`, from the WSL checkout:

```bash
export CI=true
npx nx run local:ui-up      # build, start, wait until healthy; then open http://localhost:3002
npx nx run local:ui-logs    # follow the portal log
npx nx run local:ui-down    # stop (the database volume is kept)
```
