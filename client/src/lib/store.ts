import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { BridgesApi, ApiError, type Doc, type SearchHit } from "./api";
import {
  pickVault,
  vaultWrite,
  vaultRemove,
  vaultTrash,
  vaultRead,
  vaultScan,
  startWatch,
  stopWatch,
  onVaultChange,
  startEventStream,
  stopEventStream,
  onServerChange,
  onServerStatus,
  stateSave,
  configLoad,
  configSave,
  secretSet,
  secretGet,
  secretDelete,
  isTauri,
  type Connection,
  type AppConfig,
} from "./tauri";
import * as idx from "./reconcile";

/** Conflicto irreconciliable (3-way con hunks que se pisan) a resolver a mano. */
export type SyncConflict = { path: string; local: string; server: Doc };

const now = () => new Date().toISOString();

const DEFAULT_AUTHOR = "yo"; // sin auth: no hay identidad de token
const DEFAULT_SERVER = "http://localhost:4321";

/** Nombre legible de un vault (basename) para avisos. */
const baseName = (p: string) => p.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || p;

/** Estado reactivo de UNA sesión de sync (un vault). Lo lee la UI. */
export type Session = {
  vault: string;
  serverUrl: string;
  local: boolean; // vault local sin server
  lastSeq: number;
  docs: Record<string, Doc>; // solo vivos (deleted=0)
  connected: boolean; // stream SSE vivo
  online: boolean; // el server REST es alcanzable (independiente del SSE)
  pending: number; // cambios locales en cola sin sincronizar
  conflicts: SyncConflict[]; // conflictos de sync pendientes de resolución manual
  bulkGuard: { count: number } | null; // guardia anti-vaciado disparada: borrados en cola a confirmar
  syncing: boolean;
  ready: boolean; // vault elegido + primer pull hecho
  perms: { write: boolean; delete: boolean }; // permisos del token actual (gatea la UI)
  role: string | null; // rol del token (viewer/editor/admin), null si no hay auth
  authEnabled: boolean; // si el server pide token
  author: string; // identidad para el historial: nombre del token (o DEFAULT_AUTHOR sin auth)
  remoteVault?: string; // slug del vault server-side (multi-vault); undefined en servers viejos
  remoteVaultName?: string; // nombre legible del vault server-side
  isOwner?: boolean; // el token es el "server owner" (gestiona vaults)
  error: string | null;
};

type State = {
  sessions: Record<string, Session>; // por vault (= connId)
  activeVault: string | null; // foco de la UI
  connections: Connection[]; // conexiones guardadas (carpeta + servidor)
  booting: boolean; // abriendo las conexiones al arrancar
  notice: string | null; // aviso transitorio global
};

/**
 * Runtime NO-reactivo de una sesión: la api con su base/token, el índice del
 * vault y el estado del motor. Vive fuera del store (no metemos objetos no
 * reactivos en createStore). El motor recibe `rt` por parámetro y escribe al
 * store vía setState("sessions", rt.vault, …).
 */
type SessionRuntime = {
  vault: string;
  api: BridgesApi | null; // null ⇒ vault local (sin server)
  index: idx.IndexHandle | null; // null ⇒ vault local (sin índice de reconciliación)
  flushing: boolean;
  bulkConfirmed: boolean; // el usuario destrabó la guardia: los deletes en cola van con bypass
  unsubscribe: (() => void) | null; // cleanup del SSE (browser); null en Tauri
  unwatch: (() => void) | null; // cleanup del watcher (browser); null en Tauri
  debounce: Map<string, ReturnType<typeof setTimeout>>;
};

const runtimes = new Map<string, SessionRuntime>();

/** Permisos según el rol del token. Sin auth, permisos plenos (el server igual valida). */
function permsForRole(role: string | null, authEnabled: boolean): { write: boolean; delete: boolean } {
  if (!authEnabled) return { write: true, delete: true };
  switch (role) {
    case "admin":
      return { write: true, delete: true };
    case "editor":
      return { write: true, delete: false };
    default: // viewer o rol desconocido
      return { write: false, delete: false };
  }
}

const [state, setState] = createStore<State>({
  sessions: {},
  activeVault: null,
  connections: [],
  booting: true,
  notice: null,
});

export { state };

/** Sesión enfocada (la que ve la UI). Reactivo. */
export function active(): Session | null {
  return state.activeVault ? state.sessions[state.activeVault] ?? null : null;
}

/** Api de la sesión enfocada (reemplaza el viejo singleton `api`). */
export function activeApi(): BridgesApi | undefined {
  return state.activeVault ? runtimes.get(state.activeVault)?.api ?? undefined : undefined;
}

function activeRuntime(): SessionRuntime | undefined {
  return state.activeVault ? runtimes.get(state.activeVault) : undefined;
}

function freshSession(vault: string, serverUrl: string): Session {
  return {
    vault,
    serverUrl,
    local: false,
    lastSeq: 0,
    docs: {},
    connected: false,
    online: true,
    pending: 0,
    conflicts: [],
    bulkGuard: null,
    syncing: false,
    ready: false,
    perms: { write: true, delete: true },
    role: null,
    authEnabled: false,
    author: DEFAULT_AUTHOR,
    error: null,
  };
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function setNotice(msg: string | null) {
  setState("notice", msg);
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => setState("notice", null), 6000);
}

/**
 * Aplica un lote de docs del server (la verdad confirmada) a una sesión:
 * actualiza store, espeja a disco y fija la BASE del 3-way merge en el índice.
 * Fijar la base (con su synced_hash) antes de que llegue el evento del watcher
 * suprime el eco de nuestra propia escritura.
 */
