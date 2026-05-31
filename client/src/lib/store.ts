import { createStore } from "solid-js/store";
import { createSignal } from "solid-js";
import { ForgeApi, ApiError, type Doc } from "./api";
import {
  pickVault,
  vaultWrite,
  vaultRemove,
  vaultRead,
  startWatch,
  onVaultChange,
  startEventStream,
  stopEventStream,
  onServerChange,
  onServerStatus,
  stateSave,
  configLoad,
  configSave,
  isTauri,
  type Connection,
} from "./tauri";

const AUTHOR = "yo"; // MVP: sin auth real

type State = {
  vault: string | null;
  serverUrl: string;
  lastSeq: number;
  docs: Record<string, Doc>; // solo vivos (deleted=0)
  connected: boolean;
  syncing: boolean;
  ready: boolean; // vault elegido + primer pull hecho
  booting: boolean; // intentando autoconectar al arrancar
  connections: Connection[]; // conexiones guardadas (carpeta + servidor)
  error: string | null;
  notice: string | null; // aviso transitorio (p.ej. conflicto en sync de fondo)
  perms: { write: boolean; delete: boolean }; // permisos del token actual (gatea la UI)
};

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
  vault: null,
  serverUrl: "http://localhost:4321",
  lastSeq: 0,
  docs: {},
  connected: false,
  syncing: false,
  ready: false,
  booting: true,
  connections: [],
  error: null,
  notice: null,
  perms: { write: true, delete: true },
});

let noticeTimer: ReturnType<typeof setTimeout> | undefined;
export function setNotice(msg: string | null) {
  setState("notice", msg);
  clearTimeout(noticeTimer);
  if (msg) noticeTimer = setTimeout(() => setState("notice", null), 6000);
}

export { state };

export const api = new ForgeApi(state.serverUrl);

let unsubscribe: (() => void) | null = null;

/** Aplica un lote de docs del server: actualiza store y espeja a disco. */
async function applyDocs(vault: string, docs: Doc[]) {
  for (const d of docs) {
    if (d.deleted) {
      await vaultRemove(vault, d.path).catch(() => {});
      setState("docs", d.id, undefined!);
    } else {
      // Si cambió el path, borrar el archivo viejo en disco.
      const prev = state.docs[d.id];
      if (prev && prev.path !== d.path) await vaultRemove(vault, prev.path).catch(() => {});
      await vaultWrite(vault, d.path, d.content);
      setState("docs", d.id, d);
    }
  }
}

/** Mensaje legible para un error de auth (token inválido / sin permiso). */
function authMessage(e: unknown, action: string): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 401) return "Token inválido o ausente.";
  if (e.status === 403) return `No tenés permiso para ${action}.`;
  return null;
}

/** Pull incremental desde lastSeq. Con `throwOnError`, propaga (para el connect inicial). */
export async function pull(opts?: { throwOnError?: boolean }) {
  if (!state.vault || state.syncing) return;
  setState({ syncing: true, error: null });
  try {
    const res = await api.sync(state.lastSeq);
    if (res.documents.length) await applyDocs(state.vault, res.documents);
    if (res.last_seq !== state.lastSeq) {
      setState("lastSeq", res.last_seq);
      await stateSave(state.vault, { last_seq: res.last_seq, server_url: state.serverUrl });
    }
  } catch (e) {
    const msg = authMessage(e, "leer este vault") ?? `Sync falló: ${String(e)}`;
    setState("error", msg);
    if (opts?.throwOnError) throw new Error(msg);
  } finally {
    setState("syncing", false);
  }
}

