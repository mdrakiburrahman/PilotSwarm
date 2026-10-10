#!/usr/bin/env bash
# Ubuntu 24.04 native host setup. Reruns preserve Docker containers, volumes and config.
set -Eeuo pipefail
trap 'printf "Bootstrap failed at line %s (exit %s).\n" "$LINENO" "$?" >&2' ERR

# Use Linux tooling rather than Windows executables inherited through WSL.
export PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/[a-z]/' | paste -sd ':' -)"

usage() {
  printf '%s\n' 'Usage: bash dev/bootstrap-dev-env.sh [--dry-run | --preflight-only]' \
    'Run as your normal Ubuntu 24.04 user from a native Linux PilotSwarm checkout.' \
    'Uses sudo for package/service setup. Never resets Docker or authenticates gh.' \
    'After setup: open a new login shell for Docker group access; run npm ci.'
}
mode=install
for argument in "$@"; do
  case "$argument" in
    --dry-run|--preflight-only)
      [[ "$mode" == install ]] || { usage >&2; exit 1; }
      mode="${argument#--}"
      ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown argument: %s\n' "$argument" >&2; usage >&2; exit 1 ;;
  esac
done
if [[ "$mode" == dry-run ]]; then
  printf '%s\n' \
    'DRY RUN: no inventory, sudo, package installation, writes or service changes.' \
    'Preflight: Ubuntu 24.04; normal user; native Linux git checkout (not /mnt/*); sudo; apt; systemd/WSL.' \
    'Install: ca-certificates curl gnupg python3 software-properties-common build-essential pkg-config unzip zip jq lsof tmux openssh-client rsync git.' \
    'Git >=2.46: upgrade from ppa:git-core/ppa only if the Ubuntu package is too old.' \
    'Repositories: Docker Ubuntu noble; GitHub CLI; NodeSource node_24.x nodistro.' \
    'Install: docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin gh nodejs (Node 24).' \
    'Preserve existing /etc/docker/daemon.json; validate before systemctl enable --now docker.' \
    'If WSL systemd is disabled, merge boot.systemd=true into /etc/wsl.conf, then stop for a WSL restart.' \
    'Add current user to docker group (root-equivalent access); never chmod 666, prune or reset Docker.' \
    'Enable systemd Docker; validate Node24/npm/Git>=2.46/Docker/Compose/Buildx/gh.' \
    'Next: new login shell; npm ci; use repository-pinned Nx and Dev Containers CLI.'
  exit 0
fi

[[ -r /etc/os-release ]] || { echo 'Missing /etc/os-release.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu && "${VERSION_ID:-}" == 24.04 ]] || {
  echo 'Ubuntu 24.04 is required.' >&2; exit 1;
}
[[ "$EUID" -ne 0 ]] || { echo 'Run as a normal user with sudo, not root.' >&2; exit 1; }
for command in git sudo apt-get dpkg stat; do
  command -v "$command" >/dev/null || { printf 'Missing prerequisite: %s\n' "$command" >&2; exit 1; }
