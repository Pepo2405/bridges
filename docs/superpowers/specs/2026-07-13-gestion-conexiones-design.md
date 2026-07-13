# Gestión de conexiones (editar / desconectar / quitar / ver token) — Design

**Fecha:** 2026-07-13
**Proyecto:** Bridges (server Bun + bun:sqlite, cliente SolidJS + Tauri)

## Contexto

Un "vault" en la UI es una **conexión** guardada: `Connection = { vault, serverUrl, token?, openedAt }`
(`client/src/lib/tauri.ts`). El token vive en el **keychain del SO** (Tauri) vía `secretSet`/`secretGet`/
`secretDelete`; en modo browser vive en el JSON de config (memoria) por conveniencia de dev.

Hoy la gestión de conexiones está incompleta. Lo que existe:

- **Agregar** (`AddVaultDialog`): server/token + carpeta, o vault local.
- **Quitar** (`removeConnection` en `store.ts`): cierra la sesión + borra la conexión del config +
  borra el token del keychain. **Pero solo está cableado en el picker de estado vacío**
  (`ConnectionManager` en `App.tsx`, botón `Trash2` "Quitar de la lista"). Una vez que hay un vault
  abierto nunca más se ve ese picker.
- **Switcher in-app** (`App.tsx`, `DropdownMenu` al pie del árbol): solo **cambiar de vault** y
  **agregar**. No hay editar, ni quitar, ni desconectar, ni ver el token.

Lo que falta (pedido del usuario):

1. **Editar** una conexión (URL del server, token/api key, y un nombre visible).
2. **Desconectar** una conexión (cerrar la sesión, sin borrarla de la lista) — distinto de **Quitar**
   (borrarla de la lista + keychain).
3. **Ver las api keys guardadas** (el token por conexión, que hoy se guarda y nunca más se puede ver).

Las tres cosas son la misma carencia: no hay una superficie de gestión de conexiones.

## Objetivo

Una superficie única para gestionar las conexiones guardadas: editar (nombre/URL/token con el token
**revelable + copiable**), **Desconectar** (cerrar la sesión, sigue en la lista) y **Quitar** (borrar
de la lista + keychain). Accesible desde el switcher in-app y desde el picker de estado vacío.

## Modelo de datos — nombre visible custom

Un solo cambio de schema, backward-compatible:

```ts
// client/src/lib/tauri.ts
type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string; name?: string };
//                                                                                              ^^^^^ nuevo
```

`name` opcional: nombre visible elegido por el usuario. Las conexiones guardadas existentes (sin
`name`) siguen funcionando: la etiqueta cae al comportamiento actual.

### Resolución de la etiqueta

Precedencia nueva del nombre visible de un vault:

1. `connection.name` (si el usuario lo puso), si no
2. `remoteVaultName @ host` (sesión abierta que reportó su vault server-side), si no
3. basename de la carpeta (`vaultName(path)`).

En `App.tsx`:

- `vaultName(path)` queda **puro** (basename), como hoy.
- `vaultLabel(path)` (topbar + switcher) antepone `connName(path)`, un helper nuevo que busca
  `state.connections.find(c => c.vault === path)?.name`. Queda:
  `connName(path) ?? (sesión.remoteVaultName ? \`${name} @ ${host}\` : vaultName(path))`.
- La fila del picker de estado vacío (que hoy usa `vaultName(conn.vault)`) pasa a
  `conn.name ?? vaultName(conn.vault)`.

## Store (`client/src/lib/store.ts`)

### `updateConnection` (nueva)

```ts
export async function updateConnection(
  vault: string,
  patch: { name?: string; serverUrl?: string | null; token?: string },
): Promise<void>
```

Semántica (campos ausentes en `patch` se mantienen; presentes se aplican, incluido `""`):

1. Toma la conexión actual (`state.connections`) y el token actual (`secretGet(vault)` en Tauri; en
   browser, el `token` del config).
