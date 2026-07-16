# Fase 0 — Escritura vía MCP (segunda memoria para Claude Code)

**Estado:** LISTO PARA PLAN — §7 cerrado (2026-07-16); pendiente solo la aprobación final para invocar `writing-plans`.
**Fecha:** 2026-07-06 (decisiones §7 cerradas 2026-07-16)
**Contexto:** parte de una visión más amplia de convertir bridges en "segundo cerebro" de Claude Code (memoria auto-gestionada + KB consultable + journal + grafo + metadata). Este spec cubre **solo la Fase 0**: dar escritura al MCP.

---

## 1. Objetivo y alcance

Hoy el MCP (`mcp/src/index.ts`) es **100% read-only** (4 tools: `search_vault`, `read_note`, `get_backlinks`, `list_links`). La API del server sí escribe (`POST /documents`, versionado, papelera), pero el agente no lo tiene expuesto → bridges es "biblioteca que Claude lee", no "memoria que Claude gestiona".

Fase 0 = exponer escritura por MCP para que Claude **cree, edite (overwrite/append/patch) y borre** notas, con toda operación destructiva recuperable.

**Fuera de alcance** (fases siguientes): metadata tipada/tags indexados (F1), búsqueda semántica/embeddings (F2), tools de journal/grafo y grafo persistido (F3), escritura por HTTP, `rename/move` con reescritura de `[[links]]`, salidas JSON en las tools de lectura.

## 2. Decisiones tomadas (cerradas)

1. **Autoridad de escritura:** CRUD total sobre todo el vault (no una carpeta sandbox). Justificado por tener red de undo.
2. **Operaciones:** create + delete + update con 3 modos: `overwrite` / `append` / `patch` (de sección por heading).
3. **Modo:** local/disco. Escritura = `.md` directo a disco, offline, sin token.
4. **Naming:** híbrido. `create_note` acepta `path` opcional; si falta, slug del `title` dentro de un `folder` default.
5. **Red de undo (net B):** snapshot + papelera propias del MCP en `.bridges/` (NO git — el vault no es repo y el usuario no quiso convertirlo). El "historial tipo git" del server NO aplica en local porque se bypassea la API.
6. **Vault destino (nuevo, post-multivault 2026-07-16):** las write-tools resuelven el vault igual que las de lectura — `vault?` opcional por nombre (`resolveNamedVault`), y sin él, la cascada de arranque (`.bridges → BRIDGES_VAULT_DIR → lastVault`). Escritura siempre a un vault **local**; en modo HTTP las write-tools no se registran.
7. **Dir interno = `.bridges/`:** convive con `.bridges/index.json` y `.bridges/state.json` (el undo net va en `.bridges/history/` y `.bridges/trash/`). Ya excluido del índice/grafo: `walkMd` (localIndex.ts) salta todo lo que empieza con `.`.

## 3. Tools nuevas (`mcp/src/index.ts`, schema Zod, salida JSON estructurada)

- **`create_note`** — `{ title, content, path?, folder?, overwrite?=false }`
  Con `path` → ese (relativo, agrega `.md`); sin `path` → slug(`title`) dentro de `folder` (default `BRIDGES_MCP_DEFAULT_FOLDER`, fallback **`Memoria/`**). Si existe y `!overwrite` → error con el path existente.
  → `{ path, title, action:"created", bytes, brokenLinks[] }`

- **`update_note`** — `{ path, mode:"overwrite"|"append"|"patch", content, heading? }`
  - `overwrite`: reemplaza cuerpo entero.
  - `append`: agrega al final (caso journal).
  - `patch`: reemplaza el cuerpo bajo `heading` (`## X`, hasta el próximo heading de nivel igual o mayor). Heading inexistente → error (no crea silenciosamente).
  - Snapshot del estado previo antes de escribir.
  → `{ path, action, mode, bytes, brokenLinks[] }`

- **`delete_note`** — `{ path }`
  Mueve el `.md` a `.bridges/trash/` (preserva estructura) + entrada en manifest.
  → `{ path, action:"trashed", trashPath, orphanedBacklinks[] }` (avisa qué notas quedaron con links rotos).

