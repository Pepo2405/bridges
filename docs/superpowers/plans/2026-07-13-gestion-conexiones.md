# Gestión de conexiones (editar / desconectar / quitar / ver token) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar una superficie para gestionar las conexiones guardadas del cliente Bridges: editar (nombre / server URL / token con el token revelable+copiable), **Desconectar** (cerrar la sesión, sigue en la lista) y **Quitar** (borrar de la lista + keychain).

**Architecture:** Un campo `name?` opcional en `Connection` (backward-compatible). Una función de store nueva `updateConnection` que persiste al config + keychain y reconecta solo si cambian credenciales. Dos componentes Dialog nuevos (`ConnectionsDialog` lista + acciones; `EditConnectionDialog` formulario), cableados desde el switcher in-app y el picker de estado vacío. `closeSession`/`removeConnection` ya existen y se reusan tal cual.

**Tech Stack:** SolidJS + Tauri 2, `@kobalte/core` (Dialog/DropdownMenu), `lucide-solid`, Vitest (entorno `node`).

**Spec:** `docs/superpowers/specs/2026-07-13-gestion-conexiones-design.md`

## Global Constraints

- **Patrón UI = `Dialog`** (no `Sheet`): consistente con `VaultManager`/`TokenManager`/`AddVaultDialog`. No introducir una segunda convención.
- **Invariante keychain-antes-de-JSON:** al persistir credenciales, escribir el token al keychain ANTES de tocar el JSON de config (igual que `persistConnection`).
- **Token en el JSON solo en browser:** en Tauri (`isTauri === true`) el token NO va al JSON (vive en keychain); en browser sí (memSecrets se pierde al recargar).
- **Reconectar solo si cambian credenciales** (server URL o token). Cambio de solo-nombre no reconecta.
- **Copy del token / reveal:** reusar el patrón exacto de `TokenManager.tsx` (`navigator.clipboard.writeText` + estado `copied` con timeout 1500ms).
- **Confirmación destructiva:** usar `askConfirm` de `~/lib/confirm` (ya montado por `ConfirmHost`), no `confirm()` nativo ni inline.
- **Idioma:** UI y comentarios en español (convención del repo).
- **Verificación por tarea:** `cd client && bun run typecheck`. Tests: `cd client && bun run test`.
- **NO** correr formatters/linters ni la suite completa hasta la tarea de verificación final.

---

### Task 1: Campo `name` en `Connection`

**Files:**
- Modify: `client/src/lib/tauri.ts:129`

**Interfaces:**
- Produces: `type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string; name?: string }` — el `name?` lo consumen Task 2/3/4/5.

- [ ] **Step 1: Agregar el campo**

En `client/src/lib/tauri.ts`, línea 129, cambiar:

```ts
export type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string };
```

por:

```ts
export type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string; name?: string };
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS (sin errores). El campo es opcional → no rompe callsites existentes.

- [ ] **Step 3: Commit**

```bash
git add client/src/lib/tauri.ts
git commit -m "feat(client): campo name opcional en Connection"
```

---

### Task 2: `updateConnection` en el store (TDD)

**Files:**
- Create: `client/src/lib/updateConnection.test.ts`
- Modify: `client/src/lib/store.ts` (agregar función tras `removeConnection`, ~línea 959)

**Interfaces:**
- Consumes: `Connection.name` (Task 1); `configLoad`/`configSave`/`secretGet`/`secretSet`/`secretDelete`/`isTauri` (ya importados en `store.ts`), `state`/`setState`, `runtimes`, `closeSession`, `openSession` (todos en `store.ts`).
- Produces: `export async function updateConnection(vault: string, patch: { name?: string; serverUrl?: string | null; token?: string }): Promise<void>` — la consumen Task 3 (EditConnectionDialog).

- [ ] **Step 1: Escribir el test que falla**

Crear `client/src/lib/updateConnection.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { state, updateConnection } from "~/lib/store";
import { configLoad, configSave, secretGet, secretSet } from "~/lib/tauri";

// updateConnection corre en modo browser (isTauri=false en el entorno "node" de
// Vitest): el token vive en memSecrets y la config en localStorage. Polyfill de
// localStorage porque el entorno node no tiene DOM. Cada test usa un vault único
// (memSecrets es module-scoped y no se resetea entre tests).
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
});

