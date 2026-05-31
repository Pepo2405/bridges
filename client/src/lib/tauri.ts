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

// --- stub en memoria para modo browser ---
const memFiles = new Map<string, string>();
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
    memFiles.set(path, content);
    return;
  }
  await invoke("vault_write", { vault, path, content });
}

export async function vaultRemove(vault: string, path: string): Promise<void> {
  if (!isTauri) {
    memFiles.delete(path);
    return;
  }
  await invoke("vault_remove", { vault, path });
}

/** Lee un archivo del vault. Devuelve null si no existe (p.ej. fue borrado). */
export async function vaultRead(vault: string, path: string): Promise<string | null> {
  if (!isTauri) return memFiles.get(path) ?? null;
  try {
    return await invoke<string>("vault_read", { vault, path });
  } catch {
    return null;
  }
}

/** Arranca el watcher del vault en Rust. No-op en modo browser. */
export async function startWatch(vault: string): Promise<void> {
  if (!isTauri) return;
  await invoke("start_watch", { vault });
}

/** Se suscribe a cambios de archivos del vault. Devuelve un cleanup. */
export async function onVaultChange(cb: (paths: string[]) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string[]>("vault-change", (e) => cb(e.payload));
}

// --- Stream SSE del server (lo maneja Rust en Tauri; el webview no streamea). ---

/** Arranca el stream SSE en Rust. No-op en modo browser. */
export async function startEventStream(serverUrl: string, token: string): Promise<void> {
  if (!isTauri) return;
  await invoke("start_event_stream", { serverUrl, token });
}

/** Detiene el stream SSE en Rust. No-op en modo browser. */
export async function stopEventStream(): Promise<void> {
  if (!isTauri) return;
  await invoke("stop_event_stream");
}

/** Cambios del server (seq) emitidos por el stream nativo. Devuelve un cleanup. */
export async function onServerChange(cb: (seq: number) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<number>("server-change", (e) => cb(e.payload));
}

/** Estado de conexión (bool) del stream nativo. Devuelve un cleanup. */
export async function onServerStatus(cb: (connected: boolean) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<boolean>("server-status", (e) => cb(e.payload));
}

// --- config global de la app: conexiones guardadas (carpeta + servidor) ---

export type Connection = { vault: string; serverUrl: string; token?: string; openedAt: string };
export type AppConfig = { connections: Connection[]; lastVault: string | null };

const EMPTY_CONFIG: AppConfig = { connections: [], lastVault: null };
const CONFIG_KEY = "forge.config";

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