2. Calcula `nextServerUrl`, `nextName`, `nextToken`.
3. **Persiste** (invariante keychain-antes-de-JSON, igual que `persistConnection`): si
   `nextServerUrl !== null`, `secretSet(vault, nextToken)` o `secretDelete(vault)` si vacío. Actualiza
   la `Connection` en el config (con `name`; `openedAt` preservado; token en el JSON **solo** en
   browser) y `state.connections`. No cambia `lastVault`.
4. **Reconecta solo si hace falta**: `credsChanged = nextServerUrl !== cur.serverUrl || nextToken !==
   curToken`. Si la sesión está abierta (`runtimes.has(vault)`) y `credsChanged`:
   `await closeSession(vault); await openSession({ vault, serverUrl: nextServerUrl });` (openSession
   lee el token nuevo del keychain vía `secretGet`). Preserva el foco: si el vault era `activeVault`,
   se reasigna después de reabrir. Un error de `openSession` (token inválido, server caído) **se
   propaga** para que el diálogo lo muestre; la conexión queda cerrada pero guardada (reintentable).
   Cambio de solo-nombre **no** reconecta.

Nota: `openSession` es idempotente (`if (runtimes.has(vault)) return`), por eso el reconnect es
`closeSession` + `openSession`, no `openSession` a secas.

### Reusadas (ya existen y se exportan)

- **`closeSession(vault)`** = **Desconectar**: corta SSE + watcher, limpia runtime + store, reasigna
  el foco si era la activa. La `Connection` queda intacta en el config (sigue en la lista).
- **`removeConnection(vault)`** = **Quitar**: `closeSession` + borra la conexión del config + borra
  el token del keychain.

## UI

Patrón **Dialog** (consistente con `VaultManager`/`TokenManager`/`AddVaultDialog`; no se introduce
`Sheet` para no crear una segunda convención en el proyecto). Dos componentes nuevos en
`client/src/components/`:

### `ConnectionsDialog.tsx`

Home de gestión. Lista `state.connections`; cada fila muestra:

- Etiqueta (`conn.name ?? vaultName(conn.vault)`), `serverUrl ?? "local"`, y estado
  (abierta/cerrada — `state.sessions[conn.vault]` — con un dot de sync reusando el patrón existente).
- Un menú `⋮` (`DropdownMenu`) por fila:
  - **Editar** → setea `editVault` (abre `EditConnectionDialog`).
  - **Desconectar** → `closeSession(conn.vault)`. `Show when={state.sessions[conn.vault]}` (solo si
    hay sesión abierta).
  - **Quitar** → confirmación con `askConfirm` (confirm estilado ya existente en `~/lib/confirm`,
    montado globalmente por `ConfirmHost`; `{ title, description, confirmText: "Quitar", destructive:
    true }`) → si acepta, `removeConnection(conn.vault)`.

Posee el signal `editVault: string | null` y renderiza `EditConnectionDialog` (portaleado por el
Dialog, así no queda anidado en el DOM).

### `EditConnectionDialog.tsx`

Props: `{ vault: string | null; open: boolean; onOpenChange: (o: boolean) => void }`.

Al abrir (por `vault`), carga la conexión actual y el token (`secretGet(vault)`). Campos:

- **Nombre** (`Input`): nombre visible. Placeholder = basename de la carpeta.
- **Server URL** (`Input`): deshabilitado si el vault es local (`serverUrl === null`).
- **Token / api key** (`Input type="password"`): con **revelar** (toggle 👁, `Eye`/`EyeOff`) y
  **copiar** (`Copy`/`Check`, patrón idéntico al de `TokenManager`/`VaultManager`). Deshabilitado si
  el vault es local. **Acá se "ven las api keys guardadas".**

Vault local: solo el nombre es editable; nota "Vault local (sin servidor)". Footer: **Cancelar** /
**Guardar**. Guardar → `updateConnection(vault, { name, serverUrl, token })`; en éxito cierra; en
error (p.ej. token inválido al reconectar) lo muestra inline y no cierra.

