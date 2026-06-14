# Plan 010: Vaults offline (locales, sin token ni servidor)

> **Executor instructions**: Follow this plan step by step. Run every verification
> command before moving on. The Rust step (1) and the search step (6) are the only
> ones with isolated test surface; the rest is verified by typecheck + manual smoke
> in `tauri dev`. If a STOP condition occurs, stop and report. Update the status row
> in `plans/README.md` when done.
>
> **Design doc**: `docs/superpowers/specs/2026-06-13-vaults-offline-locales-design.md`
> (read it first — it has the rationale and the decisions behind every choice).
>
> **Drift check (run first)**:
> `git diff --stat main..HEAD -- client/src/lib/store.ts client/src/lib/tauri.ts client/src/lib/api.ts client/src/App.tsx client/src/components/AddVaultDialog.tsx client/src-tauri/src/lib.rs`
> Compare the "Current state" line refs below against the live code before editing.

## Status

- **Priority**: P2 (feature)
- **Effort**: M/L
- **Risk**: MED — touches `store.ts` (the sync engine) and `App.tsx` (god-files). Mitigated by enfoque C: the remote engine is left intact and gated, not rewritten.
- **Depends on**: plan 003 (Vitest) — landed. No other deps.
- **Category**: feature
- **Planned at**: commit `1a18a95`, 2026-06-13, branch `vaults-offline`

## Why this matters

Hoy todo vault es una **conexión a un servidor**: `AddVaultDialog` exige `serverUrl`, y
`openSession` siempre construye un `BridgesApi` y hace health → reconcile → whoami → SSE.
Existe un modo offline *degradado* (server caído → `hydrateFromDisk` + cola), pero es un estado
caído de una conexión que igual apunta a un server, no un vault local de primera clase.

La mayor parte de la app ya es client-side (árbol, editor, preview, wikilinks, backlinks, grafo se
computan de `sess.docs`, que tiene el contenido completo en RAM con o sin server). Falta poder
**crear un vault puramente local, sin token ni servidor, nunca**: elegís una carpeta y el disco es
la verdad, el store su espejo directo.

## Decisiones (del design doc)

- **Enfoque C**: el motor de sync remoto queda intacto; el `SessionRuntime` lleva `api: BridgesApi | null`
  (`null` ⇒ local). Las funciones públicas rutean según `rt.api === null`. Branch en ~6 puntos.
- **Discriminador persistido**: `Connection.serverUrl === null` ⇒ vault local. Estricto `=== null`
  (no `undefined`, que sigue significando "default localhost" en los flujos remotos).
- **Búsqueda**: scan en memoria sobre `sess.docs` (ya en RAM). Sin SQLite en el cliente.
- **Borrado**: a la **papelera del SO** (crate `trash`), no hard-delete.
- **Sin índice `.bridges/` ni `state.json`** en local: el disco es la verdad, el store su espejo.
  Echo del watcher suprimido por comparación de contenido contra el store.

## Current state (line refs at commit `1a18a95`)

- `client/src/lib/tauri.ts:120-121` — `type Connection = { vault: string; serverUrl: string; token?: string; openedAt: string }` y `AppConfig`.
- `client/src/lib/store.ts`:
  - `Session` type `37-57` (sin campo `local`); `SessionRuntime` `73-82` (`api: BridgesApi`, `index: idx.IndexHandle`).
  - `freshSession` `123-142`.
  - `pullSession` `207-227`; `reconcile` `486-573`; `applyDocs` `157-191`; `persistIndex` `248-251`; `enqueuePush` `287-301`; `flushQueue` `304-316`; `pushOne` `319-399`; `mergeConflict` `406-457` — **motor remoto** (asumen `rt.api`/`rt.index`).
  - `hydrateFromDisk` `460-479` (usa `rt.index.getEntry`).
  - `openSession` `622-685`; `startSessionSync` `693-710`; `closeSession` `713-730` (usa `rt.index.clear()` en `722`).
  - `connect` `744-749`; `persistConnection` `805-815`.
  - `saveDoc` `943-998`; `deleteDoc` `1010-1038`; `queueLocalDelete` `1001-1008`; `moveDoc` `1087-1096`; `pull` `230-233`.
  - `scheduleExternal` `864-873` (watcher → `enqueuePush`).
  - `pickVault` import (de `./tauri`); `browserMode` `1124`.