async function applyDocs(rt: SessionRuntime, docs: Doc[]) {
  if (!rt.api || !rt.index) return; // sesión local: no entra al motor remoto
  const sess = state.sessions[rt.vault];
  if (!sess) return;
  for (const d of docs) {
    if (d.deleted) {
      await vaultRemove(rt.vault, d.path).catch(() => {});
      setState("sessions", rt.vault, "docs", d.id, undefined!);
      rt.index.deleteEntry(d.path);
    } else {
      // Si cambió el path, borrar el archivo viejo en disco.
      const prev = sess.docs[d.id];
      if (prev && prev.path !== d.path) {
        await vaultRemove(rt.vault, prev.path).catch(() => {});
        rt.index.deleteEntry(prev.path);
      }
      // Saca cualquier doc temporal/duplicado con el mismo path pero otro id
      // (p.ej. el placeholder "local:" de un doc creado offline, ya confirmado).
      for (const other of Object.values(sess.docs)) {
        if (other.path === d.path && other.id !== d.id) setState("sessions", rt.vault, "docs", other.id, undefined!);
      }
      await vaultWrite(rt.vault, d.path, d.content);
      setState("sessions", rt.vault, "docs", d.id, d);
      rt.index.setEntry(d.path, {
        id: d.id,
        base_version: d.version,
        base_content: d.content,
        synced_hash: await idx.sha256(d.content),
        dirty: false,
        deleted: false,
        updated_at: d.updated_at,
      });
    }
  }
  await persistIndex(rt);
}

/** ¿El error es la guardia anti-vaciado del server (429)? */
function isBulkGuard(e: unknown): boolean {
  return e instanceof ApiError && e.status === 429;
}

/** Mensaje legible para un error de auth (token inválido / sin permiso). */
function authMessage(e: unknown, action: string): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return "Token inválido o ausente.";
  if (e.status === 403) return `No tenés permiso para ${action}.`;
  return null;
}

/** Pull incremental desde lastSeq para una sesión. */
async function pullSession(rt: SessionRuntime) {
  if (!rt.api || !rt.index) return; // sesión local: no entra al motor remoto
  const sess = state.sessions[rt.vault];
  if (!sess || sess.syncing) return;
  setState("sessions", rt.vault, { syncing: true, error: null });
  try {
    const res = await rt.api.sync(sess.lastSeq);
    setState("sessions", rt.vault, "online", true);
    if (res.documents.length) await applyDocs(rt, res.documents);
    if (res.last_seq !== state.sessions[rt.vault].lastSeq) {
      setState("sessions", rt.vault, "lastSeq", res.last_seq);
      await stateSave(rt.vault, { last_seq: res.last_seq, server_url: sess.serverUrl });
    }
  } catch (e) {
    if (!(e instanceof ApiError)) setState("sessions", rt.vault, "online", false); // red caída
    const msg = authMessage(e, "leer este vault") ?? `Sync falló: ${String(e)}`;
    setState("sessions", rt.vault, "error", msg);
    setNotice(msg);
  } finally {
    setState("sessions", rt.vault, "syncing", false);
  }
}

/** Pull de la sesión enfocada (botón "Sincronizar ahora"). */
export async function pull() {
  const rt = activeRuntime();
  if (rt) await pullSession(rt);
}

// --- motor offline-first: cola de cambios (índice dirty) + flush + 3-way merge ---

const blankEntry = (): idx.IndexEntry => ({
  id: null,
  base_version: 0,
  base_content: "",
  synced_hash: "",
  dirty: false,
  deleted: false,
  updated_at: "",
});

/** Persiste el índice y refresca el contador reactivo de pendientes para la UI. */
async function persistIndex(rt: SessionRuntime) {
  if (!rt.index) return; // sesión local: sin índice de reconciliación
  await rt.index.persist();
  setState("sessions", rt.vault, "pending", rt.index.dirtyPaths().length);
}

/** Borrados en cola (entradas dirty marcadas como deleted). */
function pendingDeletes(rt: SessionRuntime): number {
  const index = rt.index;
  if (!index) return 0;
  return index.dirtyPaths().filter((p) => index.getEntry(p)?.deleted).length;
}

/** Marca un doc como borrado local pendiente de pushear. */
function markDeleted(rt: SessionRuntime, path: string) {
  if (!rt.index) return;
  const entry = rt.index.getEntry(path);
  if (!entry) return;
  entry.deleted = true;
  entry.dirty = true;
  entry.updated_at = now();
  rt.index.setEntry(path, entry);
}

/** Marca un doc como editado local pendiente de pushear. */
function markDirty(rt: SessionRuntime, path: string) {
  if (!rt.index) return;
  const e = rt.index.getEntry(path) ?? blankEntry();
  e.dirty = true;
  e.deleted = false;
  e.updated_at = now();
  rt.index.setEntry(path, e);
}

/** Encola un conflicto irreconciliable para resolución manual (dedup por path). */
function enqueueConflict(rt: SessionRuntime, path: string, local: string, server: Doc) {
  setState("sessions", rt.vault, "conflicts", (cs) => [...cs.filter((c) => c.path !== path), { path, local, server }]);
  setNotice(`Conflicto en ${baseName(rt.vault)}/${path}`);
}

/**
 * Punto único de entrada para un cambio local detectado (watcher o editor):
 * marca el doc como dirty (o borrado) en el índice y dispara el flush.
 */
async function enqueuePush(rt: SessionRuntime, path: string) {
  const index = rt.index;
  if (!rt.api || !index) return; // sesión local: no entra al motor remoto
  const content = await vaultRead(rt.vault, path);
  const entry = index.getEntry(path);

  if (content == null) {
    if (entry) markDeleted(rt, path);
    else return; // archivo desconocido borrado: nada que sincronizar
  } else {
    const hash = await idx.sha256(content);
    if (entry && !entry.deleted && entry.synced_hash === hash) return; // eco de nuestra escritura / sin cambios
    markDirty(rt, path);
  }
  await persistIndex(rt);
  await flushQueue(rt);
}

/** Reenvía al server las entradas dirty del índice, en orden. Idempotente y serializado por sesión. */
async function flushQueue(rt: SessionRuntime) {
  if (!rt.api || !rt.index) return; // sesión local: no entra al motor remoto
  const sess = state.sessions[rt.vault];
  if (rt.flushing || !sess || !sess.online) return;
  rt.flushing = true;
  try {
    for (const path of rt.index.dirtyPaths()) {
      const ok = await pushOne(rt, path);
      if (!ok) break; // red caída: cortar; se reintenta al reconectar
    }
  } finally {
    rt.flushing = false;
  }
}

