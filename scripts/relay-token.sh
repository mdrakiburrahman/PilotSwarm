#!/usr/bin/env bash
# Write an Azure Resource Manager token for the Remote Execution relay listing
# to a file the portal container reads (PS_RELAY_ARM_TOKEN_FILE). Uses the
# host's signed-in `az`, so the container needs no login of its own.
#   scripts/relay-token.sh          write once
#   scripts/relay-token.sh --loop   refresh every 30 minutes (leave running)
set -euo pipefail
DIR="${PS_RELAY_TOKEN_DIR:-/tmp/ps-relay}"
write() {
    mkdir -p "$DIR"
    local token
    token="$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv | tr -d '\r')"
    [[ -n "$token" ]] || { echo "[relay-token] az returned no token; run az login" >&2; return 1; }
    ( umask 022; printf '%s' "$token" > "$DIR/token.tmp" ) && mv "$DIR/token.tmp" "$DIR/token"
    echo "[relay-token] wrote $DIR/token"
}
write
if [[ "${1:-}" == "--loop" ]]; then
    while sleep 1800; do write || true; done
fi
