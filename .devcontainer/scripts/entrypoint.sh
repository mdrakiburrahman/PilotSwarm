#!/usr/bin/env bash
set -euo pipefail

# The host socket stays mode 0660 (or stricter). Docker access is equivalent
# to host root; grant it only to this explicitly trusted development user.
socket=/var/run/docker.sock
if [[ -S "$socket" ]]; then
    gid="$(stat -c '%g' "$socket")"
    resolve_socket_group() {
        local entry status
        if entry="$(getent group "$1")"; then
            group="${entry%%:*}"
            [[ -n "$group" ]] || { echo "Docker socket group lookup returned an empty group" >&2; return 1; }
        else
            status=$?
            if [[ "$status" != 2 ]]; then
                echo "Docker socket group lookup failed (exit $status)" >&2
                return "$status"
            fi
            group=host-docker
            groupadd --gid "$1" "$group"
        fi
    }
    resolve_socket_group "$gid"
    usermod -aG "$group" vscode
fi

mount_paths="$(node .devcontainer/scripts/config.mjs mount-paths)"
while IFS= read -r mount; do
    chown vscode:vscode "$mount"
done <<< "$mount_paths"
for mount in /home/vscode/.npm /home/vscode/.vscode-server /home/vscode/pilotswarm-local /workspaces/PilotSwarm/.nx; do
    mkdir -p "$mount"
    chown vscode:vscode "$mount"
done
# gh uses the WSL user's existing config bind mount. Do not chown or chmod
# that host profile; the Dev Containers CLI aligns vscode's UID with its owner.
if ! runuser -u vscode -- git config --global --get-all safe.directory | grep -Fxq /workspaces/PilotSwarm; then
    runuser -u vscode -- git config --global --add safe.directory /workspaces/PilotSwarm
fi
exec runuser -u vscode -- "$@"