- **`restore_note`** — `{ path, from?:"trash"|"history", timestamp?, vault? }`
  Recupera un borrado (trash) o revierte una edición (history). Default: trash si existe, si no el snapshot más reciente.
  → `{ path, action:"restored", source }`

- **`list_history`** — `{ path, vault? }` → snapshots + entradas de trash de esa nota.

## 4. Capa de escritura (`mcp/src/writer.ts`, módulo nuevo)

- Funciones sobre `BRIDGES_VAULT_DIR`: `createNote/updateNote/deleteNote/restoreNote` + helpers `snapshot()`, `slug()`, `resolveInVault()` (guard anti-traversal, reusar el de `read_note`).
- Layout `.bridges/`: `.bridges/history/<relpath>/<ISO-ts>.md` (rotar a últimos ~50 por nota) y `.bridges/trash/<relpath>` + `.bridges/trash/manifest.jsonl`.
- `append`/`patch`/`delete` = read→modify→write en disco. Sin version-check (no hay server en local); race con la app editando el mismo archivo es raro y la net lo cubre. Documentarlo.
- Consistencia de lectura: `read_note` lee disco (inmediato); `search_vault` refresca con el mtime-sweep existente. Sin cambios en el índice.

## 5. Guardas de seguridad

- **`.bridges/` excluido del indexado/grafo — YA CUBIERTO:** `walkMd` (localIndex.ts:59) salta todo lo que empieza con `.`, y search/backlinks/links pasan por ahí. Snapshots y trash no contaminan. Solo agregar un test que lo fije como invariante.
- Anti-traversal en todo path.
- **Write habilitado por defecto en local, opt-out con `BRIDGES_MCP_READONLY=1`** (decisión §7c). Mitigación del riesgo multivault (plugin global que puede resolver cualquier vault): (i) escritura siempre local a un vault resuelto explícitamente; (ii) toda op destructiva recuperable por la net B; (iii) `create` no pisa sin `overwrite`, `patch` no crea headings, `delete` avisa backlinks huérfanos.
- Modo HTTP: write-tools no se registran (F0 = local-only); error claro si se invocan.

## 6. Criterios de éxito (tests, estilo `mcp/.../localSearch.test.ts`)

- Unit: `slug`; traversal rechazado; create (nuevo + colisión); update overwrite/append/patch (heading ok / inexistente); delete→trash; restore desde trash y history; rotación de snapshots; `.bridges/` excluido del índice.
- Integración (loop completo): en una sesión Claude **crea → append → patch de sección → search/read de vuelta → delete → restore**, todo offline, cada op destructiva recuperable.

## 7. Cerrado (2026-07-16)

- **(a)** `restore_note` **y** `list_history` van en F0 (ambas). Claude puede deshacer e inspeccionar historial en sesión.
- **(b)** `folder` default = **`Memoria/`** (carpeta dedicada al "segundo cerebro"; no ensucia la raíz curada).
- **(c)** Write **on por default**, opt-out con `BRIDGES_MCP_READONLY=1`. Riesgo multivault mitigado en §5.

## 8. Próximo paso

Cerrar §7 + aprobación → invocar skill `writing-plans` para el plan de implementación detallado.

---

### Anexo: roadmap de las fases siguientes (contexto, no parte de este spec)

- **F1 — Metadata para Claude:** frontmatter tipado (`type`, `tags`, `project`, `date`, `status`, `aliases`) indexado en el server; tools `list_tags`, `notes_by_tag`, `query({type,tag,project,since})`; tool `bootstrap`/`get_index` (mapa del vault, equivalente al `MEMORY.md` de Claude Code).
- **F2 — Recuperación:** búsqueda semántica (embeddings) híbrida con el BM25 actual; `find_similar` para dedup antes de escribir.
- **F3 — Journal + grafo:** `log_entry` + `recent`/`timeline`; traversal (`neighbors`, `related`) y grafo de links persistido en SQLite (arregla el recompute O(n) que degrada a cientos de notas).
