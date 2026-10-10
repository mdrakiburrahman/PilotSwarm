# Contributing

## How to use, on a Linux machine

1. Get a fresh new WSL machine up:

   ```powershell
   $GIT_ROOT = git rev-parse --show-toplevel
   & "$GIT_ROOT\dev\bootstrap-dev-env.ps1"
   ```

   Run PowerShell 7 as Administrator. This deletes all WSL distributions and
   Docker Desktop data and recreates the selected `<drive>:\VHD\PilotSwarm`
   directory; back up first.

1. Clone the repo, and open VSCode in it:

   ```bash
   sudo mkdir -p /workspaces && sudo chmod 777 /workspaces && cd /workspaces

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

   The bootstrapper adds you to the `docker` group, which only applies to new
   login sessions. If `docker container ls` says `permission denied`, run
   `newgrp docker` in the current shell, or restart WSL with `wsl --shutdown`
   from Windows and reopen it. Do not `chmod 666 /var/run/docker.sock`.

1. Launch devcontainer:

   ```bash
   cd /workspaces/PilotSwarm
   HEX=$(printf '%s' "$(wslpath -w .)" | xxd -ps -c 256)
   code --folder-uri "vscode-remote://dev-container+${HEX}/workspaces/PilotSwarm"
   ```

   Or run the same environment headlessly:

   ```bash
   npx --no-install nx run devcontainer:build
   npx --no-install nx run devcontainer:up
   npx --no-install nx run devcontainer:test
   npx --no-install nx run devcontainer:down
   ```

1. Install GitHub tooling:

   ```bash
   curl -fsSL https://gh.io/copilot-install | bash
   $HOME/.local/bin/copilot --yolo
   ```

1. Install `gh` CLI:

   ```bash
   if ! command -v gh >/dev/null 2>&1; then
   (type -p wget >/dev/null || (sudo apt update && sudo apt install wget -y)) \
	&& sudo mkdir -p -m 755 /etc/apt/keyrings \
	&& out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
	&& sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& sudo mkdir -p -m 755 /etc/apt/sources.list.d \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
	&& sudo apt update \
	&& sudo apt install gh -y
   fi

   gh auth login
   ```

1. With an authenticated GitHub CLI session, build and test inside the devcontainer:

```bash
npx nx run-many -t build --all
npx nx run-many -t verify --all
npx nx run app:test-e2e
npx nx run repo:test-local
```

1. Run the full UI stack (PostgreSQL plus the web portal with two workers) from
   `compose.ui.yml`. It builds the portal image, uses your `gh` login for
   `GITHUB_TOKEN`, and works from the host or inside the devcontainer:

```bash
export CI=true
npx nx run local:ui-up      # build, start, wait until healthy; then open http://localhost:3002
npx nx run local:ui-logs    # follow the portal log
npx nx run local:ui-down    # stop (the database volume is kept)
```

   The portal listens on the Docker host's loopback only. From WSL, browse
   http://localhost:3002. Inside the devcontainer `localhost` is the container
   itself, so forward port 3002 in the VS Code Ports tab, or use VS Code on
   WSL. The portal's own log line says `:3001`; that is its port inside the
   container, not the host port.

   Sign in as Ada (admin), Alice, Bob, Carol or Dave. Set `PS_UI_PORT` to use a
   different host port (3001 belongs to the devcontainer portal).
