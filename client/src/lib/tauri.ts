/**
 * Wrappers sobre los comandos Rust de Tauri para tocar disco.
 * Si la app corre en un browser normal (vite dev sin Tauri), cae a un stub
 * en memoria para poder iterar la UI sin compilar el shell nativo.
 */

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

// --- stub en memoria para modo browser (namespaceado por vault para multi-sesión) ---
const memVaults = new Map<string, Map<string, string>>();
function memFilesFor(vault: string): Map<string, string> {
  let m = memVaults.get(vault);
  if (!m) memVaults.set(vault, (m = new Map()));
  return m;
}
let memState: { last_seq: number; server_url: string } = {
  last_seq: 0,
  server_url: "http://localhost:4321",
};

export async function pickVault(): Promise<string | null> {
  if (!isTauri) return "/browser-vault";
  const { open } = await import("@tauri-apps/plugin-dialog");
  const dir = await open({ directory: true, multiple: false, title: "Elegí la carpeta del vault" });
  return (dir as string) ?? null;
}

export async function vaultWrite(vault: string, path: string, content: string): Promise<void> {
  if (!isTauri) {
    memFilesFor(vault).set(path, content);
    return;
  }
  await invoke("vault_write", { vault, path, content });
}

export async function vaultRemove(vault: string, path: string): Promise<void> {
  if (!isTauri) {
    memFilesFor(vault).delete(path);
    return;
  }
  await invoke("vault_remove", { vault, path });
}

/** Manda un archivo a la papelera del SO (recuperable). Borra del mem en browser. */
export async function vaultTrash(vault: string, path: string): Promise<void> {
  if (!isTauri) {
    memFilesFor(vault).delete(path);
    return;
  }
  await invoke("vault_trash", { vault, path });
}

/** Lee un archivo del vault. Devuelve null si no existe (p.ej. fue borrado). */
export async function vaultRead(vault: string, path: string): Promise<string | null> {
  if (!isTauri) return memFilesFor(vault).get(path) ?? null;
  try {
    return await invoke<string>("vault_read", { vault, path });
  } catch {
    return null;
  }
}

/** Escanea el vault y devuelve los .md preexistentes (path + contenido). */
export async function vaultScan(vault: string): Promise<{ path: string; content: string }[]> {
  if (!isTauri) return [...memFilesFor(vault).entries()].map(([path, content]) => ({ path, content }));
  return invoke<{ path: string; content: string }[]>("vault_scan", { vault });
}

/** Arranca el watcher del vault en Rust (tagueado con connId). No-op en browser. */
export async function startWatch(connId: string, vault: string): Promise<void> {
  if (!isTauri) return;
  await invoke("start_watch", { connId, vault });
}

/** Detiene el watcher de una conexión en Rust. No-op en modo browser. */
export async function stopWatch(connId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_watch", { connId });
}

/**
 * Listener global de cambios de archivos: un único listen() despacha por connId.
 * El store lo registra una sola vez en boot y rutea a la sesión correspondiente.
 * Devuelve un cleanup. No-op en modo browser.
 */
export async function onVaultChange(cb: (connId: string, paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ conn_id: string; paths: string[] }>("vault-change", (e) => cb(e.payload.conn_id, e.payload.paths));
}

// --- Stream SSE del server (lo maneja Rust en Tauri; el webview no streamea). ---

/** Arranca el stream SSE en Rust para una conexión. No-op en modo browser. */
export async function startEventStream(connId: string, serverUrl: string, token: string): Promise<void> {
  if (!isTauri) return;
  await invoke("start_event_stream", { connId, serverUrl, token });
}

/** Detiene el stream SSE de una conexión en Rust. No-op en modo browser. */
export async function stopEventStream(connId: string): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_event_stream", { connId });
}

/** Cambios del server (seq) por connId, emitidos por el stream nativo. Cleanup. */
export async function onServerChange(cb: (connId: string, seq: number) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ conn_id: string; seq: number }>("server-change", (e) => cb(e.payload.conn_id, e.payload.seq));
}

/** Estado de conexión (bool) por connId, del stream nativo. Cleanup. */
export async function onServerStatus(cb: (connId: string, connected: boolean) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<{ conn_id: string; connected: boolean }>("server-status", (e) =>
    cb(e.payload.conn_id, e.payload.connected),
  );
}

// --- config global de la app: conexiones guardadas (carpeta + servidor) ---

export type Connection = { vault: string; serverUrl: string | null; token?: string; openedAt: string; name?: string };
export type AppConfig = { connections: Connection[]; lastVault: string | null };

const EMPTY_CONFIG: AppConfig = { connections: [], lastVault: null };
const CONFIG_KEY = "bridges.config";

export async function configLoad(): Promise<AppConfig> {
  try {
    const raw = isTauri ? await invoke<string>("config_load") : localStorage.getItem(CONFIG_KEY) ?? "";
    if (!raw) return { ...EMPTY_CONFIG };
    const cfg = JSON.parse(raw) as AppConfig;
    return { connections: cfg.connections ?? [], lastVault: cfg.lastVault ?? null };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

export async function configSave(cfg: AppConfig): Promise<void> {
  const data = JSON.stringify(cfg, null, 2);
  if (!isTauri) {
    localStorage.setItem(CONFIG_KEY, data);
    return;
  }
  await invoke("config_save", { data });
}

// --- secretos (tokens) en el keychain del SO. En browser no hay keychain:
// stub en memoria (se pierde al recargar; el token igual vive en el config local). ---

const memSecrets = new Map<string, string>();

/** Guarda el token de una conexión (account = path del vault) en el keychain. */
export async function secretSet(account: string, secret: string): Promise<void> {
  if (!isTauri) {
    memSecrets.set(account, secret);
    return;
  }
  await invoke("secret_set", { account, secret });
}

/** Lee el token de una conexión del keychain. null si no hay. */
export async function secretGet(account: string): Promise<string | null> {
  if (!isTauri) return memSecrets.get(account) ?? null;
  return (await invoke<string | null>("secret_get", { account })) ?? null;
}

/** Borra el token de una conexión del keychain. */
export async function secretDelete(account: string): Promise<void> {
  if (!isTauri) {
    memSecrets.delete(account);
    return;
  }
  await invoke("secret_delete", { account });
}

export type SyncState = { last_seq: number; server_url: string };

export async function stateLoad(vault: string): Promise<SyncState> {
  if (!isTauri) return { ...memState };
  return invoke<SyncState>("state_load", { vault });
}

export async function stateSave(vault: string, state: SyncState): Promise<void> {
  if (!isTauri) {
    memState = { ...state };
    return;
  }
  await invoke("state_save", { vault, lastSeq: state.last_seq, serverUrl: state.server_url });
}

// --- autostart al login (configurable). No-op en browser. ---

export async function getAutostart(): Promise<boolean> {
  if (!isTauri) return false;
  try {
    return await invoke<boolean>("get_autostart");
  } catch {
    return false;
  }
}

export async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri) return;
  await invoke("set_autostart", { enabled });
}

// --- índice de reconciliación offline (.bridges/index.json). Blob opaco; el schema vive en reconcile.ts ---

const memIndex = new Map<string, string>();

/** Lee el índice de reconciliación crudo. "" si no existe. */
export async function indexLoad(vault: string): Promise<string> {
  if (!isTauri) return memIndex.get(vault) ?? "";
  return invoke<string>("index_load", { vault });
}

/** Guarda el índice de reconciliación (atómico en Rust). */
export async function indexSave(vault: string, data: string): Promise<void> {
  if (!isTauri) {
    memIndex.set(vault, data);
    return;
  }
  await invoke("index_save", { vault, data });
}