/** Configura vault + server, hace primer pull y abre el canal SSE. */
export async function connect(opts: { vault: string; serverUrl?: string; token?: string }) {
  const serverUrl = (opts.serverUrl ?? state.serverUrl).replace(/\/$/, "");
  api.setBase(serverUrl);
  api.setToken(opts.token ?? null);

  // Verifica que el server responda antes de tocar el estado (falla rápido).
  // /health es público; el chequeo real del token ocurre en el primer pull.
  await api.health();

  // Sin índice local: el store en memoria arranca vacío, así que hacemos un
  // pull completo (since=0) para rehidratarlo. El last_seq guardado solo sirve
  // como referencia; no alcanza para reconstruir docs (id/version no viven en disco).
  setState({
    vault: opts.vault,
    serverUrl,
    lastSeq: 0,
    docs: {},
  });

  // throwOnError: si el token es inválido/sin permiso, el connect falla y se
  // muestra el error en el gestor de conexiones (en vez de quedar "listo" vacío).
  await pull({ throwOnError: true });

  // Permisos del token: gatean qué botones se habilitan. Si /whoami falla
  // (server viejo, red), asumimos permisos plenos; el server igual valida.
  try {
    const who = await api.whoami();
    setState("perms", permsForRole(who.role, who.authEnabled));
  } catch {
    setState("perms", { write: true, delete: true });
  }

  setState("ready", true);

  // Sync en vivo: en Tauri el stream SSE lo maneja Rust (el WKWebView no entrega
  // respuestas long-lived al JS); en modo browser, fetch-streaming directo.
  unsubscribe?.();
  const onStatus = (connected: boolean) => {
    setState("connected", connected);
    // Al (re)conectar, pull de catch-up: recupera cambios perdidos en el gap
    // entre el pull inicial y que el stream quede vivo (el primer evento tras
    // conectar puede bufferearse). Idempotente.
    if (connected) pull();
  };
  if (isTauri) {
    // Listeners ANTES de arrancar el stream: Rust emite server-status apenas
    // conecta y, si no estuviéramos escuchando, perderíamos ese primer evento.
    const offChange = await onServerChange((seq) => {
      if (seq > state.lastSeq) pull();
    });
    const offStatus = await onServerStatus(onStatus);
    await startEventStream(serverUrl, opts.token ?? "");
    unsubscribe = () => {
      offChange();
      offStatus();
      stopEventStream();
    };
  } else {
    unsubscribe = api.subscribe((seq) => {
      if (seq > state.lastSeq) pull();
    }, onStatus);
  }

  // Sync bidireccional: vigilar la carpeta y pushear ediciones externas.
  // Se arranca DESPUÉS del primer pull para no procesar las escrituras del propio espejo.
  await startWatch(opts.vault);
  unwatch?.();
  unwatch = await onVaultChange((paths) => paths.forEach(scheduleExternal));

  await persistConnection(opts.vault, serverUrl, opts.token);
}

/** Guarda/actualiza la conexión y la marca como la última usada. No rompe la conexión si falla. */
async function persistConnection(vault: string, serverUrl: string, token?: string) {
  try {
    const cfg = await configLoad();
    const others = cfg.connections.filter((c) => c.vault !== vault);
    const connections: Connection[] = [{ vault, serverUrl, token, openedAt: new Date().toISOString() }, ...others];
    await configSave({ connections, lastVault: vault });
    setState("connections", connections);
  } catch (e) {
    console.warn("No se pudo guardar la conexión:", e);
  }
}

/** Carga la config, expone las conexiones y autoconecta a la última usada. */
export async function connectLast(): Promise<boolean> {
  const cfg = await configLoad();
  setState("connections", cfg.connections);
  if (!cfg.lastVault) return false;
  const conn = cfg.connections.find((c) => c.vault === cfg.lastVault);
  if (!conn) return false;
  try {
    await connect({ vault: conn.vault, serverUrl: conn.serverUrl, token: conn.token });
    return true;
  } catch (e) {
    setNotice(`No se pudo abrir "${conn.vault}": ${e}`);
    return false;
  }
}

/** Intento de autoconexión al arrancar. Si falla, muestra el gestor de conexiones. */
export async function boot() {
  setState("booting", true);
  try {
    await connectLast();
  } finally {
    setState("booting", false);
  }
}