/** Pushea una entrada dirty. Devuelve false si hay que cortar el flush (red caída). */
async function pushOne(rt: SessionRuntime, path: string): Promise<boolean> {
  if (!rt.api || !rt.index) return true; // sesión local: no entra al motor remoto
  const author = state.sessions[rt.vault].author;
  const entry = rt.index.getEntry(path);
  if (!entry || (!entry.dirty && !entry.deleted)) return true;

  try {
    if (entry.deleted) {
      if (entry.id) {
        const doc = await rt.api.remove(entry.id, author, rt.bulkConfirmed);
        setState("sessions", rt.vault, "docs", entry.id, undefined!);
        bumpSeq(rt, doc.seq);
      }
      rt.index.deleteEntry(path);
      await persistIndex(rt);
      setState("sessions", rt.vault, "online", true);
      return true;
    }

    const content = await vaultRead(rt.vault, path);
    if (content == null) {
      // desapareció mientras tanto: lo tratamos como borrado en la próxima vuelta
      markDeleted(rt, path);
      await persistIndex(rt);
      return true;
    }

    let res;
    if (entry.id) {
      res = await rt.api.update(entry.id, { path, content, base_version: entry.base_version, author });
    } else {
      // ¿rename de un doc conocido? (mismo contenido y su archivo ya no está)
      const moved = await findMovedDoc(rt, content, path);
      res = moved
        ? await rt.api.update(moved.id, { path, content, base_version: moved.version, author })
        : await rt.api.create({ path, content, author });
    }

    setState("sessions", rt.vault, "online", true);
    if ("conflict" in res) {
      // El 409 de create por "path ya existe" NO trae el doc del server; lo buscamos.
      let server: Doc | undefined = res.server;
      if (!server) {
        const sync = await rt.api.sync(0);
        server = sync.documents.find((d) => d.path === path);
      }
      if (!server) return true; // no encontrado (carrera): se reintenta luego
      if (server.deleted) {
        // El path lo ocupa un doc borrado: lo revivimos con el contenido local
        // (un update con deleted=0 lo reactiva). Reintentamos como update.
        const e = rt.index.getEntry(path) ?? blankEntry();
        e.id = server.id;
        e.base_version = server.version;
        e.dirty = true;
        e.deleted = false;
        e.updated_at = now();
        rt.index.setEntry(path, e);
        await persistIndex(rt);
        return await pushOne(rt, path);
      }
      return await mergeConflict(rt, path, content, server);
    }

    await applyDocs(rt, [res.doc]); // fija base, limpia dirty
    bumpSeq(rt, res.doc.seq);
    return true;
  } catch (e) {
    if (isBulkGuard(e)) {
      // Guardia anti-vaciado: frenar el flush y pedir confirmación. Los deletes
      // quedan en cola (no se pierden); se reintentan al confirmar.
      setState("sessions", rt.vault, "bulkGuard", { count: pendingDeletes(rt) });
      return false;
    }
    const msg = authMessage(e, "sincronizar este vault");
    if (msg) {
      setNotice(msg);
      return true; // permiso: salteamos este doc (queda dirty); seguimos con el resto
    }
    setState("sessions", rt.vault, "online", false); // red/timeout: cortar y reintentar al reconectar
    return false;
  }
}

/**
 * Resuelve un 409 con 3-way merge contra la base del índice. Si el merge es
 * limpio, pushea el resultado re-basado sobre el server; si se pisan los cambios
 * (o no hay base), cae a resolución manual (ConflictDialog).
 */
async function mergeConflict(rt: SessionRuntime, path: string, local: string, server: Doc): Promise<boolean> {
  if (!rt.api || !rt.index) return true; // sesión local: no entra al motor remoto
  const author = state.sessions[rt.vault].author;
  const entry = rt.index.getEntry(path);
  const base = entry?.base_content;

  if (base == null) {
    enqueueConflict(rt, path, local, server); // sin ancestro común no hay 3-way
    if (entry) {
      entry.dirty = false;
      rt.index.setEntry(path, entry);
      await persistIndex(rt);
    }
    return true;
  }

  const merged = idx.threeWayMerge(local, base, server.content);
  if (merged.conflict) {
    enqueueConflict(rt, path, local, server);
    if (entry) {
      entry.dirty = false;
      rt.index.setEntry(path, entry);
      await persistIndex(rt);
    }
    return true;
  }

  try {
    const res = await rt.api.update(server.id, {
      path,
      content: merged.result,
      base_version: server.version,
      author,
    });
    setState("sessions", rt.vault, "online", true);
    if ("conflict" in res) {
      // el server volvió a cambiar entre medio: dejamos que lo resuelva la persona
      enqueueConflict(rt, path, merged.result, res.server);
      return true;
    }
    await applyDocs(rt, [res.doc]);
    bumpSeq(rt, res.doc.seq);
    return true;
  } catch (e) {
    const msg = authMessage(e, "sincronizar este vault");
    if (msg) {
      setNotice(msg);
      return true;
    }
    setState("sessions", rt.vault, "online", false);
    return false;
  }
}

/** Reconstruye los docs de una sesión desde los .md en disco (modo offline). */
async function hydrateFromDisk(rt: SessionRuntime) {
  const disk = await vaultScan(rt.vault);
  const docs: Record<string, Doc> = {};
  for (const f of disk) {
    const entry = rt.index?.getEntry(f.path);
    const id = entry?.id ?? `local:${f.path}`;
    docs[id] = {
      id,
      path: f.path,
      title: null,
      content: f.content,
      version: entry?.base_version ?? 0,
      seq: 0,
      deleted: 0,
      updated_by: null,
      updated_at: entry?.updated_at ?? "",
    };
  }
  setState("sessions", rt.vault, "docs", docs);
}

/**
 * Reconciliación completa de una sesión: disco vs base (índice) vs remoto
 * (sync 0). Si el server no responde, cae a modo offline hidratando desde disco.
 * Propaga errores de auth (los muestra quien abrió la sesión).
 */
