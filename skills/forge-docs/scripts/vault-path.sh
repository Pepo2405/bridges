#!/usr/bin/env bash
# Imprime la ruta en disco del vault de Forge.
# Prioridad: $FORGE_VAULT  >  lastVault de la config de la app Forge.
set -euo pipefail

if [[ -n "${FORGE_VAULT:-}" ]]; then
  echo "$FORGE_VAULT"
  exit 0
fi

# La app Tauri guarda su config en app_config_dir/forge.json (identifier com.pxsol.forge).
CANDIDATES=(
  "$HOME/Library/Application Support/com.pxsol.forge/forge.json"   # macOS
  "${XDG_CONFIG_HOME:-$HOME/.config}/com.pxsol.forge/forge.json"   # Linux
)
CFG=""
for c in "${CANDIDATES[@]}"; do
  [[ -f "$c" ]] && { CFG="$c"; break; }
done

if [[ -z "$CFG" ]]; then
  echo "ERROR: no encontré la config de Forge. Abrí la app y conectá un vault, o exportá FORGE_VAULT=/ruta/al/vault." >&2
  exit 1
fi

python3 - "$CFG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
vault = cfg.get("lastVault") or next((c.get("vault") for c in cfg.get("connections", []) if c.get("vault")), None)
if not vault:
    sys.stderr.write("ERROR: la config de Forge no tiene ningún vault. Conectá uno en la app.\n")
    sys.exit(1)
print(vault)
PY