/** Cierra la conexión actual (corta SSE + watcher) y vuelve al gestor. */
export function disconnect() {
  unsubscribe?.();
  unsubscribe = null;
  unwatch?.();
  unwatch = null;
  for (const t of debounce.values()) clearTimeout(t);
  debounce.clear();
  setState({ ready: false, vault: null, docs: {}, connected: false, perms: { write: true, delete: true } });
}

/** Elimina una conexión guardada. */
export async function removeConnection(vault: string) {
  const cfg = await configLoad();
  const connections = cfg.connections.filter((c) => c.vault !== vault);
  const lastVault = cfg.lastVault === vault ? connections[0]?.vault ?? null : cfg.lastVault;
  await configSave({ connections, lastVault });
  setState("connections", connections);
}

let unwatch: (() => void) | null = null;
const debounce = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleExternal(path: string) {
  clearTimeout(debounce.get(path));
  debounce.set(
    path,
    setTimeout(() => {
      debounce.delete(path);
      handleExternalChange(path).catch((e) => setNotice(`Error al sincronizar ${path}: ${e}`));
    }, 400),
  );
}

function bumpSeq(seq: number) {
  if (state.vault && seq > state.lastSeq) {
    setState("lastSeq", seq);
    stateSave(state.vault, { last_seq: seq, server_url: state.serverUrl });
  }
}

/** Procesa un cambio detectado en disco: compara con el store y pushea si difiere. */
async function handleExternalChange(path: string) {
  const vault = state.vault;
  if (!vault) return;

  const content = await vaultRead(vault, path);
  if (content == null) return; // archivo borrado -> ignoramos (decisión de diseño)

  const doc = Object.values(state.docs).find((d) => d.path === path);

  if (doc) {
    if (doc.content === content) return; // eco de nuestra propia escritura o sin cambios
    const res = await api.update(doc.id, { path, content, base_version: doc.version, author: AUTHOR });
    if ("conflict" in res) {
      await applyDocs(vault, [res.server]); // gana el server: reescribe el disco
      bumpSeq(res.server.seq);
      setNotice(`Conflicto en ${path}: se mantuvo la versión del server.`);
    } else {
      await applyDocs(vault, [res.doc]);
      bumpSeq(res.doc.seq);
    }
  } else {
    // El archivo no está en el store. ¿Es un rename/move? (mismo contenido que un
    // doc cuyo archivo ya no está en disco). Si sí, movemos ese doc en vez de duplicar.
    const moved = await findMovedDoc(vault, content, path);
    if (moved) {
      const res = await api.update(moved.id, { path, content, base_version: moved.version, author: AUTHOR });
      if ("conflict" in res) {
        await applyDocs(vault, [res.server]);
        bumpSeq(res.server.seq);
        setNotice(`Conflicto al mover ${path}: se mantuvo la versión del server.`);
      } else {
        await applyDocs(vault, [res.doc]);
        bumpSeq(res.doc.seq);
      }
      return;
    }

    // Archivo nuevo de verdad -> crear en el server.
    const res = await api.create({ path, content, author: AUTHOR });
    if ("conflict" in res) {
      await applyDocs(vault, [res.server]);
      bumpSeq(res.server.seq);
    } else {
      await applyDocs(vault, [res.doc]);
      bumpSeq(res.doc.seq);
    }
  }
}

/** Busca un doc que haya sido renombrado/movido a `newPath`: mismo contenido y su archivo ya no está. */
async function findMovedDoc(vault: string, content: string, newPath: string): Promise<Doc | null> {
  for (const d of Object.values(state.docs)) {
    if (d.path === newPath || d.content !== content) continue;
    const stillOnDisk = await vaultRead(vault, d.path);
    if (stillOnDisk == null) return d; // su archivo desapareció -> fue movido acá
  }
  return null;
}