async function reconcile(rt: SessionRuntime) {
  if (!rt.api || !rt.index) return; // sesión local: no entra al motor remoto
  const sess = state.sessions[rt.vault];
  if (!sess || sess.syncing) return;
  setState("sessions", rt.vault, { syncing: true, error: null });

  let disk: { path: string; content: string }[];
  let sync: { documents: Doc[]; last_seq: number };
  try {
    [disk, sync] = await Promise.all([vaultScan(rt.vault), rt.api.sync(0)]);
    setState("sessions", rt.vault, "online", true);
  } catch (e) {
    setState("sessions", rt.vault, "syncing", false);
    const msg = authMessage(e, "leer este vault");
    if (msg) throw new Error(msg); // token inválido/sin permiso
    setState("sessions", rt.vault, "online", false); // red caída: modo offline
    await hydrateFromDisk(rt);
    return;
  }

  try {
    setState("sessions", rt.vault, "lastSeq", sync.last_seq);
    await stateSave(rt.vault, { last_seq: sync.last_seq, server_url: sess.serverUrl });

    // Poblar el store con el estado vivo del server: es lo que ve la UI.
    const liveDocs: Record<string, Doc> = {};
    for (const d of sync.documents) if (!d.deleted) liveDocs[d.id] = d;
    setState("sessions", rt.vault, "docs", liveDocs);

    const remoteByPath = new Map(sync.documents.map((d) => [d.path, d]));
    const diskByPath = new Map(disk.map((f) => [f.path, f.content]));
    const paths = new Set<string>([
      ...diskByPath.keys(),
      ...Object.keys(rt.index.getIndex().docs),
      ...remoteByPath.keys(),
    ]);

    for (const path of paths) {
      const content = diskByPath.get(path) ?? null;
      const onDisk = content != null;
      const diskHash = content != null ? await idx.sha256(content) : null;
      const base = rt.index.getEntry(path);
      const remote = remoteByPath.get(path);
      const remoteHash = remote && !remote.deleted ? await idx.sha256(remote.content) : null;

      switch (idx.classify({ onDisk, diskHash, remoteHash, base, remote })) {
        case "noop":
          break;
        case "pull":
        case "pull-delete":
          if (remote) await applyDocs(rt, [remote]);
          break;
        case "create":
        case "push":
          markDirty(rt, path);
          break;
        case "push-delete":
          markDeleted(rt, path);
          break;
        case "merge":
          if (remote && !remote.deleted) await mergeConflict(rt, path, content ?? "", remote);
          break;
        case "delete-vs-edit":
          if (remote) {
            await applyDocs(rt, [remote]);
            setNotice(`"${path}" se restauró: se editó en el server mientras lo borraste localmente.`);
          }
          break;
        case "edit-vs-delete":
          // local editó, remoto borró -> revivir el doc con la edición local
          if (remote) {
            const e = rt.index.getEntry(path) ?? blankEntry();
            e.id = remote.id;
            e.base_version = remote.version; // versión actual (borrada): el update reactiva
            e.dirty = true;
            e.deleted = false;
            e.updated_at = now();
            rt.index.setEntry(path, e);
            setNotice(`"${path}" se reactiva: lo editaste localmente y estaba borrado en el server.`);
          }
          break;
      }
    }
    await persistIndex(rt);
    await flushQueue(rt);
  } finally {
    setState("sessions", rt.vault, "syncing", false);
  }
}

// --- resolución manual de conflictos de sync (desde el ConflictDialog) ---

/** Sobrescribe con la versión local (re-basada sobre el server). */
export async function resolveConflictKeepMine(vault: string, path: string) {
  const rt = runtimes.get(vault);
  const sess = state.sessions[vault];
  if (!rt || !rt.api || !sess) return; // los conflictos solo existen en vaults con server
  const c = sess.conflicts.find((x) => x.path === path);
  if (!c) return;
  setState("sessions", vault, "conflicts", (cs) => cs.filter((x) => x.path !== path));
  try {
    const res = await rt.api.update(c.server.id, {
      path,
      content: c.local,
      base_version: c.server.version,
      author: sess.author,
    });
    if ("conflict" in res) enqueueConflict(rt, path, c.local, res.server);
    else {
      await applyDocs(rt, [res.doc]);
      bumpSeq(rt, res.doc.seq);
    }
  } catch (e) {
    setNotice(authMessage(e, "guardar este vault") ?? `No se pudo guardar ${path}: ${e}`);
  }
}

/** Descarta lo local y se queda con la versión del server. */
export async function resolveConflictKeepServer(vault: string, path: string) {
  const rt = runtimes.get(vault);
  const sess = state.sessions[vault];
  if (!rt || !sess) return;
  const c = sess.conflicts.find((x) => x.path === path);
  if (!c) return;
  setState("sessions", vault, "conflicts", (cs) => cs.filter((x) => x.path !== path));
  await applyDocs(rt, [c.server]);
  bumpSeq(rt, c.server.seq);
}

// --- ciclo de vida de las sesiones ---

/**
 * Abre una sesión de sync para un vault: crea su BridgesApi + IndexHandle, hace
 * health → reconcile → whoami, y arranca stream SSE + watcher. Server caído →
 * la sesión queda offline e hidrata desde disco; un error de auth propaga (y
 * limpia la sesión a medio abrir). Idempotente: si ya está abierta, no hace nada.
 */
