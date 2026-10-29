# Bridges — notas para agentes

Bridges es un vault de documentación (Obsidian self-hosteado) empaquetado como
**plugin de Claude Code**: un MCP para buscar/leer/navegar el vault con tools read-only,
más skill (`bridges-docs`), command (`/bridges`) y agente (`doc-writer`). En modo local
con `BRIDGES_MCP_READONLY` deshabilitado expone además `create_note`/`update_note`/
`delete_note`/`restore_note`/`list_history` con undo net en `.bridges/` (snapshots +
papelera). El identifier histórico del repo sigue siendo "forge".

## Mapa del repo

- `mcp/` — servidor MCP (Bun/TypeScript). Ver `mcp/README.md` para tools, modos
  (local/HTTP) y config. **Es lo que consumen los agentes.**
- `server/` — bridges-server (el backend HTTP del vault).
- `client/` — app de escritorio (Tauri).
- `.claude-plugin/` — manifiestos del plugin (`plugin.json`, `marketplace.json`) y
  `launch.sh` (launcher del MCP).
- `commands/`, `agents/`, `skills/`, `hooks/` — piezas del plugin. `hooks/hooks.json`
  corre `launch.sh hook session-start` (contexto de memoria del proyecto).
- `docs/memoria-agentes.md` — protocolo de memoria (Decisiones + Bitácora) para agentes;
  tools `project_context` / `save_decision` / `log_session` en `mcp/src/memory.ts`.

## MCP: multi-vault, mono-vault-por-proceso

El MCP resuelve **un** vault al arrancar (`resolveVaultDir`, cascada
`.bridges (cwd) → BRIDGES_VAULT_DIR → lastVault de bridges.json`) y lo fija en el
proceso. Las tools de lectura aceptan además un `vault?` opcional (nombre de un vault
configurado, ver `list_vaults`) para operar sobre **otro** vault sin reiniciar ni
cambiar el default. El `vault` nombrado solo aplica en modo local (por HTTP el server
sirve un único vault, el del token). Detalle en `mcp/README.md`.

## ⚠️ El plugin corre un BINARIO RELEASADO, no la fuente

`.claude-plugin/launch.sh` **no** ejecuta `mcp/src/`: descarga un binario compilado
del GitHub Release (`Pepo2405/bridges`, tag `mcp-v<VERSION>`) y lo cachea en
`~/.cache/bridges-mcp/<VERSION>/`. **Editar `mcp/src/` NO cambia lo que corre en un
plugin instalado** hasta que publiques un release nuevo.

Para que un cambio del MCP llegue a los plugins instalados:

1. Bumpear la versión en **dos** lugares (deben coincidir):
   - `.claude-plugin/launch.sh` → `VERSION="X.Y.Z"`
   - `.claude-plugin/plugin.json` → `"version": "X.Y.Z"`
2. `git tag mcp-vX.Y.Z && git push --tags` (push por SSH; `gh` no tiene acceso al repo).
3. El workflow `.github/workflows/mcp-release.yml` compila los binarios
   (darwin-arm64/x64, linux-x64) y los sube al release del tag.
4. Cada cliente rebaja el binario nuevo la próxima vez que `launch.sh` no lo encuentre
   en cache (cache por versión → basta con que cambie `VERSION`).

## Antes de commitear cambios en `mcp/`

```sh
cd mcp
bun test            # tests (localIndex, graph, config, bridges)
bunx tsc --noEmit   # typecheck strict
```