- `client/src/lib/api.ts:18` — `type SearchHit = { id: string; path: string; title: string | null; snippet: string }`.
- `client/src/App.tsx`:
  - búsqueda `onSearch` `606-619` (`activeApi()?.search(q)`); input topbar `741-749`.
  - `SyncStatus` componente `274-303`; `vaultSyncLabel` `114-122`; `VaultSyncDot` `124-144`.
  - botones topbar: Papelera `793-797` (gate `perms.write`), Vaults `798-802` (gate `isOwner`), API keys `803-807` (gate `!authEnabled || role==="admin"`), Sincronizar `808-810`.
  - command palette cmds `689` (sync), `692-693` (trash, gate `perms.write`), `694-695` (tokens), `696-697` (vaults), `698` (add-vault).
  - `onRenameSubmit` `574-577` (llama `moveDoc`, **no** reselecciona — en remoto el id no cambia).
  - dialog mounts `1086-1104`.
- `client/src-tauri/src/lib.rs`: comandos `vault_write/remove/read/scan` `79-142`; `resolve_in_vault` `60-77`; `invoke_handler` `410-427`.
- `client/src-tauri/Cargo.toml:15-26` — deps (sin `trash`).

### Repo conventions

SolidJS, TS strict, semicolons, comentarios en español. Commits `tipo: descripción` en español.
Pure helpers testeables con Vitest (ver `client/src/lib/reconcile.test.ts`).

## Commands you will need

| Purpose          | Command                                   | Expected |
|------------------|-------------------------------------------|----------|
| Client typecheck | `cd client && bunx tsc --noEmit`          | exit 0   |
| Client tests     | `cd client && bun run test`               | all pass |
| Rust check       | `cd client/src-tauri && cargo check`      | exit 0   |
| Run app (manual) | `cd client && bun run tauri dev`          | app opens |
| Browser UI (manual) | `cd client && bun run dev`             | localhost:1420 (no disco) |

## Scope

**In scope**: crear/abrir/persistir vaults locales; CRUD local (save/delete→papelera SO/move);
búsqueda en memoria; watcher local; gating de UI server-only; comando Rust `vault_trash`.

**Out of scope** (anotado en el design, no construir): promoción local→server (ya cubierta por
"agregar vault" + importar); historial/versionado y papelera in-app para local; SQLite en cliente;
MCP `search_vault` para locales.

## Git workflow

- Branch: `vaults-offline` (ya creada; el spec ya está commiteado ahí).
- Commits sugeridos, en orden: `feat(rust): comando vault_trash (papelera del SO)`,
  `feat(client): modo local en el store (sin server ni token)`,
  `feat(ui): crear/usar vaults locales + gating server-only`,
  `test: búsqueda local`.
- No pushear ni abrir PR salvo que se indique.

## Steps

### Step 1 — Rust: comando `vault_trash` (papelera del SO)

1. `client/src-tauri/Cargo.toml` deps: agregar `trash = "5"`.
2. `client/src-tauri/src/lib.rs`: agregar el comando (reusa `resolve_in_vault`):
   ```rust
   /// Manda el archivo a la papelera del SO (recuperable desde Finder/Explorer).
   /// No-op silencioso si ya no existe.
   #[tauri::command]
   fn vault_trash(vault: String, path: String) -> Result<(), String> {
       let abs = resolve_in_vault(&vault, &path)?;
       if !abs.exists() {
           return Ok(());
       }
       trash::delete(&abs).map_err(|e| e.to_string())
   }
   ```
3. Registrar `vault_trash` en el `invoke_handler!` (junto a `vault_remove`, ~línea 411).

**Verify**: `cd client/src-tauri && cargo check` → exit 0.

> Comandos definidos por la app (no de plugin) no necesitan entrada de capability en Tauri 2 —
> `vault_remove`/`vault_write` no la tienen; `vault_trash` tampoco.

### Step 2 — `tauri.ts`: `Connection.serverUrl` nullable + wrapper `vaultTrash`

1. Cambiar el tipo (línea 120):
   ```ts
   export type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string };
   ```
2. Agregar el wrapper (junto a `vaultRemove`, con stub de browser que borra del mem):
   ```ts
   export async function vaultTrash(vault: string, path: string): Promise<void> {
     if (!isTauri) {
       memFilesFor(vault).delete(path);
       return;
     }
     await invoke("vault_trash", { vault, path });
   }
   ```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0 (puede haber errores de `store.ts` hasta el Step 5; este step solo no debe introducir errores nuevos en `tauri.ts`).

