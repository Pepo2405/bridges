# Papelera + guardia anti-vaciado — Design

**Fecha:** 2026-06-01
**Proyecto:** Bridges (server Bun + bun:sqlite, cliente SolidJS + Tauri)

## Contexto

Hoy el borrado de documentos en el server ya es *soft delete*: `deleteDoc` (`server/src/db.ts`)
marca la fila con `deleted=1`, **conserva el `content`** y borra sólo el `.md` del disco. Existe
además un log inmutable `changes` (create/update/delete con autor y fecha) y un `HistoryDialog`
en el cliente con diff + restaurar versión. **No existe ningún hard-delete en ningún lado**, así
que el contenido nunca se pierde de la BD.

El problema: un doc borrado es **invisible** y no hay forma de recuperarlo desde la UI. Y no hay
ninguna red de seguridad ante un borrado masivo accidental (p. ej. un cliente buggy que flushea
muchos `DELETE` seguidos). El contenido seguiría recuperable en la BD, pero el vaciado se
propagaría a las réplicas locales de todos los clientes sin fricción.

Objetivo: (1) una **papelera** para ver/restaurar/purgar borrados, y (2) una **guardia
anti-vaciado** en el server que frene un borrado masivo hasta confirmación humana.

## Modelo de datos — sin cambios de schema

No se crea tabla nueva. Los borrados ya viven en `documents` con `deleted=1` y `content` intacto;
`changes` ya registra el `delete` con autor/fecha. Se agrega:
- Una query para listar borrados del vault.
- `"restore"` al conjunto de valores de `changes.action` (hoy `"create" | "update" | "delete"`).

## Server

### Endpoints nuevos (`server/src/index.ts` + `server/src/db.ts`)

| Método + ruta | Permiso (`permFor`) | Comportamiento |
|---|---|---|
| `GET /trash` | read (viewer+) | Lista docs con `deleted=1` del vault: `id, path, title, updated_by, updated_at, seq`. Sin `content` (listado liviano). |
| `POST /documents/:id/restore` | write (editor+) | `deleted=1→0`, bump `seq`, reescribe el `.md` con el `content` guardado, registra change `action:"restore"`, `broadcastChange`. El path nunca colisiona: `UNIQUE(vault, path)` lo mantiene reservado mientras está borrado, así que ningún otro doc vivo puede ocuparlo. Si no existe o no es del vault → 404; si ya está vivo → idempotente. |
| `DELETE /trash/:id` | delete (admin) | **Hard-delete**: borra la fila de `documents` y sus filas en `changes`. Sólo de a uno (no hay "vaciar todo"). 404 si no existe. |

El mapeo método→permiso ya lo hace `permFor()` en `index.ts`: `DELETE→delete`, `POST→write`,
`GET→read`. Las rutas nuevas caen en ese esquema sin tocar `checkAuth`.

### `restore` en `db.ts`

Nuevo `db.transaction` espejando `deleteDoc`:
1. `getDoc(id)`; validar `vault`. Si ya está vivo → idempotente (devuelve el doc).
2. `seq = qNextSeq`; `UPDATE documents SET deleted=0, version=version+1, seq=?, updated_by=?, updated_at=?`.
3. `qChange.run({ action: "restore", content: <content actual> })`.
4. `writeDoc(vault, path, content)` para recrear el `.md`.
5. return `getDoc(id)`.

(No hace falta chequear colisión de path: `UNIQUE(vault, path)` lo reserva mientras
está borrado, así que ningún otro doc vivo puede haberlo tomado.)

### `purge` (hard-delete) en `db.ts`

`db.transaction` que borra `changes WHERE doc_id=?` y `documents WHERE id=?` (en ese orden por la
FK). No incrementa `seq` ni hace broadcast (el doc ya no está vivo; las réplicas no lo tienen).

## Guardia anti-vaciado — circuit breaker en el server

