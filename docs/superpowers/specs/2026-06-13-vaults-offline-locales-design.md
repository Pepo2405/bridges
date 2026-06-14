# Vaults offline (locales, sin token ni servidor) — Design

**Fecha:** 2026-06-13
**Proyecto:** Bridges (server Bun + bun:sqlite, cliente SolidJS + Tauri)

## Contexto

Hoy un vault siempre es una **conexión** a un servidor: `Connection = { vault, serverUrl, token?, openedAt }`
(`client/src/lib/tauri.ts`). El `AddVaultDialog` obliga a poner un `serverUrl`. La fuente de verdad
es el server; el cliente replica los `.md` a disco y sincroniza con `/sync` + SSE, con un motor
offline-first (índice `.bridges/index.json`, cola dirty, 3-way merge) en `store.ts`.

Ya existe un **modo offline degradado**: si el server no responde, `openSession` hidrata desde disco
(`hydrateFromDisk`) y encola cambios para cuando vuelva. Pero es un *estado caído* de una conexión
que igual apunta a un server — no un vault local de primera clase.

**Objetivo:** poder **crear un vault totalmente local, sin token ni servidor, nunca**. Elegís una
carpeta y listo: el disco es la verdad y el store su espejo directo. Es valioso porque la mayor
parte de la app ya es client-side (árbol, editor, preview, wikilinks, backlinks, grafo se computan
de los `docs` en RAM) y no necesita server para nada de eso.

### Qué es server-dependiente y cómo se resuelve en local

| Capacidad | En vault con server | En vault local |
|---|---|---|
| Sync (pull/SSE/flush/reconcile/merge) | motor actual | no aplica (disco = verdad) |
| Búsqueda | `/search` FTS5 (BM25) | **scan en memoria** sobre los docs ya cargados |
| Borrado | papelera server-side (soft delete) | **papelera del SO** (Finder/Explorer/Trash) |
| Historial/versionado | `changes` + `HistoryDialog` | no hay (red de seguridad: papelera del SO) |
| Tokens / vaults server-side | gestores en la UI | ocultos |
| Atribución de autor | nombre del token | `"yo"` (sin auth) |

## Enfoque: camino local aislado, ruteado en los puntos de entrada

El motor de sync remoto queda **intacto**. El `SessionRuntime` lleva `api: BridgesApi | null`; las
funciones públicas rutean según `rt.api == null`: local → camino simple (disco), remoto → motor
actual. La lógica local es chica porque no tiene sync, índice ni merge. El branch vive en ~6 puntos
definidos (`openSession`, `saveDoc`, `deleteDoc`, `moveDoc`, búsqueda, watcher dispatch), no
esparcido.

Descartados: (A) `if (local)` dentro del motor → ensucia y dispersa branches en algo que ya anda;
(B) abstracción `VaultBackend` con dos implementaciones → refactor grande y riesgoso del motor de
sync para dos backends donde uno es trivial.

## Modelo de datos — discriminador local

Una conexión es local cuando **no tiene server**:

```ts
// client/src/lib/tauri.ts
type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string };
// serverUrl === null  ⇒  vault local
```

Backward-compatible: las conexiones guardadas existentes tienen `serverUrl` string. La `Session`
(`store.ts`) gana `local: boolean` para gatear la UI. El `SessionRuntime` lleva
`api: BridgesApi | null` e `index: IndexHandle | null` (ambos `null` en local).

## Ciclo de vida de una sesión local (`store.ts`)

`openSession` rutea por `serverUrl == null`:

- **Local**: crea runtime con `api/index = null`, hace `hydrateLocal(rt)` (lee los `.md` de disco al
  store, `id = "local:<path>"`), arranca el watcher, `ready = true`. **No** hay health / reconcile /
  whoami / SSE / flush.
- **Remoto**: el camino actual, sin cambios.

Estado inicial de una sesión local: `local: true, online: true, connected: false,
authEnabled: false, perms: { write: true, delete: true }, role: null, author: "yo"`.

**Watcher** (ya existe; emite `vault-change` por connId, despachado por el listener global): para
sesiones locales, cada path cambiado se re-lee y se hace upsert en el store; si el archivo ya no
está, se saca del store. **Eco** de nuestras propias escrituras suprimido comparando el contenido
nuevo contra el doc en el store (igual ⇒ no-op). Sin índice ni `synced_hash`.

`boot()` abre las conexiones locales igual que las remotas (un `serverUrl == null` simplemente toma
el camino local). `closeSession` corta watcher y limpia store (no hay SSE que cortar en local).

## Mutaciones (camino local)

Las funciones públicas rutean según `rt.api == null`:

- **`saveDoc`**: escribe el `.md` a disco, upsert del doc en el store (`local:<path>`). Sin
  versión/seq/conflicto. Devuelve `{ ok: true, doc }`.
