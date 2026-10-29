# bridges-mcp

Servidor MCP para el vault del bridges-server: tools de lectura (búsqueda, notas, grafo) y —en modo local— escritura de notas con undo (Fase 0). Expone el vault a agentes
(Claude Code): búsqueda rankeada, lectura de notas y navegación por el grafo de
wikilinks. En vez de grepear el vault en disco —que a escala devuelve miles de
hits sin ordenar— el agente busca con `search_vault` (resultados ya **rankeados
por relevancia (BM25)** con snippets), abre la nota que le sirve y salta por sus
backlinks/links. Cuatro tools de lectura; en modo local, con write habilitado (default), suma cinco tools de escritura recuperables (ver §Escritura).

Las tools pueden correr de dos formas:

- **Local** (si `BRIDGES_VAULT_DIR` está seteado): lee de la réplica de `.md` en
  disco. La búsqueda usa un índice FTS5 (~sub-ms por query, **offline y sin
  token**) que se mantiene fresco con mtime-sweep (reindexa solo lo que cambió en
  cada búsqueda) y espeja el índice del server (mismas columnas, tokenizer y pesos
  BM25 → ranking idéntico al remoto). `read_note`/`get_backlinks`/`list_links` leen
  los `.md` directo del disco.
- **HTTP al server** (si no hay `BRIDGES_VAULT_DIR`, si se fuerza con
  `BRIDGES_LOCAL_SEARCH=0`, o si el índice local falla): la búsqueda va por
  `GET /search`; la lectura y el grafo tiran de `GET /sync` (trae el vault y filtra
  por path). A ~70 docs es un round-trip; el modo local no necesita esto.

## Tools

- **`search_vault(query, limit?, pathPrefix?, vault?)`** — busca `query` (texto libre) y
  devuelve hasta `limit` resultados (default 10), cada uno con `path`, `title` y un
  `snippet` (30 tokens) y —en modo local— la ruta **absoluta local** del `.md`.
  `pathPrefix` filtra a notas cuyo path empieza con ese prefijo (p. ej.
  `'01 - Proyectos/'`). Ya viene ordenado por relevancia: usalo en vez de grepear.
  Exige todos los términos; si ninguna nota los tiene a todos, reintenta con cualquiera
  (OR) y BM25 pone primero las que matchean más.
- **`read_note(path, vault?)`** — devuelve el **contenido completo** de una nota por su path
  relativo. En modo local lo lee del disco (con guard anti-traversal); en modo HTTP
  lo trae de `/sync`. Cierra el agujero de que en HTTP el agente solo veía el snippet.
- **`get_backlinks(path, vault?)`** — lista las notas que **enlazan** a `path` (vía
  `[[wikilinks]]`). El diferencial sobre grep: navegás el grafo, no el texto.
- **`list_links(path, vault?)`** — lista las notas a las que `path` **enlaza**, marcando los
  links rotos (sin nota destino).

### Memoria de agentes (Decisiones + Bitácora)

El equivalente de Engram sobre el vault: lo que el agente aprende queda en
`<folder>/Decisiones/<Tema>.md` (una nota por tema) y el handoff de cada sesión en
`<folder>/Bitácora/<fecha> - <tema>.md`, en la carpeta que declara el `.bridges` del repo.
Protocolo completo para agentes: [`docs/memoria-agentes.md`](../docs/memoria-agentes.md).

- **`project_context(cwd?, vault?, folder?)`** — Decisiones vigentes (marca las vencidas
  según `revisar_despues`, omite las reemplazadas) y próximos pasos de la última Bitácora.
- **`save_decision(topic, tipo?, que?, porque?, donde?, aprendido?, cambio?, reemplaza?, cwd?, vault?, folder?)`**
  — upsert por tema (nombre normalizado sin mayúsculas ni acentos). Arma el frontmatter
  (`tipo/estado/actualizado/revisar_despues`), los campos Qué/Por qué/Dónde/Aprendido y la
  línea de `## Cambios`; conserva el texto y las secciones que ya tenía la nota. Devuelve
  `similares` (posibles duplicados). Write-tool.
- **`log_session(tema, objetivo?, instrucciones?, descubrimientos?, hecho?, proximos?, archivos?, cwd?, vault?, folder?)`**
  — crea o suma a la Bitácora del día. Write-tool.

El proyecto se resuelve buscando `.bridges` en `cwd` (default: cwd del MCP) y sus padres,
o con `vault` + `folder` explícitos. Pasá `cwd` desde agentes que no corren en el repo.

**Hook:** `bridges-mcp hook session-start` lee el JSON de SessionStart de Claude Code por
stdin e imprime el contexto como `additionalContext` (con `source: "compact"`, además pide
escribir la Bitácora). El plugin lo registra en `hooks/hooks.json`. Sin `.bridges` no
imprime nada.