export async function openSession(opts: { vault: string; serverUrl?: string | null; token?: string }) {
  if (runtimes.has(opts.vault)) return;
  if (opts.serverUrl === null) {
    await openLocalSession(opts.vault);
    return;
  }
  const serverUrl = (opts.serverUrl ?? DEFAULT_SERVER).replace(/\/$/, "");
  const api = new BridgesApi(serverUrl);
  // El token vive en el keychain (Tauri); el JSON ya no lo guarda. `opts.token`
  // cubre el alta nueva (aún en memoria) y los configs viejos sin migrar.
  const token = opts.token ?? (await secretGet(opts.vault)) ?? undefined;
  api.setToken(token ?? null);
  const index = idx.createIndexHandle(opts.vault);
  await index.load();
  const rt: SessionRuntime = {
    vault: opts.vault,
    api,
    index,
    flushing: false,
    bulkConfirmed: false,
    unsubscribe: null,
    unwatch: null,
    debounce: new Map(),
  };
  runtimes.set(opts.vault, rt);
  setState("sessions", opts.vault, freshSession(opts.vault, serverUrl));

  // ¿Server alcanzable? /health es público; si falla, arrancamos offline.
  let online = true;
  try {
    await api.health();
  } catch {
    online = false;
  }

  if (online) {
    try {
      await reconcile(rt); // sync(0) + reconciliación; propaga error de auth
    } catch (e) {
      runtimes.delete(opts.vault);
      setState("sessions", opts.vault, undefined!);
      throw e;
    }
    // Permisos del token. Si /whoami falla (server viejo/red), asumimos plenos.
    try {
      const who = await api.whoami();
      setState("sessions", opts.vault, {
        perms: permsForRole(who.role, who.authEnabled),
        role: who.role,
        authEnabled: who.authEnabled,
        author: who.name || DEFAULT_AUTHOR,
        remoteVault: who.vault,
        remoteVaultName: who.vaultName,
        isOwner: who.isOwner,
      });
    } catch {
      setState("sessions", opts.vault, {
        perms: { write: true, delete: true },
        role: null,
        authEnabled: false,
        author: DEFAULT_AUTHOR,
      });
    }
  } else {
    setState("sessions", opts.vault, { online: false });
    await hydrateFromDisk(rt);
  }

  setState("sessions", opts.vault, "ready", true);
  await startSessionSync(rt, serverUrl, token);
}

/** Abre una sesión LOCAL: disco como verdad, store como espejo. Sin server. */
async function openLocalSession(vault: string) {
  const rt: SessionRuntime = {
    vault,
    api: null,
    index: null,
    flushing: false,
    bulkConfirmed: false,
    unsubscribe: null,
    unwatch: null,
    debounce: new Map(),
  };
  runtimes.set(vault, rt);
  setState("sessions", vault, { ...freshSession(vault, ""), local: true });
  await hydrateFromDisk(rt); // index null → ids local:<path>
  setState("sessions", vault, "ready", true);
  await startWatch(vault, vault); // watcher; el dispatch local lo rutea scheduleExternal
}

/**
 * Arranca la sincronización en vivo de una sesión: stream SSE + watcher del
 * vault. En Tauri el stream y el watcher viven en Rust y sus eventos los
 * despacha el listener global (ver registerGlobalListeners); en browser, el
 * SSE va por fetch-streaming directo de la api.
 */
async function startSessionSync(rt: SessionRuntime, serverUrl: string, token?: string) {
  if (!rt.api) return; // solo se llama desde el camino remoto (local arranca su watcher en openLocalSession)
  if (isTauri) {
    await startEventStream(rt.vault, serverUrl, token ?? "");
  } else {
    rt.unsubscribe?.();
    rt.unsubscribe = rt.api.subscribe(
      (seq) => {
        if (seq > state.sessions[rt.vault].lastSeq) pullSession(rt);
      },
      (connected) => {
        setState("sessions", rt.vault, "connected", connected);
        if (connected) reconcile(rt);
      },
    );
  }
  // Watcher: en Tauri emite vault-change (lo despacha el listener global).
  await startWatch(rt.vault, rt.vault);
}

/** Cierra una sesión: corta SSE + watcher, limpia runtime y store. Reasigna el foco si era la activa. */
export async function closeSession(vault: string) {
  const rt = runtimes.get(vault);
  if (!rt) return;
  rt.unsubscribe?.();
  rt.unwatch?.();
  for (const t of rt.debounce.values()) clearTimeout(t);
  rt.debounce.clear();
  await stopEventStream(vault); // no-op en browser
  await stopWatch(vault); // no-op en browser
  rt.index?.clear();
  runtimes.delete(vault);
  setState("sessions", vault, undefined!);
  if (state.activeVault === vault) {
    const next = Object.keys(state.sessions)[0] ?? null;
    setState("activeVault", next);
    if (next) configSetLastVault(next).catch(() => {});
  }
}

/** Cambia el foco de la UI a otro vault. Instantáneo: no toca el sync de nadie. */
export async function setActiveVault(vault: string) {
  if (!state.sessions[vault]) return;
  setState("activeVault", vault);
  await configSetLastVault(vault);
}

/**
 * Abre (si hace falta) una conexión, la enfoca y la persiste. Es el flujo de
 * "abrir/agregar vault" desde la UI. Propaga errores de auth (los muestra el
 * gestor de conexiones / el diálogo de agregar).
 */
export async function connect(opts: { vault: string; serverUrl?: string | null; token?: string }) {
  await openSession(opts);
  setState("activeVault", opts.vault);
  const serverUrl = opts.serverUrl === null ? null : (opts.serverUrl ?? DEFAULT_SERVER).replace(/\/$/, "");
  await persistConnection(opts.vault, serverUrl, opts.token);
}

/** Elige una carpeta y la abre como vault LOCAL (sin server ni token). false si se canceló. */
export async function connectLocal(): Promise<boolean> {
  const vault = await pickVault();
  if (!vault) return false;
  await connect({ vault, serverUrl: null });
  return true;
}

// --- listeners globales (Tauri) y de red ---

let globalListenersReady = false;
let offVaultChange: (() => void) | null = null;
let offServerChange: (() => void) | null = null;
let offServerStatus: (() => void) | null = null;

/** Registra UN listener por tipo de evento Tauri que despacha por connId a su runtime. */
async function registerGlobalListeners() {
  if (globalListenersReady || !isTauri) return;
  globalListenersReady = true;
  offVaultChange = await onVaultChange((connId, paths) => {
    const rt = runtimes.get(connId);
    if (rt) paths.forEach((p) => scheduleExternal(rt, p));
  });
  offServerChange = await onServerChange((connId, seq) => {
    const rt = runtimes.get(connId);
    const sess = state.sessions[connId];
    if (rt && sess && seq > sess.lastSeq) pullSession(rt);
  });
  offServerStatus = await onServerStatus((connId, connected) => {
    const rt = runtimes.get(connId);
    if (!rt) return;
    setState("sessions", connId, "connected", connected);
    // Al (re)conectar, reconciliar: trae el gap remoto y reenvía la cola local.
    if (connected) reconcile(rt);
  });
}

let netListeners: (() => void) | null = null;

