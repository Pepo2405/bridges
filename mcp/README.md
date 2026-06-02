# forge-mcp

Servidor MCP que expone la búsqueda del forge-server como una tool para agentes
(Claude Code). En vez de grepear el vault en disco —que a escala devuelve miles
de hits sin ordenar— el agente llama `search_vault` y recibe los resultados ya
**rankeados por relevancia (BM25)** con snippets, y abre solo los `.md`
pertinentes.

La búsqueda puede correr de dos formas:

- **Índice local** (si `FORGE_VAULT_DIR` está seteado): FTS5 construido desde la
  réplica de `.md` en disco. ~sub-ms por query, **offline y sin token**. Se
  mantiene fresco con mtime-sweep (reindexa solo lo que cambió en cada búsqueda).
  Espeja el índice del server (mismas columnas, tokenizer y pesos BM25) → ranking
  idéntico al remoto.
- **HTTP al server** (fallback): `GET /search`. Es lo que se usa si no hay
  `FORGE_VAULT_DIR`, si se fuerza con `FORGE_LOCAL_SEARCH=0`, o si el índice local
  falla.

## Tool

- **`search_vault(query, limit?)`** — busca `query` (texto libre) y devuelve hasta
  `limit` resultados (default 10), cada uno con `path`, `title`, `snippet` y —si
  `FORGE_VAULT_DIR` está seteado— la ruta **absoluta local** del `.md`. El agente
  lee la nota completa del disco con `Read`; el MCP no trae el contenido por HTTP.

## Config (env)

| Var | Default | |
|-----|---------|---|
| `FORGE_URL` | `http://localhost:4321` | base del forge-server |
| `FORGE_TOKEN` | — | Bearer token del vault (omitir si el server corre sin auth). El vault lo determina el token. |
| `FORGE_VAULT_DIR` | — | raíz del vault en disco. Si está, la búsqueda corre contra un índice FTS **local** (sub-ms, offline) y los hits incluyen la ruta absoluta local para abrirlos con `Read`. Debe ser la carpeta del **mismo** vault que el token. |
| `FORGE_LOCAL_SEARCH` | — | `0` fuerza el camino HTTP aunque haya `FORGE_VAULT_DIR` (p. ej. para comparar con el ranking del server). |

## Registrar en Claude Code

```sh
claude mcp add forge \
  --env FORGE_URL=https://forge.pepo.ar \
  --env FORGE_TOKEN=fg_xxx \
  --env FORGE_VAULT_DIR=/ruta/al/vault/en/disco \
  -- bun run /ruta/a/forge/mcp/src/index.ts
```

> El `FORGE_TOKEN` debe ser un token real del vault (crealo con `claude mcp ...`
> o desde la app); `fg_xxx` es solo un placeholder. Y `FORGE_VAULT_DIR` tiene que
> ser la carpeta del **mismo** vault al que apunta el token, o los paths locales
> no van a existir.

Para el server local de desarrollo, omití `FORGE_URL`/`FORGE_TOKEN` (toma
`http://localhost:4321` y vault `default`).

Verificá con `claude mcp list` y, dentro de Claude Code, `/mcp`.

## Probar a mano

```sh
cd mcp && bun install
FORGE_URL=http://localhost:4321 bun run src/index.ts   # habla MCP por stdio
```
