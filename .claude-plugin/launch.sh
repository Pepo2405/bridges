#!/bin/sh
# Launcher del MCP de Bridges: resuelve el binario compilado para esta plataforma
# (cache en ~/.cache/bridges-mcp/<version>/), lo baja del GitHub Release si falta,
# y lo ejecuta hablando stdio. El consumidor no necesita Bun.
set -eu

VERSION="0.1.0"                 # mantener sincronizado con plugin.json / tag mcp-v<VERSION>
REPO="Pepo2405/bridges"
TAG="mcp-v${VERSION}"

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in
  Darwin) case "$arch" in arm64) plat="darwin-arm64" ;; x86_64) plat="darwin-x64" ;; *) plat="" ;; esac ;;
  Linux)  case "$arch" in x86_64) plat="linux-x64" ;; *) plat="" ;; esac ;;
  *) plat="" ;;
esac
if [ -z "$plat" ]; then
  echo "[bridges-mcp] plataforma no soportada: $os/$arch" >&2
  exit 1
fi

cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/bridges-mcp/${VERSION}"
bin="${cache_dir}/bridges-mcp-${plat}"

if [ "${BRIDGES_MCP_DRYRUN:-0}" = "1" ]; then
  echo "plat=${plat} bin=${bin} url=https://github.com/${REPO}/releases/download/${TAG}/bridges-mcp-${plat}"
  exit 0
fi

if [ ! -x "$bin" ]; then
  mkdir -p "$cache_dir"
  url="https://github.com/${REPO}/releases/download/${TAG}/bridges-mcp-${plat}"
  echo "[bridges-mcp] descargando binario ${plat} (${TAG})..." >&2
  if ! curl -fsSL "$url" -o "$bin"; then
    echo "[bridges-mcp] falló la descarga de $url" >&2
    rm -f "$bin"
    exit 1
  fi
  chmod +x "$bin"
fi

exec "$bin"
