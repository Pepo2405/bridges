# 011 — Memoria de agentes a la par de Engram

ODD: grande. Rama `feat/memoria-agentes` (worktree `~/code/forge-memoria`).

## Specs

- S1 — Pedido: "quiero que bridges no se quede atras y sea igual de util" (que Engram).
- S2 — Pedido: "vamos y hacelo vos aca", con el orden propuesto: primero (1) tools de
  guardado de una sola llamada y (2) contexto de proyecto para cualquier agente; después
  (4) búsqueda con muchos términos; al final (3) resistencia a la compactación.
- S3 — Restricción del usuario: no tocar `~/.claude` ni `~/.agents` desde Hermes. Lo que
  haya que cambiar ahí se entrega como texto listo para copiar.
- S4 — Suposición: las notas existentes (sin frontmatter o con otro formato) no pierden
  texto cuando una tool las actualiza.

## Tareas

1. **Búsqueda AND → OR** (S2.4). `toMatchQuery(query, op)` en `search-common`. El índice
   local y el server prueban AND; si no hay resultados, prueban OR (BM25 ordena por cuántos
   términos matchean). Con AND sin cambios, el resultado es idéntico al de hoy.
   Test: una query con un término inexistente encuentra la nota que tiene los demás.
   Riesgo: ítem 3 (cambia la búsqueda que usan todos los agentes; solo cuando AND da vacío).
2. **`mcp/src/memory.ts`** (S2.1, S2.2, S4): `resolveProject({cwd?, vault?, folder?})`,
   `saveDecision`, `logSession`, `projectContext`. Mismo formato que
   `~/.claude/bridges-memoria.md`: frontmatter `tipo/estado/actualizado/revisar_despues`,
   Qué/Por qué/Dónde/Aprendido, `## Cambios`, `reemplaza` marca la vieja. Upsert por
   nombre normalizado (sin acentos ni mayúsculas); avisa temas parecidos. Escribe con
   `createNote`/`updateNote` (snapshot). Riesgo: ninguno (archivos nuevos, con tests).
3. **Tools MCP** `project_context` (modo local) y `save_decision` / `log_session` (gate
   de escritura), con `cwd?` para agentes cuyo proceso no corre en el repo (Hermes).
   Riesgo: ninguno (agrega tools, no cambia las existentes).
4. **Hook del plugin** (S2.3): `bridges-mcp hook session-start` lee el JSON de Claude
   Code e imprime `additionalContext`; con `source: compact` pide escribir la Bitácora.
   `hooks/hooks.json` en el plugin, `launch.sh` pasa `"$@"`, versión 0.2.0.
   Riesgo: ítem 6 (entrega: llega a los plugins recién con el tag `mcp-v0.2.0`).
5. **Docs**: `mcp/README.md`, protocolo nuevo en `docs/memoria-agentes.md` (texto para
   reemplazar `~/.claude/bridges-memoria.md`).

Fuera de alcance: captura de prompts, sync a la nube, hook de Hermes (cwd suele ser `~`).