### Step 3 — `store.ts`: tipos y guardas para `api/index` null

1. `Session` type (`37-57`): agregar `local: boolean; // vault local sin server`.
2. `freshSession` (`123-142`): agregar `local: false,`.
3. `SessionRuntime` type (`73-82`): cambiar a `api: BridgesApi | null;` e `index: idx.IndexHandle | null;`.
4. **Guardas del motor remoto**: agregar al inicio de cada función del motor un early-return que
   además **narrowea** los tipos para strict-null (no usar `!`). Funciones a guardar:
   `pullSession`, `reconcile`, `applyDocs`, `persistIndex`, `enqueuePush`, `flushQueue`, `pushOne`,
   `mergeConflict`. Patrón:
   ```ts
   async function pullSession(rt: SessionRuntime) {
     if (!rt.api || !rt.index) return;            // sesión local: no entra al motor
     // … resto igual (rt.api / rt.index ya narroweados a no-null) …
   }
   ```
   Para `pushOne`/`mergeConflict` (devuelven `boolean`): `if (!rt.api || !rt.index) return true;`.
   Para `persistIndex` (no devuelve nada relevante): `if (!rt.index) return;`.
5. `hydrateFromDisk` (`460-479`): cambiar `rt.index.getEntry(f.path)` por `rt.index?.getEntry(f.path)`
   (optional chaining) para que sirva también con `index: null`. Con index null cae a los defaults
   (`id = local:<path>`, `version 0`), que es exactamente lo que queremos en local. Así se reusa
   para hidratar sesiones locales (no hace falta una función nueva).
6. `closeSession` (`722`): `rt.index.clear()` → `rt.index?.clear()`.

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 4 — `store.ts`: ciclo de vida y conexión de la sesión local

1. `openSession` (`622`): rutear local **antes** de construir el `BridgesApi`:
   ```ts
   export async function openSession(opts: { vault: string; serverUrl?: string | null; token?: string }) {
     if (runtimes.has(opts.vault)) return;
     if (opts.serverUrl === null) {
       await openLocalSession(opts.vault);
       return;
     }
     // … resto del openSession remoto, sin cambios …
   }
   ```
2. Agregar la apertura local (sin health/reconcile/whoami/SSE/flush):
   ```ts
   /** Abre una sesión LOCAL: disco como verdad, store como espejo. Sin server. */
   async function openLocalSession(vault: string) {
     const rt: SessionRuntime = {
       vault, api: null, index: null, flushing: false, bulkConfirmed: false,
       unsubscribe: null, unwatch: null, debounce: new Map(),
     };
     runtimes.set(vault, rt);
     setState("sessions", vault, { ...freshSession(vault, ""), local: true });
     await hydrateFromDisk(rt);                 // index null → ids local:<path>
     setState("sessions", vault, "ready", true);
     await startWatch(vault, vault);            // watcher; el dispatch local va en Step 5
   }
   ```
3. `connect` (`744-749`): respetar `serverUrl === null` (no aplicarle DEFAULT_SERVER):
   ```ts
   export async function connect(opts: { vault: string; serverUrl?: string | null; token?: string }) {
     await openSession(opts);
     setState("activeVault", opts.vault);
     const serverUrl = opts.serverUrl === null ? null : (opts.serverUrl ?? DEFAULT_SERVER).replace(/\/$/, "");
     await persistConnection(opts.vault, serverUrl, opts.token);
   }
   ```
4. `persistConnection` (`805`): firma `serverUrl: string | null`; guardar tal cual (el objeto
   `Connection` ya acepta null tras Step 2).
5. Helper público para el dialog:
   ```ts
   /** Elige una carpeta y la abre como vault LOCAL (sin server ni token). false si se canceló. */
   export async function connectLocal(): Promise<boolean> {
     const vault = await pickVault();
     if (!vault) return false;
     await connect({ vault, serverUrl: null });
     return true;
   }
   ```
   (`pickVault` ya está importado de `./tauri`.)

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 5 — `store.ts`: mutaciones locales + watcher local