**Otros agentes:** `bridges-mcp setup <opencode|omp> [--command '<cmd>'] [--dry-run]`
(desde la fuente: `bun run mcp/src/index.ts setup opencode`). Agrega o actualiza la
entrada `bridges` del MCP en la config del agente (conserva las otras y el `environment`;
backup `*.bak-bridges-*`) e instala un plugin que hace lo mismo que el hook de Claude Code:
contexto del proyecto en el system prompt (una vez por sesión, sin romper el prompt cache)
y, al compactar, pedido de Bitácora hasta que el agente llama a `log_session`. Saltea
subagentes. Archivos: OpenCode → `~/.config/opencode/plugins/bridges-memoria.js`, omp →
`~/.omp/agent/extensions/bridges-memoria.ts` (plantillas en `src/integrations/`). El
comando default es el que está corriendo; si es el binario del plugin de Claude (ruta con
versión), pasá `--command` con algo estable.

### Escritura (Fase 0, local-only)

Si el MCP arranca en modo local y `BRIDGES_MCP_READONLY` != `1`, registra además:

- **`create_note(title, content, path?, folder?, overwrite?, vault?)`** — crea una nota
  (sin `path` → `Memoria/<slug(title)>.md`). Colisión sin `overwrite` → error.
- **`update_note(path, mode, content, heading?, vault?)`** — `overwrite` / `append` /
  `patch` (sección por `heading`). Snapshotea el estado previo.
- **`delete_note(path, vault?)`** — a la papelera (`.bridges/trash`), avisa backlinks huérfanos.
- **`restore_note(path, from?, timestamp?, vault?)`** — recupera de trash o revierte un snapshot.
- **`list_history(path, vault?)`** — snapshots + papelera de una nota.

Toda op destructiva es recuperable: snapshots en `.bridges/history/` (máx. 50 por nota)
y borrados en `.bridges/trash/`. Ambos excluidos del índice (dotdir). Las write-tools
rechazan paths bajo `.bridges/` (la red de undo), `.git/` y `.obsidian/`.
`BRIDGES_MCP_READONLY=1` apaga la escritura; `BRIDGES_MCP_DEFAULT_FOLDER` cambia la
carpeta default (fallback `Memoria`).

### Multi-vault (`vault?`)

Todas las tools de lectura aceptan un `vault` opcional con el **nombre** de un vault
configurado en la app (ver `list_vaults`). Sin `vault`, opera sobre el vault que
resuelve la cascada de arranque (`.bridges → BRIDGES_VAULT_DIR → lastVault`). Con
`vault`, resuelve `name`/basename → path contra `bridges.json` y busca/lee en **ese**
vault, sin reiniciar ni cambiar el default. El flujo típico del agente: `list_vaults`
→ elegir por nombre → `search_vault(query, vault: "…")`. Vault desconocido → error
(`list_vaults` para ver los disponibles). El `vault` nombrado solo funciona en modo
**local**: por HTTP el server sirve un único vault (el que fija el token).

## Config (env)

| Var | Default | |
|-----|---------|---|
| `BRIDGES_URL` | `http://localhost:4321` | base del bridges-server |
| `BRIDGES_TOKEN` | — | Bearer token del vault (omitir si el server corre sin auth). El vault lo determina el token. |
| `BRIDGES_VAULT_DIR` | — | raíz del vault en disco. Si está, la búsqueda corre contra un índice FTS **local** (sub-ms, offline) y los hits incluyen la ruta absoluta local para abrirlos con `Read`. Debe ser la carpeta del **mismo** vault que el token. |
| `BRIDGES_LOCAL_SEARCH` | — | `0` fuerza el camino HTTP aunque haya `BRIDGES_VAULT_DIR` (p. ej. para comparar con el ranking del server). |
| `BRIDGES_MCP_READONLY` | — | `1` desregistra las write-tools (MCP solo-lectura aunque sea local). |
| `BRIDGES_MCP_DEFAULT_FOLDER` | `Memoria` | carpeta para notas creadas sin `path`. |

## Registrar en Claude Code

```sh
claude mcp add bridges \
  --env BRIDGES_URL=https://bridges.pepo.ar \
  --env BRIDGES_TOKEN=bg_xxx \
  --env BRIDGES_VAULT_DIR=/ruta/al/vault/en/disco \
  -- bun run /ruta/a/bridges/mcp/src/index.ts
```

> El `BRIDGES_TOKEN` debe ser un token real del vault (crealo con `claude mcp ...`
> o desde la app); `bg_xxx` es solo un placeholder. Y `BRIDGES_VAULT_DIR` tiene que
> ser la carpeta del **mismo** vault al que apunta el token, o los paths locales
> no van a existir.

Para el server local de desarrollo, omití `BRIDGES_URL`/`BRIDGES_TOKEN` (toma
`http://localhost:4321` y vault `default`).

Verificá con `claude mcp list` y, dentro de Claude Code, `/mcp`.

## Probar a mano

```sh
cd mcp && bun install
BRIDGES_URL=http://localhost:4321 bun run src/index.ts   # habla MCP por stdio
```

## Tests y typecheck

```sh
cd mcp
bun test            # tests de localIndex (sweep/prefix/acentos/ranking) y graph (wikilinks)
bunx tsc --noEmit   # typecheck (strict)
```