### Puntos de entrada

- **Switcher in-app** (`App.tsx`, al pie del `DropdownMenuContent`): ítem nuevo "Gestionar
  conexiones…" → `setShowConnections(true)`, junto al ya existente "Agregar vault…".
- **Picker de estado vacío** (`ConnectionManager`): botón "Gestionar conexiones" (además del "Agregar
  vault" existente), para poder editar/ver token antes de conectar.

App tiene un signal nuevo `showConnections` y renderiza `<ConnectionsDialog>` junto a los otros
diálogos gestionados (`TokenManager`, `VaultManager`, etc.).

## Edge cases

- **Vault local** (`serverUrl === null`): editar solo el nombre; URL/token deshabilitados;
  `updateConnection` con solo `name` no toca keychain ni reconecta.
- **Reconexión con token inválido / server caído**: `openSession` propaga; el diálogo muestra el
  error; la conexión queda cerrada pero guardada (se reintenta desde el mismo diálogo o el switcher).
- **Desconectar el vault activo sin otros abiertos**: `closeSession` deja `activeVault = null` →
  `App` cae al `ConnectionManager` (picker). Esperado.
- **Cambiar `serverUrl` de un vault con notas locales**: la carpeta (key `vault`) no cambia;
  `openSession` reconcilia disco vs el server nuevo (mismo mecanismo que abrir por primera vez).
- **Editar sin cambios de credenciales** (solo nombre, o token/URL idénticos): no reconecta (evita
  cortar el sync porque sí).

## Tests (Vitest, ya configurado en el cliente; modo browser: `isTauri === false`)

En modo browser `secretSet/Get/Delete` usan `memSecrets` (en memoria) y el config usa `localStorage`,
así que la persistencia de `updateConnection` es testeable sin Tauri ni red (sin sesión abierta ⇒ sin
reconnect):

- `updateConnection` con **solo nombre**: la `Connection` en `state.connections`/config gana `name`;
  no toca el token; no reconecta.
- `updateConnection` con **token nuevo**: `secretGet(vault)` (memSecrets) devuelve el nuevo; el config
  se actualiza.
- `updateConnection` con **serverUrl nuevo**: el config y `state.connections` reflejan la URL nueva.
- **Resolución de etiqueta**: con `name` seteado, la etiqueta visible usa `name`; sin `name`, cae al
  basename.

La ruta de **reconexión** (closeSession + openSession, que toca red/health) queda cubierta por el
smoke test manual, no por unit tests (evita mockear `fetch`/health).

## Fuera de alcance (anotado, no se construye)

- Editar la **carpeta** de un vault: cambiar la carpeta es agregar otro vault (la carpeta es la key
  de la conexión). No se soporta editar `vault`.
- Convertir un vault local ↔ con server desde el editor: el flujo de "Agregar vault" ya lo cubre
  (inspección + import). El editor no ofrece togglear `serverUrl` entre `null` y string.
- Gestión de tokens **server-side** (`TokenManager`) y vaults server-side (`VaultManager`): son otra
  cosa (api keys en el server, no la conexión guardada local) y ya existen.

## Criterios de éxito

1. Desde el switcher in-app o el picker de estado vacío se abre "Gestionar conexiones" con la lista.
2. Editar el **nombre** de una conexión cambia la etiqueta visible en switcher/topbar/lista y persiste
   al reabrir la app.
3. Editar la **URL** o el **token** de una conexión abierta reconecta con las credenciales nuevas; un
   token inválido muestra error sin romper la app.
4. El token guardado se **revela y copia** desde el editor.
5. **Desconectar** cierra la sesión y la conexión sigue en la lista (reabrible con un click).
6. **Quitar** (con confirmación) borra la conexión de la lista y su token del keychain; el vault en
   disco queda intacto.
7. Las conexiones guardadas sin `name` (previas a este cambio) siguen abriéndose y mostrándose bien.