const seed = async (c: { vault: string; serverUrl: string | null; token?: string; name?: string }) => {
  await configSave({ connections: [{ ...c, openedAt: "2026-01-01T00:00:00.000Z" }], lastVault: c.vault });
  if (c.serverUrl !== null && c.token) await secretSet(c.vault, c.token);
};

describe("updateConnection", () => {
  it("cambia solo el nombre: persiste name, no toca el token", async () => {
    const vault = "/v-name";
    await seed({ vault, serverUrl: "http://s", token: "tok" });
    await updateConnection(vault, { name: "Mi vault" });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.name).toBe("Mi vault");
    expect(await secretGet(vault)).toBe("tok");
    expect(state.connections.find((c) => c.vault === vault)?.name).toBe("Mi vault");
  });

  it("cambia el token: lo persiste al keychain y (en browser) a la config", async () => {
    const vault = "/v-token";
    await seed({ vault, serverUrl: "http://s", token: "old" });
    await updateConnection(vault, { token: "new" });
    expect(await secretGet(vault)).toBe("new");
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.token).toBe("new");
  });

  it("cambia el serverUrl normalizando la barra final", async () => {
    const vault = "/v-url";
    await seed({ vault, serverUrl: "http://old", token: "t" });
    await updateConnection(vault, { serverUrl: "http://new/" });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.serverUrl).toBe("http://new");
  });

  it("nombre en blanco borra el nombre custom", async () => {
    const vault = "/v-clear";
    await seed({ vault, serverUrl: "http://s", token: "t", name: "Viejo" });
    await updateConnection(vault, { name: "  " });
    const cfg = await configLoad();
    expect(cfg.connections.find((c) => c.vault === vault)?.name).toBeUndefined();
  });

  it("vault inexistente: no-op", async () => {
    await updateConnection("/nope", { name: "x" });
    const cfg = await configLoad();
    expect(cfg.connections).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `cd client && bun run test -- updateConnection`
Expected: FAIL — `updateConnection is not a function` / no exportada.

- [ ] **Step 3: Implementar `updateConnection`**

En `client/src/lib/store.ts`, justo después de `removeConnection` (tras la línea `setState("connections", connections);` que cierra esa función, ~línea 959), agregar:

```ts
/**
 * Actualiza una conexión guardada: nombre, serverUrl y/o token. Persiste al
 * config + keychain (keychain antes del JSON). Si la sesión está abierta y
 * cambiaron las credenciales (URL o token), reconecta preservando el foco; un
 * error de reconexión se propaga (la conexión queda cerrada pero guardada).
 * Cambio de solo-nombre no reconecta. Campos ausentes en `patch` se mantienen.
 */
export async function updateConnection(
  vault: string,
  patch: { name?: string; serverUrl?: string | null; token?: string },
): Promise<void> {
  const cfg = await configLoad();
  const cur = cfg.connections.find((c) => c.vault === vault);
  if (!cur) return;

  const nextServerUrl =
    patch.serverUrl === undefined
      ? cur.serverUrl
      : patch.serverUrl === null
        ? null
        : patch.serverUrl.replace(/\/$/, "");
  const nextName = patch.name === undefined ? cur.name : patch.name.trim() || undefined;
  const curToken =
    cur.serverUrl === null ? undefined : ((isTauri ? await secretGet(vault) : cur.token) ?? undefined);
  const nextToken = patch.token === undefined ? curToken : patch.token || undefined;

  // Persistir credenciales (keychain antes del JSON). Vaults locales no llevan token.
  if (nextServerUrl !== null) {
    if (nextToken) await secretSet(vault, nextToken);
    else await secretDelete(vault);
  }
  // Token en el JSON solo en browser (en Tauri vive en el keychain).
  const conn: Connection = isTauri
    ? { vault, serverUrl: nextServerUrl, openedAt: cur.openedAt, name: nextName }
    : { vault, serverUrl: nextServerUrl, token: nextToken, openedAt: cur.openedAt, name: nextName };
  const connections = cfg.connections.map((c) => (c.vault === vault ? conn : c));
  await configSave({ connections, lastVault: cfg.lastVault });
  setState("connections", connections);

  // Reconectar solo si cambian credenciales y hay sesión abierta.
  const credsChanged = nextServerUrl !== cur.serverUrl || nextToken !== curToken;
  if (credsChanged && runtimes.has(vault)) {
    const wasActive = state.activeVault === vault;
    await closeSession(vault);
    await openSession({ vault, serverUrl: nextServerUrl });
    if (wasActive) setState("activeVault", vault);
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `cd client && bun run test -- updateConnection`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/lib/store.ts client/src/lib/updateConnection.test.ts
git commit -m "feat(client): updateConnection (persistir + reconectar si cambian creds)"
```

---

### Task 3: `EditConnectionDialog`

**Files:**
- Create: `client/src/components/EditConnectionDialog.tsx`

**Interfaces:**
- Consumes: `state`, `updateConnection` (Task 2) de `~/lib/store`; `secretGet` de `~/lib/tauri`.
- Produces: `export const EditConnectionDialog: Component<{ vault: string | null; open: boolean; onOpenChange: (o: boolean) => void }>` — lo consume Task 4.

- [ ] **Step 1: Crear el componente**

Crear `client/src/components/EditConnectionDialog.tsx`:

```tsx
import { type Component, Show, createSignal, createEffect } from "solid-js";
import { Eye, EyeOff, Copy, Check } from "lucide-solid";
import { state, updateConnection } from "~/lib/store";
import { secretGet } from "~/lib/tauri";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/** Editar una conexión guardada: nombre, server URL y token (revelable + copiable). */
export const EditConnectionDialog: Component<{
  vault: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}> = (props) => {
  const [name, setName] = createSignal("");
  const [serverUrl, setServerUrl] = createSignal("");
  const [token, setToken] = createSignal("");
  const [reveal, setReveal] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  const conn = () => state.connections.find((c) => c.vault === props.vault) ?? null;
  const isLocal = () => conn()?.serverUrl === null;

  // Al abrir, precargar valores actuales + el token del keychain.
  createEffect(() => {
    const v = props.vault;
    if (!props.open || !v) return;
    const c = state.connections.find((x) => x.vault === v) ?? null;
    setName(c?.name ?? "");
    setServerUrl(c?.serverUrl ?? "");
    setReveal(false);
    setCopied(false);
    setErr(null);
    setToken("");
    secretGet(v)
      .then((t) => setToken(t ?? ""))
      .catch(() => {});
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sin clipboard: el token está visible para copiar a mano */
    }
  };

  const save = async () => {
    const v = props.vault;
    if (!v) return;
    if (!isLocal() && !serverUrl().trim()) return setErr("Poné una URL de servidor.");
    setBusy(true);
    setErr(null);
    try {
      await updateConnection(v, {
        name: name(),
        ...(isLocal() ? {} : { serverUrl: serverUrl().trim(), token: token() }),
      });
      props.onOpenChange(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onOpenChange(false)}>
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>Editar conexión</DialogTitle>
          <DialogDescription class="truncate">{props.vault}</DialogDescription>
        </DialogHeader>

        <div class="flex flex-col gap-4">
          <div>
            <label class="mb-1 block text-xs font-medium text-muted-foreground">Nombre</label>
            <Input
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              placeholder={props.vault ? baseName(props.vault) : "Nombre visible"}
            />
          </div>

          <Show
            when={!isLocal()}
            fallback={<p class="text-xs text-muted-foreground">Vault local (sin servidor).</p>}
          >
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">Server URL</label>
              <Input
                value={serverUrl()}
                onInput={(e) => setServerUrl(e.currentTarget.value)}
                placeholder="http://localhost:4321"
              />
            </div>
            <div>
              <label class="mb-1 block text-xs font-medium text-muted-foreground">Token (api key)</label>
              <div class="flex items-center gap-2">
                <Input
                  class="min-w-0 flex-1 font-mono"
                  type={reveal() ? "text" : "password"}
                  value={token()}
                  onInput={(e) => setToken(e.currentTarget.value)}
                  placeholder="sin token"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setReveal(!reveal())}
                  title={reveal() ? "Ocultar" : "Revelar"}
                >
                  {reveal() ? <EyeOff class="h-4 w-4" /> : <Eye class="h-4 w-4" />}
                </Button>
                <Button size="sm" variant="outline" onClick={copy} title="Copiar" disabled={!token()}>
                  {copied() ? <Check class="h-4 w-4 text-emerald-500" /> : <Copy class="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </Show>

          <Show when={err()}>
            <p class="text-sm text-destructive">{err()}</p>
          </Show>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)} disabled={busy()}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={busy()}>
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS. (Si `EyeOff` no existiera en `lucide-solid`, el import fallaría — existe en 0.469.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/EditConnectionDialog.tsx
git commit -m "feat(client): EditConnectionDialog (nombre/URL/token revelable)"
```

---

### Task 4: `ConnectionsDialog`

**Files:**
- Create: `client/src/components/ConnectionsDialog.tsx`

**Interfaces:**
- Consumes: `state`, `closeSession`, `removeConnection` de `~/lib/store`; `askConfirm` de `~/lib/confirm`; `EditConnectionDialog` (Task 3).
- Produces: `export const ConnectionsDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }>` — lo consume Task 5.

- [ ] **Step 1: Crear el componente**

Crear `client/src/components/ConnectionsDialog.tsx`:

```tsx
import { type Component, For, Show, createSignal } from "solid-js";
import { FolderOpen, MoreVertical, Pencil, Unplug, Trash2 } from "lucide-solid";
import { state, closeSession, removeConnection } from "~/lib/store";
import { askConfirm } from "~/lib/confirm";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "~/components/ui/dropdown-menu";
import { EditConnectionDialog } from "~/components/EditConnectionDialog";

const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/** Gestión de conexiones guardadas: editar, desconectar (cerrar sesión), quitar. */
export const ConnectionsDialog: Component<{ open: boolean; onOpenChange: (o: boolean) => void }> = (props) => {
  const [editVault, setEditVault] = createSignal<string | null>(null);

  const remove = async (vault: string) => {
    const ok = await askConfirm({
      title: "Quitar conexión",
      description: `"${baseName(vault)}" se saca de la lista y se borra su token guardado. La carpeta en disco no se toca.`,
      confirmText: "Quitar",
      destructive: true,
    });
    if (ok) await removeConnection(vault);
  };

  return (
    <>
      <Dialog open={props.open} onOpenChange={props.onOpenChange}>
        <DialogContent class="max-w-lg">
          <DialogHeader>
            <DialogTitle>Conexiones</DialogTitle>
            <DialogDescription>Vaults guardados. Editá, desconectá o quitá cada uno.</DialogDescription>
          </DialogHeader>

          <div class="max-h-80 overflow-auto rounded-md border">
            <For
              each={state.connections}
              fallback={<p class="p-4 text-center text-sm text-muted-foreground">No hay conexiones guardadas.</p>}
            >
              {(conn) => (
                <div class="flex items-center gap-2 border-b px-3 py-2 last:border-b-0">
                  <FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate text-sm font-medium">{conn.name ?? baseName(conn.vault)}</span>
                    <span class="block truncate text-xs text-muted-foreground">{conn.serverUrl ?? "local"}</span>
                  </span>
                  <span class="shrink-0 text-xs text-muted-foreground">
                    {state.sessions[conn.vault] ? "abierta" : "cerrada"}
                  </span>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      class="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      title="Acciones"
                    >
                      <MoreVertical class="h-4 w-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent>
                      <DropdownMenuItem onSelect={() => setEditVault(conn.vault)}>
                        <Pencil class="h-4 w-4" />
                        Editar
                      </DropdownMenuItem>
                      <Show when={state.sessions[conn.vault]}>
                        <DropdownMenuItem onSelect={() => closeSession(conn.vault)}>
                          <Unplug class="h-4 w-4" />
                          Desconectar
                        </DropdownMenuItem>
                      </Show>
                      <DropdownMenuItem destructive onSelect={() => remove(conn.vault)}>
                        <Trash2 class="h-4 w-4" />
                        Quitar
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </For>
          </div>
        </DialogContent>
      </Dialog>

      <EditConnectionDialog
        vault={editVault()}
        open={!!editVault()}
        onOpenChange={(o) => !o && setEditVault(null)}
      />
    </>
  );
};
```

- [ ] **Step 2: Typecheck**

Run: `cd client && bun run typecheck`
Expected: PASS. (`MoreVertical`, `Unplug`, `Pencil` existen en `lucide-solid` 0.469.)

- [ ] **Step 3: Commit**

```bash
git add client/src/components/ConnectionsDialog.tsx
git commit -m "feat(client): ConnectionsDialog (lista + editar/desconectar/quitar)"
```

---

### Task 5: Cablear en `App.tsx`

**Files:**
- Modify: `client/src/App.tsx` — import, `connName` + `vaultLabel`, label del picker, prop `onManage` en `ConnectionManager`, ítem del switcher, signal + render.

**Interfaces:**
- Consumes: `ConnectionsDialog` (Task 4); `Connection.name` (Task 1) vía `state.connections`.

- [ ] **Step 1: Importar `ConnectionsDialog`**

En `client/src/App.tsx`, tras la línea 68 (`import { AddVaultDialog } ...`), agregar:

```ts
import { ConnectionsDialog } from "~/components/ConnectionsDialog";
```

- [ ] **Step 2: `connName` + actualizar `vaultLabel`**

Reemplazar la función `vaultLabel` actual (líneas ~111-115):

```ts
function vaultLabel(localPath: string): string {
  const sess = state.sessions[localPath];
  if (sess?.remoteVaultName) return `${sess.remoteVaultName} @ ${hostOf(sess.serverUrl)}`;
  return vaultName(localPath);
}
```

por:

```ts
/** Nombre visible custom de una conexión guardada (si el usuario lo puso). */
function connName(vault: string): string | undefined {
  return state.connections.find((c) => c.vault === vault)?.name;
}

function vaultLabel(localPath: string): string {
  const custom = connName(localPath);
  if (custom) return custom;
  const sess = state.sessions[localPath];
  if (sess?.remoteVaultName) return `${sess.remoteVaultName} @ ${hostOf(sess.serverUrl)}`;
  return vaultName(localPath);
}
```

- [ ] **Step 3: Label del picker de estado vacío**

En la fila de conexiones del `ConnectionManager` (línea ~238), cambiar:

```tsx
<span class="block truncate text-sm font-medium">{vaultName(conn.vault)}</span>
```

por:

```tsx
<span class="block truncate text-sm font-medium">{conn.name ?? vaultName(conn.vault)}</span>
```

- [ ] **Step 4: Prop `onManage` en `ConnectionManager` + botón**

Cambiar la firma del componente (línea ~185):

```tsx
const ConnectionManager: Component<{ onAddVault: () => void }> = (props) => {
```

por:

```tsx
const ConnectionManager: Component<{ onAddVault: () => void; onManage: () => void }> = (props) => {
```

En el bloque de acciones (el `<div class="border-t pt-4">` con el botón "Agregar vault", líneas ~261-266), agregar el botón "Gestionar conexiones" DESPUÉS del `<Button>` de "Agregar vault" y dentro del mismo `div`:

```tsx
<Show when={state.connections.length}>
  <Button variant="ghost" class="mt-2 w-full" onClick={props.onManage} disabled={!!busy()}>
    <Settings class="h-4 w-4" />
    Gestionar conexiones
  </Button>
</Show>
```

(`Settings` ya está importado en `App.tsx`, línea 25.)

- [ ] **Step 5: Signal `showConnections`**

Junto a los otros signals de diálogos (línea ~442, tras `showVaults`):

```ts
const [showConnections, setShowConnections] = createSignal(false);
```

- [ ] **Step 6: Pasar `onManage` al `ConnectionManager`**

En el `fallback` del `<Show when={s()?.ready}>` (línea ~766):

```tsx
<Show when={s()?.ready} fallback={<ConnectionManager onAddVault={() => setShowAddVault(true)} />}>
```

por:

```tsx
<Show when={s()?.ready} fallback={<ConnectionManager onAddVault={() => setShowAddVault(true)} onManage={() => setShowConnections(true)} />}>
```

- [ ] **Step 7: Ítem "Gestionar conexiones…" en el switcher**

En el `DropdownMenuContent` del switcher, después del ítem "Agregar vault…" (líneas ~950-953), agregar:

```tsx
<DropdownMenuItem class="gap-2 text-muted-foreground" onSelect={() => setShowConnections(true)}>
  <Settings class="h-3.5 w-3.5 shrink-0" />
  Gestionar conexiones…
</DropdownMenuItem>
```

- [ ] **Step 8: Renderizar `ConnectionsDialog`**

Junto a los otros diálogos gestionados (tras `<VaultManager ... />`, línea ~1126):

```tsx
<ConnectionsDialog open={showConnections()} onOpenChange={setShowConnections} />
```

- [ ] **Step 9: Typecheck + build**

Run: `cd client && bun run typecheck && bun run build`
Expected: PASS (typecheck sin errores; build de Vite exitoso).

- [ ] **Step 10: Commit**

```bash
git add client/src/App.tsx
git commit -m "feat(client): cablear gestión de conexiones (switcher + picker)"
```

---

### Task 6: Verificación final

**Files:** ninguno (solo verificación).

- [ ] **Step 1: Typecheck + tests + build**

```bash
cd client && bun run typecheck && bun run test && bun run build
```
Expected: typecheck sin errores; TODOS los tests pasan (incl. los 5 nuevos de `updateConnection`); build OK.

- [ ] **Step 2: Smoke test manual en `bun run tauri dev`**

Levantar `cd client && bun run tauri dev` y verificar, con al menos una conexión guardada con server + token:

1. Switcher (al pie del árbol) → "Gestionar conexiones…" abre el diálogo con la lista.
2. **Editar** una conexión: cambiar el **nombre** → la etiqueta cambia en switcher/topbar/lista; reiniciar la app y sigue.
3. En el editor, **revelar** (👁) y **copiar** el token guardado (no está vacío).
4. Cambiar el **token** a uno inválido → al guardar, la reconexión falla y muestra el error; la conexión sigue en la lista.
5. Corregir el token → guarda y reconecta OK.
6. **Desconectar** una conexión abierta → deja de sincronizar y sigue en la lista (reabrible desde el switcher).
7. **Quitar** una conexión → confirma con `askConfirm`; desaparece de la lista; el token ya no está en el keychain (reabrirla pide token de nuevo).
8. Vault **local**: el editor solo deja cambiar el nombre (URL/token deshabilitados).
9. Una conexión previa **sin `name`** se abre y muestra bien (basename / `X @ host`).

- [ ] **Step 3: Actualizar el índice de planes**

Agregar una fila en `plans/README.md` (tabla de estado) para este plan, con estado DONE + una línea de qué se verificó.

- [ ] **Step 4: Commit**

```bash
git add plans/README.md
git commit -m "docs: registrar plan de gestión de conexiones en el índice"
```

---

## Self-Review

**1. Spec coverage:**
- Modelo `name?` → Task 1. ✓
- `updateConnection` (persistir + reconectar-si-creds) → Task 2. ✓
- Desconectar (`closeSession`) / Quitar (`removeConnection`) → reusadas; cableadas en Task 4. ✓
- `ConnectionsDialog` (lista + `⋮`: Editar/Desconectar/Quitar) → Task 4. ✓
- `EditConnectionDialog` (nombre/URL/token revelable+copiable = "ver api keys") → Task 3. ✓
- Resolución de etiqueta (`connName` → `remoteVaultName @ host` → basename) → Task 5 Step 2/3. ✓
- Puntos de entrada (switcher + picker) → Task 5 Steps 4,6,7. ✓
- Edge cases (local solo-nombre; reconexión con error; desconectar activo) → cubiertos en el código de Task 2/3 y el smoke test de Task 6. ✓
- Tests (name-only, token, serverUrl, resolución de etiqueta) → Task 2 cubre name/token/serverUrl/clear/no-op. La **resolución de etiqueta** vive en `App.tsx` (no unit-testeable sin extraer) → cubierta por el smoke test (Task 6, pasos 2 y 9), tal como anota la spec.

**2. Placeholder scan:** sin TBD/TODO; todo el código es concreto y completo.

**3. Type consistency:** `updateConnection(vault, { name?, serverUrl?, token? })` idéntico en Task 2 (definición), Task 3 (callsite `save`). `EditConnectionDialog`/`ConnectionsDialog` props coinciden entre definición (Task 3/4) y uso (Task 4/5). `Connection.name` (Task 1) usado en Task 2/4/5.