1. **`saveDoc`** (`943`): rutear local arriba de todo, después de obtener `rt`:
   ```ts
   const rt = activeRuntime();
   if (!rt) return { denied: true };
   if (rt.api === null) return localSave(rt, doc);
   // … resto remoto …
   ```
   `localSave` (id siempre `local:<path>`; si cambió el path = move, borra el archivo viejo en disco):
   ```ts
   async function localSave(rt: SessionRuntime, doc: { id?: string; path: string; title?: string; content: string }): Promise<SaveOutcome> {
     await vaultWrite(rt.vault, doc.path, doc.content);
     const id = `local:${doc.path}`;
     // ¿move? (vino con id viejo y el path cambió) → borrar el archivo + doc viejo
     if (doc.id && doc.id !== id) {
       const oldPath = doc.id.startsWith("local:") ? doc.id.slice("local:".length) : null;
       if (oldPath) await vaultRemove(rt.vault, oldPath).catch(() => {});
       setState("sessions", rt.vault, "docs", doc.id, undefined!);
     }
     const newDoc: Doc = {
       id, path: doc.path, title: doc.title ?? null, content: doc.content,
       version: 0, seq: 0, deleted: 0, updated_by: DEFAULT_AUTHOR, updated_at: now(),
     };
     setState("sessions", rt.vault, "docs", id, newDoc);
     return { ok: true, doc: newDoc };
   }
   ```
   > `moveDoc`/`renameFolder` ya rutean por acá (llaman `saveDoc` con `id` + path nuevo): el move
   > de archivo y la limpieza del doc viejo ocurren dentro de `localSave`. No tocar `moveDoc`.
2. **`deleteDoc`** (`1010`): rutear local arriba:
   ```ts
   const rt = activeRuntime();
   if (!rt) return;
   if (rt.api === null) return localDelete(rt, id);
   // … resto remoto …
   ```
   ```ts
   async function localDelete(rt: SessionRuntime, id: string) {
     const target = state.sessions[rt.vault].docs[id];
     if (!target) return;
     await vaultTrash(rt.vault, target.path);   // a la papelera del SO
     setState("sessions", rt.vault, "docs", id, undefined!);
   }
   ```
   (Importar `vaultTrash` de `./tauri`.)
3. **Watcher** `scheduleExternal` (`864-873`): en el timeout, rutear por tipo de sesión:
   ```ts
   setTimeout(() => {
     rt.debounce.delete(path);
     const fn = rt.api === null ? localApplyExternal(rt, path) : enqueuePush(rt, path);
     fn.catch((e) => setNotice(`Error al sincronizar ${path}: ${e}`));
   }, 400);
   ```
   ```ts
   /** Cambio externo en un vault local: re-lee el archivo al store (eco suprimido por contenido). */
   async function localApplyExternal(rt: SessionRuntime, path: string) {
     const content = await vaultRead(rt.vault, path);
     const id = `local:${path}`;
     if (content == null) {                       // borrado/movido afuera
       setState("sessions", rt.vault, "docs", id, undefined!);
       return;
     }
     const cur = state.sessions[rt.vault].docs[id];
     if (cur && cur.content === content) return;  // eco de nuestra propia escritura
     setState("sessions", rt.vault, "docs", id, {
       id, path, title: cur?.title ?? null, content,
       version: 0, seq: 0, deleted: 0, updated_by: DEFAULT_AUTHOR, updated_at: now(),
     });
   }
   ```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 6 — `store.ts`: búsqueda local (pura, testeable)

Agregar una función pura (no depende del store) que App usa para vaults locales:
```ts
/** Búsqueda léxica en memoria para vaults locales (insensible a acentos/mayúsculas). */
export function localSearch(docs: Doc[], q: string): SearchHit[] {
  const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const nq = norm(q).trim();
  if (!nq) return [];
  const scored: { hit: SearchHit; score: number }[] = [];
  for (const d of docs) {
    const nTitle = norm(d.title ?? "");
    const nPath = norm(d.path);
    const nContent = norm(d.content);
    const cHits = nContent.split(nq).length - 1;
    const score = (nTitle.includes(nq) ? 3 : 0) + (nPath.includes(nq) ? 2 : 0) + (cHits > 0 ? 1 + Math.min(cHits, 5) : 0);
    if (score === 0) continue;
    const at = nContent.indexOf(nq);
    const snippet =
      at >= 0 ? d.content.slice(Math.max(0, at - 30), at + nq.length + 60).replace(/\s+/g, " ").trim() : "";
    scored.push({ hit: { id: d.id, path: d.path, title: d.title, snippet }, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 50).map((s) => s.hit);
}
```
(Importar `SearchHit` de `./api` — `Doc` ya está importado.)

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 7 — `App.tsx`: búsqueda + gating de UI server-only + reselección en move