function setupNetworkListeners() {
  if (netListeners || typeof window === "undefined") return;
  const onOnline = () => {
    for (const rt of runtimes.values()) {
      setState("sessions", rt.vault, "online", true);
      reconcile(rt);
    }
  };
  const onOffline = () => {
    for (const rt of runtimes.values()) setState("sessions", rt.vault, "online", false);
  };
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  netListeners = () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    netListeners = null;
  };
}

// --- config: conexiones guardadas ---

/** Guarda/actualiza la conexión y la marca como la última usada. No rompe nada si falla. */
async function persistConnection(vault: string, serverUrl: string | null, token?: string) {
  try {
    // El token va al keychain ANTES de tocar el JSON (invariante: nunca quitamos
    // el token del JSON sin tenerlo a salvo). Vaults locales (sin server) no llevan token.
    if (serverUrl !== null) {
      if (token) await secretSet(vault, token);
      else await secretDelete(vault);
    }
    const cfg = await configLoad();
    const others = cfg.connections.filter((c) => c.vault !== vault);
    // En Tauri el token NO va al JSON (vive en el keychain). En browser sí, porque
    // su secretSet es en memoria y se pierde al recargar (conveniencia de dev).
    const conn: Connection = isTauri
      ? { vault, serverUrl, openedAt: new Date().toISOString() }
      : { vault, serverUrl, token, openedAt: new Date().toISOString() };
    const connections: Connection[] = [conn, ...others];
    await configSave({ connections, lastVault: vault });
    setState("connections", connections);
  } catch (e) {
    console.warn("No se pudo guardar la conexión:", e);
  }
}

/**
 * Migración: mueve tokens en claro de configs viejos al keychain y los borra del
 * JSON. Orden seguro: escribir al keychain y SOLO si funcionó sacar el token del
 * JSON (un fallo conserva el token, no lo pierde). Solo en Tauri (browser no tiene
 * keychain). Muta `cfg` para que el resto del boot abra sin tokens en el JSON.
 */
async function migrateTokensToKeychain(cfg: AppConfig): Promise<void> {
  if (!isTauri) return;
  let changed = false;
  const connections: Connection[] = [];
  for (const c of cfg.connections) {
    if (c.token && c.serverUrl !== null) {
      try {
        await secretSet(c.vault, c.token);
        connections.push({ vault: c.vault, serverUrl: c.serverUrl, openedAt: c.openedAt });
        changed = true;
      } catch {
        connections.push(c); // keychain falló: conservar el token en el JSON
      }
    } else {
      connections.push(c);
    }
  }
  if (changed) {
    await configSave({ connections, lastVault: cfg.lastVault });
    cfg.connections = connections;
    setState("connections", connections);
  }
}

/** Actualiza solo `lastVault` en la config (al cambiar el foco). */
async function configSetLastVault(vault: string) {
  const cfg = await configLoad();
  await configSave({ connections: cfg.connections, lastVault: vault });
}

/**
 * Arranque: carga la config y abre TODAS las conexiones guardadas en paralelo
 * (un server caído no tumba el resto). El foco arranca en lastVault (o la
 * primera que haya abierto).
 */
export async function boot() {
  setState("booting", true);
  try {
    const cfg = await configLoad();
    setState("connections", cfg.connections);
    await registerGlobalListeners();
    setupNetworkListeners();
    await migrateTokensToKeychain(cfg); // tokens en claro de configs viejos → keychain
    if (cfg.connections.length) {
      await Promise.allSettled(
        cfg.connections.map((c) =>
          openSession({ vault: c.vault, serverUrl: c.serverUrl, token: c.token }).catch((e) => {
            setNotice(`No se pudo abrir "${baseName(c.vault)}": ${e instanceof Error ? e.message : e}`);
            throw e;
          }),
        ),
      );
    }
    const focus =
      cfg.lastVault && runtimes.has(cfg.lastVault) ? cfg.lastVault : Object.keys(state.sessions)[0] ?? null;
    setState("activeVault", focus);
  } finally {
    setState("booting", false);
  }
}

/** Elimina una conexión guardada (cerrando antes su sesión si está abierta). */
export async function removeConnection(vault: string) {
  await closeSession(vault);
  const cfg = await configLoad();
  const connections = cfg.connections.filter((c) => c.vault !== vault);
  const lastVault = cfg.lastVault === vault ? connections[0]?.vault ?? null : cfg.lastVault;
  await configSave({ connections, lastVault });
  await secretDelete(vault).catch(() => {}); // que no quede el token huérfano en el keychain
  setState("connections", connections);
}

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
    if (wasActive) {
      setState("activeVault", vault);
      await configSetLastVault(vault);
    }
  }
}

/** Reacciona a un cambio externo de archivo (watcher): debounce + encolar + flush. */
function scheduleExternal(rt: SessionRuntime, path: string) {
  clearTimeout(rt.debounce.get(path));
  rt.debounce.set(
    path,
    setTimeout(() => {
      rt.debounce.delete(path);
      const fn = rt.api === null ? localApplyExternal(rt, path) : enqueuePush(rt, path);
      fn.catch((e) => setNotice(`Error al sincronizar ${path}: ${e}`));
    }, 400),
  );
}

/** Cambio externo en un vault local: re-lee el archivo al store (eco suprimido por contenido). */
async function localApplyExternal(rt: SessionRuntime, path: string) {
  const content = await vaultRead(rt.vault, path);
  const id = `local:${path}`;
  if (content == null) {
    // borrado/movido afuera
    setState("sessions", rt.vault, "docs", id, undefined!);
    return;
  }
  const cur = state.sessions[rt.vault].docs[id];
  if (cur && cur.content === content) return; // eco de nuestra propia escritura
  setState("sessions", rt.vault, "docs", id, {
    id,
    path,
    title: cur?.title ?? null,
    content,
    version: 0,
    seq: 0,
    deleted: 0,
    updated_by: DEFAULT_AUTHOR,
    updated_at: now(),
  });
}

function bumpSeq(rt: SessionRuntime, seq: number) {
  const sess = state.sessions[rt.vault];
  if (sess && seq > sess.lastSeq) {
    setState("sessions", rt.vault, "lastSeq", seq);
    stateSave(rt.vault, { last_seq: seq, server_url: sess.serverUrl });
  }
}