done
repo_root="$(git rev-parse --show-toplevel)"
repo_root="$(cd "$repo_root" && pwd -P)"
case "$repo_root" in /mnt/*) echo 'Clone on the native Linux filesystem, preferably /workspaces/PilotSwarm, not /mnt/*.' >&2; exit 1 ;; esac
filesystem="$(stat -f -c %T "$repo_root")"
case "$filesystem" in 9p|drvfs|fuseblk|cifs|smb*)
  printf 'Checkout filesystem %s is not supported; use native Linux storage.\n' "$filesystem" >&2; exit 1 ;;
esac
[[ -f "$repo_root/package.json" && -d "$repo_root/packages/sdk" ]] || {
  echo 'Run inside the PilotSwarm checkout.' >&2; exit 1;
}
is_wsl=false
if grep -qi microsoft /proc/sys/kernel/osrelease; then is_wsl=true; fi
if [[ "$(cat /proc/1/comm)" != systemd && "$is_wsl" != true ]]; then
  echo 'A systemd-managed host is required (not a devcontainer).' >&2; exit 1
fi
printf 'Preflight passed: Ubuntu 24.04; checkout %s; filesystem %s; WSL=%s.\n' "$repo_root" "$filesystem" "$is_wsl"
printf '%s\n' 'Requires sudo and network access to Ubuntu, Git PPA, Docker, GitHub CLI and NodeSource package repositories.'
if [[ "$mode" == preflight-only ]]; then exit 0; fi

ensure_sudo() {
  if sudo -n true 2>/dev/null; then
    return
  elif [[ -t 0 ]]; then
    sudo -v
  else
    echo 'Non-interactive bootstrap requires authenticated or passwordless sudo. Run sudo -v in an interactive shell first, then rerun bootstrap.' >&2
    return 1
  fi
}
ensure_sudo
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg python3 software-properties-common build-essential \
  pkg-config unzip zip jq lsof tmux openssh-client rsync git

if [[ "$(cat /proc/1/comm)" != systemd ]]; then
  # Preserve all other WSL settings; configparser is not used because it drops comments.
  sudo python3 - <<'PY'
from pathlib import Path
import re
path = Path("/etc/wsl.conf")
text = path.read_text() if path.exists() else ""
match = re.search(r"(?im)^\s*\[boot\]\s*$", text)
if match:
    tail = text[match.end():]
    next_section = re.search(r"(?m)^\s*\[", tail)
    end = match.end() + (next_section.start() if next_section else len(tail))
    section = text[match.end():end]
    if re.search(r"(?im)^\s*systemd\s*=", section):
        section = re.sub(r"(?im)^\s*systemd\s*=.*$", "\nsystemd=true", section)
    else:
        section = "\nsystemd=true\n" + section
    text = text[:match.end()] + section + text[end:]
else:
    text = text.rstrip() + "\n[boot]\nsystemd=true\n"
if path.exists() and not Path("/etc/wsl.conf.pilotswarm-backup").exists():
    Path("/etc/wsl.conf.pilotswarm-backup").write_bytes(path.read_bytes())
path.write_text(text)
PY
  echo 'Enabled WSL systemd. From Windows run wsl.exe --shutdown, reopen Ubuntu, and rerun bootstrap.' >&2
  exit 2
fi

git_version="$(git --version | awk '{print $3}')"
if ! dpkg --compare-versions "$git_version" ge 2.46; then
  sudo add-apt-repository -y ppa:git-core/ppa
  sudo apt-get update
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y git
fi
git_version="$(git --version | awk '{print $3}')"
dpkg --compare-versions "$git_version" ge 2.46 || { echo 'Git >=2.46 installation failed.' >&2; exit 1; }

# Do not silently remove an existing distribution Docker Engine or container runtime.
for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
  if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
    printf 'Conflicting package %s: migrate it explicitly before installing Docker CE. Data was not removed.\n' "$package" >&2
    exit 1
  fi
done
architecture="$(dpkg --print-architecture)"
case "$architecture" in amd64|arm64) ;; *) echo 'Only amd64 and arm64 hosts are supported.' >&2; exit 1 ;; esac
sudo install -d -m 0755 /etc/apt/keyrings /etc/apt/sources.list.d
sudo curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/pilotswarm-docker.asc
sudo curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/pilotswarm-githubcli.gpg
sudo curl --fail --show-error --silent --location --proto '=https' --tlsv1.2 \
  https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /etc/apt/keyrings/pilotswarm-nodesource.asc
sudo chmod 0644 /etc/apt/keyrings/pilotswarm-docker.asc /etc/apt/keyrings/pilotswarm-githubcli.gpg /etc/apt/keyrings/pilotswarm-nodesource.asc
ensure_repository() {
  local uri="$1" name="$2" entry="$3" file
  # Reuse existing repositories to avoid conflicting Signed-By definitions.
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do
    if [[ -f "$file" ]] && grep -Fq "$uri" "$file"; then
      printf 'Preserving configured repository %s in %s.\n' "$uri" "$file"
      return
    fi
  done
  printf '%s\n' "$entry" | sudo tee "/etc/apt/sources.list.d/pilotswarm-$name.list" >/dev/null
}
ensure_repository 'https://download.docker.com/linux/ubuntu' docker \
  "deb [arch=$architecture signed-by=/etc/apt/keyrings/pilotswarm-docker.asc] https://download.docker.com/linux/ubuntu noble stable"
ensure_repository 'https://cli.github.com/packages' githubcli \
  "deb [arch=$architecture signed-by=/etc/apt/keyrings/pilotswarm-githubcli.gpg] https://cli.github.com/packages stable main"
ensure_repository 'https://deb.nodesource.com/node_24.x' nodesource \
  "deb [arch=$architecture signed-by=/etc/apt/keyrings/pilotswarm-nodesource.asc] https://deb.nodesource.com/node_24.x nodistro main"
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin gh nodejs
hash -r
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] || { echo 'Native Node 24 is required; check PATH.' >&2; exit 1; }
for command in node npm git docker gh; do
  command_path="$(command -v "$command")"
  case "$command_path" in /mnt/*|*.exe) printf 'Non-native command: %s\n' "$command_path" >&2; exit 1 ;; esac
done

sudo install -d -m 0755 /etc/docker
if sudo test -e /etc/docker/daemon.json; then
  echo 'Preserving existing /etc/docker/daemon.json.'
else
  printf '%s\n' '{"log-driver":"json-file","log-opts":{"max-size":"50m","max-file":"3"}}' |
    sudo tee /etc/docker/daemon.json >/dev/null
fi
sudo dockerd --validate --config-file=/etc/docker/daemon.json
sudo systemctl enable --now docker
sudo usermod -aG docker "$(id -un)"
sudo docker info >/dev/null
docker --version
docker compose version
docker buildx version
node --version
npm --version
git --version
gh --version
printf '%s\n' \
  'Host bootstrap complete. Existing Docker containers, volumes and daemon settings were preserved.' \
  'Docker group membership grants root-equivalent access. Open a new login shell, then verify docker info without sudo.' \
  'Run npm ci in the checkout for repository-pinned Nx/Dev Containers CLI. No global npm tools installed.' \
  'gh login and Copilot entitlement checks are separate steps; no credentials were read or configured.'