- Estado en memoria por vault: `Map<vault, number[]>` con timestamps (`Date.now()`) de soft-deletes
  recientes. Se podan los más viejos que la ventana en cada chequeo.
- En el handler de `DELETE /documents/:id` (soft-delete), **antes** de llamar a `deleteDoc`:
  - Si el header `x-confirm-bulk: true` está presente → saltear el breaker, registrar el delete.
  - Si no, contar deletes en la ventana. Si `count >= LIMIT` → responder **429**
    `{ error, code: "bulk_delete_guard", recent: count, limit: LIMIT }` **sin** borrar.
  - Si pasa, registrar el timestamp y proceder.
- Config por env: `BRIDGES_DELETE_LIMIT` (default **10**), `BRIDGES_DELETE_WINDOW` segundos (default **60**).
- Aplica **sólo** a soft-delete (vector real del vaciado). El hard-delete de papelera ya es
  admin + de a uno.

Vive como un módulo chico (`server/src/guard.ts`) con `canDelete(vault): boolean` y
`recordDelete(vault)`, o inline en `index.ts` si queda simple. El estado en memoria se resetea al
reiniciar el server (aceptable para un breaker).

## Cliente

### API (`client/src/lib/api.ts`)

- `trash(): Promise<TrashItem[]>` → `GET /trash`.
- `restore(id): Promise<Doc>` → `POST /documents/:id/restore`.
- `purge(id): Promise<void>` → `DELETE /trash/:id`.
- `remove(id, author?, confirmBulk?)`: agregar param para mandar `x-confirm-bulk: true`.

### Manejo del breaker (`client/src/lib/store.ts`)

En el flush de borrados (`pushOne` cuando `entry.deleted`): si `remove()` devuelve
`429 code:"bulk_delete_guard"`:
1. Frenar el flush de borrados (no reintentar en loop).
2. Setear estado `pendingBulkDelete` con el conteo de borrados pendientes.
3. Mostrar diálogo de confirmación ("Se detectó un borrado de N notas. ¿Confirmás?").
4. Al **confirmar** → reintentar los deletes pendientes con `confirmBulk=true`.
5. Al **cancelar** → quedan pendientes (no se pierden); el usuario investiga. (Los `.md` locales ya
   no están porque el usuario los borró; la confirmación sólo gobierna la propagación al server.)

### UI papelera (`client/src/components/TrashDialog.tsx`, nuevo)

- Diálogo espejando `VaultManager`/`HistoryDialog`: lista de borrados (título, path, fecha, autor).
- Botón **Restaurar** (visible con write / editor+).
- Botón **Borrar definitivo** (visible sólo admin/owner) con confirmación vía `ConfirmHost`.
- Acceso: comando en Cmd+K **"Papelera"** + ícono `Trash2` en la topbar, visible cuando el rol
  permite write.
- Tras restaurar, el `broadcastChange` del server trae el doc de vuelta vía el sync normal →
  reaparece en el árbol y en disco sin lógica extra en el cliente.

## Verificación

### Tests de server (`server/test/api.test.ts`)
- restore trae el doc de vuelta: `deleted=0`, `.md` reescrito en disco, `seq` nuevo, change `restore`.
- restore de doc inexistente → 404.
- hard-delete (`DELETE /trash/:id`) saca la fila de `documents` y `changes`.
- breaker: tras `LIMIT` deletes dentro de la ventana, el siguiente → 429 `bulk_delete_guard`.
- `x-confirm-bulk: true` saltea el breaker.
- permisos: viewer no puede restaurar (403); editor no puede purgar (403).

### E2E manual (app Tauri)
- Borrar una nota → aparece en Papelera → Restaurar → reaparece en el árbol y en `~/.../vault/`.
- Borrar 11 notas seguidas → diálogo de confirmación de borrado masivo.

## Fuera de alcance (YAGNI)
- "Vaciar toda la papelera" (reintroduce el riesgo de vaciado).
- Retención/purga automática por cron.
- Versionado más profundo (ya cubierto por `changes` + `HistoryDialog`).