/** Busca un doc renombrado/movido a `newPath`: mismo contenido y su archivo ya no está. */
async function findMovedDoc(rt: SessionRuntime, content: string, newPath: string): Promise<Doc | null> {
  for (const d of Object.values(state.sessions[rt.vault].docs)) {
    if (d.path === newPath || d.content !== content) continue;
    const stillOnDisk = await vaultRead(rt.vault, d.path);
    if (stillOnDisk == null) return d; // su archivo desapareció -> fue movido acá
  }
  return null;
}

export type VaultInspection = {
  vault: string;
  serverUrl: string;
  token?: string;
  localOnly: { path: string; content: string }[]; // .md locales que no están en el server (importables)
  conflicts: { path: string }[]; // mismo path, distinto contenido (el server pisaría al local)
};

/**
 * Elige una carpeta y la compara con el server SIN escribir nada (con una api
 * efímera, sin tocar las sesiones abiertas): detecta notas locales preexistentes
 * y colisiones. Devuelve null si no se eligió carpeta.
 */
export async function pickVaultAndInspect(serverUrlRaw?: string, token?: string): Promise<VaultInspection | null> {
  const vault = await pickVault();
  if (!vault) return null;
  const serverUrl = (serverUrlRaw ?? DEFAULT_SERVER).replace(/\/$/, "");
  const probe = new BridgesApi(serverUrl);
  probe.setToken(token ?? null);
  await probe.health();
  const [local, sync] = await Promise.all([vaultScan(vault), probe.sync(0)]);
  const serverByPath = new Map(sync.documents.filter((d) => !d.deleted).map((d) => [d.path, d.content]));
  const localOnly: { path: string; content: string }[] = [];
  const conflicts: { path: string }[] = [];
  for (const f of local) {
    if (!serverByPath.has(f.path)) localOnly.push(f);
    else if (serverByPath.get(f.path) !== f.content) conflicts.push({ path: f.path });
  }
  return { vault, serverUrl, token, localOnly, conflicts };
}

/** Sube al server (sesión activa) las notas locales elegidas. */
export async function importLocalDocs(docs: { path: string; content: string }[]) {
  for (const d of docs) {
    try {
      await saveDoc({ path: d.path, content: d.content });
    } catch {
      /* saltear */
    }
  }
}

// --- mutaciones de la sesión enfocada (push al server; el SSE/pull refleja el resultado) ---

export type SaveOutcome =
  | { ok: true; doc: Doc }
  | { conflict: true; server: Doc }
  | { denied: true }
  | { queued: true }; // sin conexión: guardado en disco y encolado para sincronizar

/**
 * Guardado LOCAL: escribe el .md a disco y espeja el doc en el store (id =
 * `local:<path>`). Sin versión/seq/conflicto. Si vino con un id viejo cuyo path
 * cambió, es un move: borra el archivo y el doc viejos.
 */
async function localSave(
  rt: SessionRuntime,
  doc: { id?: string; path: string; title?: string; content: string },
): Promise<SaveOutcome> {
  await vaultWrite(rt.vault, doc.path, doc.content);
  const id = `local:${doc.path}`;
  if (doc.id && doc.id !== id) {
    const oldPath = doc.id.startsWith("local:") ? doc.id.slice("local:".length) : null;
    if (oldPath) await vaultRemove(rt.vault, oldPath).catch(() => {});
    setState("sessions", rt.vault, "docs", doc.id, undefined!);
  }
  const newDoc: Doc = {
    id,
    path: doc.path,
    title: doc.title ?? null,
    content: doc.content,
    version: 0,
    seq: 0,
    deleted: 0,
    updated_by: DEFAULT_AUTHOR,
    updated_at: now(),
  };
  setState("sessions", rt.vault, "docs", id, newDoc);
  return { ok: true, doc: newDoc };
}

export async function saveDoc(
  doc: { id?: string; path: string; title?: string; content: string; base_version?: number },
  author?: string,
): Promise<SaveOutcome> {
  const rt = activeRuntime();
  if (!rt) return { denied: true };
  if (rt.api === null) return localSave(rt, doc);
  const sess = state.sessions[rt.vault];
  const who = author ?? sess.author;
  let res;
  try {
    res = doc.id
      ? await rt.api.update(doc.id, {
          path: doc.path,
          title: doc.title,
          content: doc.content,
          base_version: doc.base_version ?? sess.docs[doc.id]?.version ?? 1,
          author: who,
        })
      : await rt.api.create({ path: doc.path, title: doc.title, content: doc.content, author: who });
  } catch (e) {
    const msg = authMessage(e, "editar este vault");
    if (msg) {
      setNotice(msg);
      return { denied: true };
    }
    if (e instanceof ApiError) throw e; // error del server (5xx): propagar

    // Red caída: persistir en disco + encolar; se sincroniza al reconectar.
    setState("sessions", rt.vault, "online", false);
    await vaultWrite(rt.vault, doc.path, doc.content);
    const id = doc.id ?? `local:${doc.path}`;
    setState("sessions", rt.vault, "docs", id, {
      id,
      path: doc.path,
      title: doc.title ?? null,
      content: doc.content,
      version: doc.base_version ?? sess.docs[doc.id ?? ""]?.version ?? 0,
      seq: 0,
      deleted: 0,
      updated_by: who,
      updated_at: now(),
    });
    await enqueuePush(rt, doc.path);
    return { queued: true };
  }

  if ("conflict" in res) return { conflict: true, server: res.server };

  // Reflejar de inmediato (no esperar al SSE) para UX fluida.
  await applyDocs(rt, [res.doc]);
  if (res.doc.seq > state.sessions[rt.vault].lastSeq) {
    setState("sessions", rt.vault, "lastSeq", res.doc.seq);
    await stateSave(rt.vault, { last_seq: res.doc.seq, server_url: sess.serverUrl });
  }
  return { ok: true, doc: res.doc };
}

/** Borra el .md local, lo saca del store y encola el DELETE para el próximo flush. */
async function queueLocalDelete(rt: SessionRuntime, id: string) {
  const target = state.sessions[rt.vault].docs[id];
  if (!target) return;
  await vaultRemove(rt.vault, target.path).catch(() => {});
  setState("sessions", rt.vault, "docs", id, undefined!);
  markDeleted(rt, target.path);
  await persistIndex(rt);
}