export async function chooseVaultAndConnect(serverUrl?: string, token?: string) {
  const vault = await pickVault();
  if (!vault) return false;
  await connect({ vault, serverUrl, token });
  return true;
}

// --- mutaciones (push al server; el SSE/pull refleja el resultado) ---

export type SaveOutcome = { ok: true; doc: Doc } | { conflict: true; server: Doc } | { denied: true };

export async function saveDoc(
  doc: { id?: string; path: string; title?: string; content: string; base_version?: number },
  author?: string,
): Promise<SaveOutcome> {
  let res;
  try {
    res = doc.id
      ? await api.update(doc.id, {
          path: doc.path,
          title: doc.title,
          content: doc.content,
          base_version: doc.base_version ?? state.docs[doc.id]?.version ?? 1,
          author,
        })
      : await api.create({ path: doc.path, title: doc.title, content: doc.content, author });
  } catch (e) {
    const msg = authMessage(e, "editar este vault");
    if (msg) {
      setNotice(msg);
      return { denied: true };
    }
    throw e;
  }

  if ("conflict" in res) return { conflict: true, server: res.server };

  // Reflejar de inmediato (no esperar al SSE) para UX fluida.
  if (state.vault) await applyDocs(state.vault, [res.doc]);
  if (res.doc.seq > state.lastSeq) {
    setState("lastSeq", res.doc.seq);
    if (state.vault) await stateSave(state.vault, { last_seq: res.doc.seq, server_url: state.serverUrl });
  }
  return { ok: true, doc: res.doc };
}

export async function deleteDoc(id: string, author?: string) {
  let doc: Doc;
  try {
    doc = await api.remove(id, author);
  } catch (e) {
    const msg = authMessage(e, "borrar en este vault");
    if (msg) return setNotice(msg);
    throw e;
  }
  if (state.vault) await applyDocs(state.vault, [doc]);
  if (doc.seq > state.lastSeq) {
    setState("lastSeq", doc.seq);
    if (state.vault) await stateSave(state.vault, { last_seq: doc.seq, server_url: state.serverUrl });
  }
}

/** Renombra/mueve un doc cambiándole el path (mantiene el contenido). */
export async function moveDoc(id: string, newPath: string): Promise<SaveOutcome | null> {
  const doc = state.docs[id];
  if (!doc) return null;
  if (doc.path === newPath) return { ok: true, doc };
  const res = await saveDoc({ id, path: newPath, content: doc.content, base_version: doc.version }, AUTHOR);
  if ("conflict" in res) setNotice(`No se pudo mover "${doc.path}": ${res.server.path} cambió en el server.`);
  return res;
}

/** Renombra una carpeta: reescribe el prefijo de path de todos los docs bajo ella. */
export async function renameFolder(oldPrefix: string, newPrefix: string) {
  const op = oldPrefix.replace(/\/+$/, "");
  const np = newPrefix.replace(/\/+$/, "");
  if (!np || op === np) return;
  const affected = Object.values(state.docs).filter((d) => d.path.startsWith(op + "/"));
  for (const d of affected) await moveDoc(d.id, np + d.path.slice(op.length));
}

/** Borra (lógico) todos los docs bajo una carpeta. */
export async function deleteFolder(prefix: string) {
  const p = prefix.replace(/\/+$/, "");
  const affected = Object.values(state.docs).filter((d) => d.path.startsWith(p + "/"));
  for (const d of affected) await deleteDoc(d.id, AUTHOR);
}

export function docList(): Doc[] {
  return Object.values(state.docs).sort((a, b) => a.path.localeCompare(b.path));
}

export const [browserMode] = createSignal(!isTauri);

// En dev, cerrar SSE + watcher cuando HMR reemplaza este módulo, para no acumular
// conexiones colgadas que saturan el pool del browser (rompe el sync).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe?.();
    unwatch?.();
  });
}