1. **Búsqueda** `onSearch` (`606-619`): rutear local vs server.
   ```ts
   searchTimer = setTimeout(async () => {
     try {
       const sess = active();
       const results = sess?.local ? localSearch(Object.values(sess.docs), q) : (await activeApi()?.search(q)) ?? [];
       setHits(results);
     } catch { setHits([]); }
   }, 300);
   ```
   Importar `localSearch` de `~/lib/store`.
2. **`SyncStatus`** (`274-303`): si `s()?.local`, mostrar un badge "Local" (icono `HardDrive` de
   `lucide-solid`) en vez del bloque online/conectado/seq. Envolver el bloque existente en
   `<Show when={!s()?.local}>` y agregar `<Show when={s()?.local}>… Local …</Show>`.
3. **Botones topbar**:
   - Papelera (`793`): `<Show when={s()?.perms.write && !s()?.local}>`.
   - API keys (`803`): `<Show when={!s()?.local && (!s()?.authEnabled || s()?.role === "admin")}>`.
   - Sincronizar (`808`): envolver en `<Show when={!s()?.local}>`.
   - Vaults (`798`, gate `isOwner`) y Role badge (`773`, gate `authEnabled`): ya quedan ocultos en
     local (`isOwner` y `authEnabled` son false). No tocar.
4. **Command palette** (`commands()`):
   - `sync` (`689`): solo si `!s()?.local`.
   - `trash` (`692`): condición `s()?.perms.write && !s()?.local`.
   - `tokens` (`694`): condición `!s()?.local && (!s()?.authEnabled || s()?.role === "admin")`.
5. **Switcher**: `vaultSyncLabel` (`114-122`): al inicio, `if (state.sessions[vault]?.local) return "local";`.
   `VaultSyncDot` (`124-144`): si `sess()!.local`, mostrar un punto neutro (`bg-muted-foreground/60`)
   en vez del semáforo online/connected.
6. **Reselección en move** `onRenameSubmit` (`574-577`): en local el id cambia con el path, así que
   reseleccionar el doc nuevo (no-op en remoto, donde el id no cambia):
   ```ts
   if (t.kind === "file" && t.docId) {
     const res = await moveDoc(t.docId, newPath);
     if (res && "ok" in res) setSelectedId(res.doc.id);
   } else if (t.kind === "folder") await renameFolder(t.path, newPath);
   ```

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 8 — `AddVaultDialog.tsx`: toggle "Con servidor / Local"

En `client/src/components/AddVaultDialog.tsx`:
1. Agregar un signal de modo: `const [local, setLocal] = createSignal(false);` y resetearlo a `false`
   en el `createEffect` de apertura (`30-37`).
2. Arriba de los campos, un toggle de dos opciones (mismo patrón visual que el switch Editor/Grafo
   de la topbar, o dos `Button` variant): "Con servidor" / "Local (sin servidor)".
3. Cuando `local()`:
   - Ocultar los inputs de Servidor y Token (envolver en `<Show when={!local()}>`).
   - El botón principal pasa a "Elegir carpeta" y llama:
     ```ts
     const addLocal = async () => {
       setBusy(true); setErr(null);
       try {
         const ok = await connectLocal();
         if (!ok) setErr("No elegiste ninguna carpeta.");
         else props.onOpenChange(false);
       } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
       finally { setBusy(false); }
     };
     ```
   - No hay paso de inspección/colisión: si la carpeta ya tiene `.md`, aparecen y listo.
4. La descripción del dialog en modo local: "Vault local: los archivos viven solo en tu disco, sin
   servidor ni token." Importar `connectLocal` de `~/lib/store`.

**Verify**: `cd client && bunx tsc --noEmit` → exit 0.

### Step 9 — Tests: búsqueda local

Crear `client/src/lib/localSearch.test.ts` (modelar en `reconcile.test.ts`). Casos:
- match en título rankea por encima de match solo en contenido;
- insensible a acentos (`"accion"` matchea `"acción"`) y a mayúsculas;
- query vacía → `[]`;
- doc sin match no aparece; el `snippet` contiene el término.