/** Borrado LOCAL: manda el .md a la papelera del SO y saca el doc del store. */
async function localDelete(rt: SessionRuntime, id: string) {
  const target = state.sessions[rt.vault].docs[id];
  if (!target) return;
  await vaultTrash(rt.vault, target.path); // a la papelera del SO (recuperable)
  setState("sessions", rt.vault, "docs", id, undefined!);
}

export async function deleteDoc(id: string, author?: string) {
  const rt = activeRuntime();
  if (!rt) return;
  if (rt.api === null) return localDelete(rt, id);
  const sess = state.sessions[rt.vault];
  const who = author ?? sess.author;
  let doc: Doc;
  try {
    doc = await rt.api.remove(id, who, rt.bulkConfirmed);
  } catch (e) {
    const msg = authMessage(e, "borrar en este vault");
    if (msg) return setNotice(msg);
    if (isBulkGuard(e)) {
      // Guardia anti-vaciado: borrar local + encolar; pedir confirmación.
      await queueLocalDelete(rt, id);
      setState("sessions", rt.vault, "bulkGuard", { count: pendingDeletes(rt) });
      return;
    }
    if (e instanceof ApiError) throw e; // error del server (5xx): propagar
    // Red caída: borrar local + encolar el DELETE; se sincroniza al reconectar.
    setState("sessions", rt.vault, "online", false);
    await queueLocalDelete(rt, id);
    return;
  }
  await applyDocs(rt, [doc]);
  if (doc.seq > state.sessions[rt.vault].lastSeq) {
    setState("sessions", rt.vault, "lastSeq", doc.seq);
    await stateSave(rt.vault, { last_seq: doc.seq, server_url: sess.serverUrl });
  }
}

/** El usuario confirmó el borrado masivo: reintenta los deletes en cola con bypass. */
export async function confirmBulkDelete(vault: string) {
  const rt = runtimes.get(vault);
  if (!rt) return;
  setState("sessions", vault, "bulkGuard", null);
  rt.bulkConfirmed = true;
  try {
    await flushQueue(rt);
  } finally {
    rt.bulkConfirmed = false;
  }
}

/** El usuario canceló: los deletes quedan en cola (no se pierden) para investigar. */
export function cancelBulkDelete(vault: string) {
  setState("sessions", vault, "bulkGuard", null);
}

/** Restaura un doc de la papelera y lo refleja en el store + disco. */
export async function restoreFromTrash(id: string): Promise<boolean> {
  const rt = activeRuntime();
  if (!rt || !rt.api) return false; // la papelera server-side solo existe en vaults con server
  try {
    const doc = await rt.api.restore(id, state.sessions[rt.vault].author);
    await applyDocs(rt, [doc]); // lo trae de vuelta al árbol y al disco
    bumpSeq(rt, doc.seq);
    return true;
  } catch (e) {
    setNotice(authMessage(e, "restaurar en este vault") ?? `No se pudo restaurar: ${e}`);
    return false;
  }
}

/** Borra definitivamente un doc de la papelera (admin). */
export async function purgeFromTrash(id: string): Promise<boolean> {
  const api = activeApi();
  if (!api) return false;
  try {
    await api.purge(id);
    return true;
  } catch (e) {
    setNotice(authMessage(e, "borrar definitivamente en este vault") ?? `No se pudo borrar: ${e}`);
    return false;
  }
}

/** Renombra/mueve un doc cambiándole el path (mantiene el contenido). */
export async function moveDoc(id: string, newPath: string): Promise<SaveOutcome | null> {
  const sess = active();
  if (!sess) return null;
  const doc = sess.docs[id];
  if (!doc) return null;
  if (doc.path === newPath) return { ok: true, doc };
  const res = await saveDoc({ id, path: newPath, content: doc.content, base_version: doc.version }, sess.author);
  if ("conflict" in res) setNotice(`No se pudo mover "${doc.path}": ${res.server.path} cambió en el server.`);
  return res;
}

/** Renombra una carpeta: reescribe el prefijo de path de todos los docs bajo ella. */
export async function renameFolder(oldPrefix: string, newPrefix: string) {
  const sess = active();
  if (!sess) return;
  const op = oldPrefix.replace(/\/+$/, "");
  const np = newPrefix.replace(/\/+$/, "");
  if (!np || op === np) return;
  const affected = Object.values(sess.docs).filter((d) => d.path.startsWith(op + "/"));
  for (const d of affected) await moveDoc(d.id, np + d.path.slice(op.length));
}

/** Borra (lógico) todos los docs bajo una carpeta. */
export async function deleteFolder(prefix: string) {
  const sess = active();
  if (!sess) return;
  const p = prefix.replace(/\/+$/, "");
  const affected = Object.values(sess.docs).filter((d) => d.path.startsWith(p + "/"));
  for (const d of affected) await deleteDoc(d.id, sess.author);
}

export function docList(): Doc[] {
  const sess = active();
  if (!sess) return [];
  return Object.values(sess.docs).sort((a, b) => a.path.localeCompare(b.path));
}

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
    const score =
      (nTitle.includes(nq) ? 3 : 0) + (nPath.includes(nq) ? 2 : 0) + (cHits > 0 ? 1 + Math.min(cHits, 5) : 0);
    if (score === 0) continue;
    const at = nContent.indexOf(nq);
    const snippet =
      at >= 0 ? d.content.slice(Math.max(0, at - 30), at + nq.length + 60).replace(/\s+/g, " ").trim() : "";
    scored.push({ hit: { id: d.id, path: d.path, title: d.title, snippet }, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 50).map((s) => s.hit);
}

export const [browserMode] = createSignal(!isTauri);

// En dev, cerrar SSE + watchers + listeners cuando HMR reemplaza este módulo,
// para no acumular conexiones colgadas que saturan el pool del browser.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const rt of runtimes.values()) {
      rt.unsubscribe?.();
      rt.unwatch?.();
      for (const t of rt.debounce.values()) clearTimeout(t);
    }
    offVaultChange?.();
    offServerChange?.();
    offServerStatus?.();
    netListeners?.();
  });
}