- **`deleteDoc`**: mueve el `.md` a la **papelera del SO** (comando Rust nuevo `vault_trash`), saca
  el doc del store. (No pasa por la guardia anti-vaciado: esa es del server.)
- **`moveDoc` / `renameFolder` / `deleteFolder`**: escriben el path nuevo y borran/mueven el viejo
  en disco, actualizan el store. (`renameFolder`/`deleteFolder` ya iteran sobre `moveDoc`/`deleteDoc`,
  así que heredan el ruteo.)

No hay cola dirty, ni 3-way merge, ni `applyDocs`/índice en el camino local: el disco es la verdad y
el store su espejo directo. El `id` de un doc local es `local:<path>`; al renombrar, el `id` cambia
con el path (la reselección la maneja `App.tsx`, igual que hoy). Rename externo = delete + add
(limitación aceptada, idéntica a la del modo server).

## Búsqueda local

`localSearch(sess, q): SearchHit[]` recorre `sess.docs` (ya en RAM — el contenido completo del vault
está cargado en el store con o sin server) y rankea por dónde matchea (título > path > contenido) y
cantidad de ocurrencias, insensible a acentos/mayúsculas. Devuelve el mismo shape `SearchHit[]` que
`api.search`, así el resto de la UI no cambia.

En `App.tsx` (búsqueda, ~línea 614): si `active().local` → `localSearch`; si no → `activeApi().search`
(FTS5 actual). El costo de RAM extra es ~cero (reusa lo que ya está cargado); el techo de escala es
el mismo que el de los vaults con server (cargar todo el vault al store).

## UI

- **`AddVaultDialog`**: toggle "Con servidor / Local (sin servidor)". En local: solo el botón
  "Elegir carpeta" (sin campos de server/token, sin paso de inspección/colisión — si la carpeta ya
  tiene `.md`, aparecen y listo). Al conectar, persiste una `Connection` con `serverUrl: null`.
- **Gating cuando `active().local`**:
  - Badge de estado: muestra **"local"** en vez de online / en vivo / `seq`.
  - Ocultos: gestor de tokens (`TokenManager`), gestor de vaults server-side (`VaultManager`),
    historial (`HistoryDialog`, no hay versiones), papelera server-side (`TrashDialog`).
  - Badges de rol / autor / permisos ocultos (no hay auth).
- **Se mantiene**: árbol, editor, preview, grafo, backlinks, búsqueda (local), operaciones de
  archivo (renombrar/mover/eliminar/nueva nota/carpetas).

## Rust (`client/src-tauri/src/lib.rs`)

Un comando nuevo:

```rust
#[tauri::command]
fn vault_trash(vault: String, path: String) -> Result<(), String>
```

Mueve `vault/path` a la papelera del SO con el crate `trash` (cross-platform: Finder / Papelera de
reciclaje / Trash de Linux). Se registra en el `invoke_handler`. El resto (`vault_write/read/scan`,
`start_watch`/`vault-change`, `config_load/save`) ya existe y se reusa. En local **no** se usan
`state_*` ni `index_*`.

`client/src/lib/tauri.ts` agrega el wrapper `vaultTrash(vault, path)` (con stub no-op/borrado en
memoria para el modo browser).

## Fuera de alcance (anotado, no se construye)

- **Promoción local→server**: ya cubierta por "Agregar vault" sobre la misma carpeta con server +
  token; el flujo de inspección (`pickVaultAndInspect`) detecta las notas locales y las importa.
- **Historial/versionado y papelera in-app** para local: la red de seguridad es la papelera del SO.
- **SQLite en el cliente**: se mantiene la decisión "cliente sin SQLite".
- **MCP `search_vault`** para vaults locales: es una capacidad del server; Claude Code igual lee y
  grepea los `.md` de la carpeta nativo.

## Tests (Vitest, ya configurado en el cliente)

- `localSearch`: ranking (título > path > contenido) y matching insensible a acentos.
- Mutaciones locales (`saveDoc`/`deleteDoc`/`moveDoc`): reflejan disco↔store correctamente, sin
  tocar el motor de sync.
- Watcher local: supresión de eco por comparación de contenido.

## Criterios de éxito

1. Crear un vault local desde `AddVaultDialog` sin escribir server ni token, eligiendo una carpeta.
2. Crear/editar/renombrar/mover notas y carpetas en ese vault, reflejadas en disco y en la UI.
3. Borrar una nota la manda a la papelera del SO (recuperable desde Finder/Explorer).
4. La búsqueda funciona offline sobre el vault local.
5. Reabrir la app restaura el vault local (persistido con `serverUrl: null`) sin pedir server.
6. El árbol, preview, grafo y backlinks funcionan sin servidor.
7. El motor de sync de los vaults con server queda sin cambios de comportamiento.