Construir `Doc`s mínimos a mano (helper local) y llamar `localSearch(docs, q)`.

**Verify**: `cd client && bun run test` → all pass.

### Step 10 — README + plans/README

1. `README.md`: en "### Resuelto" o en la tabla de estado, agregar una línea sobre vaults locales
   (crear vault sin server/token; borrado a la papelera del SO; búsqueda en memoria).
2. `plans/README.md`: agregar la fila de la tabla para el plan 010 y marcar el estado.

**Verify**: `grep -n "local" README.md` muestra la mención; `git status` no muestra archivos fuera de scope.

## Test plan

- **`localSearch`**: unit (Step 9) — es pura.
- **Rust `vault_trash`**: `cargo check` (Step 1); verificación funcional en el smoke manual.
- **Resto** (ciclo de vida, mutaciones, watcher, UI): smoke manual en `tauri dev` (abajo). El motor
  remoto se cubre solo: las guardas del Step 3 garantizan que una sesión local nunca lo ejecuta, y
  los tests de `reconcile` existentes siguen pasando (no se tocó la lógica remota).

### Smoke manual (`cd client && bun run tauri dev`)

1. "Agregar vault" → toggle "Local" → elegir una carpeta vacía → conecta sin pedir server/token.
2. El badge de estado muestra "Local"; no aparecen botones de Papelera/API keys/Sincronizar.
3. Crear una nota, editarla, guardarla → aparece el `.md` en la carpeta (verificar en Finder).
4. Renombrar la nota desde el árbol → el archivo se renombra en disco y el editor sigue en esa nota.
5. Buscar un término → aparecen resultados (búsqueda en memoria).
6. Borrar una nota → desaparece del árbol y el `.md` está en la Papelera del SO (recuperable).
7. Editar un `.md` desde afuera (Zed/Finder) → el cambio aparece en la app (watcher).
8. Cerrar y reabrir la app → el vault local se reabre solo, sin pedir server.
9. Abrir además un vault **con server** en otra pestaña del switcher → sigue sincronizando normal
   (el modo local no afectó al remoto).

## Done criteria

- [ ] `cd client/src-tauri && cargo check` exits 0 (con `vault_trash` registrado).
- [ ] `cd client && bunx tsc --noEmit` exits 0.
- [ ] `cd client && bun run test` passes (incl. `localSearch.test.ts`).
- [ ] Smoke manual: los 9 pasos de arriba pasan.
- [ ] Un vault con server sigue funcionando igual (paso 9).
- [ ] No files outside scope modified (`git status`).
- [ ] `plans/README.md` + `README.md` actualizados.

## STOP conditions

Stop and report back if:

- El crate `trash` falla al compilar en la plataforma del executor (Linux headless puede necesitar
  features extra) — reportar; alternativa: mover a `.bridges/trash/` con `fs::rename` (papelera in-app
  mínima) en vez de la papelera del SO.
- Las guardas del Step 3 dejan errores de strict-null que requieren `!` en más de los puntos
  listados — reportar el conjunto real antes de seguir (puede indicar un call-site remoto no listado).
- El watcher local entra en loop (escritura → evento → escritura) — la supresión por contenido en
  `localApplyExternal` debería evitarlo; si pasa, reportar (probablemente `localSave` no está
  seteando el store con el mismo contenido exacto que se escribió a disco).
- Reabrir la app no restaura el vault local — verificar que `boot()` pasa `serverUrl: null` desde la
  `Connection` guardada a `openSession` (no debe colapsarse a DEFAULT_SERVER en ningún punto).

## Maintenance notes

- `store.ts` crece con el camino local. Si en el futuro se extrae el motor de sync a su módulo
  (tech-debt ya anotado en `plans/README.md`), el camino local es candidato natural a un
  `localBackend.ts` separado — pero no ahora (YAGNI; el branch en ~6 puntos es manejable).
- Los ids locales (`local:<path>`) cambian al renombrar; `onRenameSubmit` reselecciona el doc. Un
  rename de **carpeta** con un doc seleccionado adentro puede dejar la selección obsoleta (caso
  menor, no cubierto; el árbol se ve bien igual).
- `localSearch` recorre todos los docs por query; a varios miles de notas sigue siendo ms. Si algún
  día molesta, es el mismo techo que el de los vaults con server (todo el vault en el store).
