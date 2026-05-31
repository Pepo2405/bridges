use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Mantiene vivo el watcher del vault (si se dropea, deja de observar).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

/// Generación del stream SSE activo. Cada start incrementa el contador; el task
/// en curso se detiene cuando ve que la generación cambió (reconexión/disconnect).
#[derive(Default)]
struct StreamState(Arc<AtomicU64>);

#[derive(Serialize, Deserialize)]
struct SyncState {
    #[serde(default)]
    last_seq: i64,
    #[serde(default = "default_server")]
    server_url: String,
}

fn default_server() -> String {
    "http://localhost:4321".to_string()
}

/// Resuelve un path relativo dentro del vault bloqueando traversal (`..`).
fn resolve_in_vault(vault: &str, rel: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault);
    let rel_path = Path::new(rel);
    let mut out = root.clone();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("ruta inválida: {rel}"));
            }
        }
    }
    if !out.starts_with(&root) {
        return Err(format!("la ruta escapa del vault: {rel}"));
    }
    Ok(out)
}

#[tauri::command]
fn vault_write(vault: String, path: String, content: String) -> Result<(), String> {
    let abs = resolve_in_vault(&vault, &path)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&abs, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_remove(vault: String, path: String) -> Result<(), String> {
    let abs = resolve_in_vault(&vault, &path)?;
    match fs::remove_file(&abs) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn vault_read(vault: String, path: String) -> Result<String, String> {
    let abs = resolve_in_vault(&vault, &path)?;
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

/// Observa el vault y emite "vault-change" con las rutas .md afectadas (relativas).
/// Ignora .forge/, .obsidian/ y cualquier componente que empiece con punto.
#[tauri::command]
fn start_watch(app: AppHandle, state: State<WatcherState>, vault: String) -> Result<(), String> {
    let root = PathBuf::from(&vault);
    let root_cb = root.clone();

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        use notify::EventKind::*;
        if !matches!(event.kind, Create(_) | Modify(_) | Remove(_)) {
            return;
        }
        let mut rels: Vec<String> = Vec::new();
        for p in event.paths {
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let hidden = p.components().any(|c| {
                matches!(c, Component::Normal(n) if n.to_str().map_or(false, |s| s.starts_with('.')))
            });
            if hidden {
                continue;
            }
            if let Ok(rel) = p.strip_prefix(&root_cb) {
                rels.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
        if !rels.is_empty() {
            let _ = app.emit("vault-change", rels);
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // reemplaza (y por ende dropea/detiene) cualquier watcher anterior
    *state.0.lock().unwrap() = Some(watcher);
    Ok(())
}

fn state_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(".forge").join("state.json")
}

#[tauri::command]
fn state_load(vault: String) -> Result<SyncState, String> {
    let p = state_path(&vault);
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(_) => Ok(SyncState {
            last_seq: 0,
            server_url: default_server(),
        }),
    }
}

#[tauri::command]
fn state_save(vault: String, last_seq: i64, server_url: String) -> Result<(), String> {
    let p = state_path(&vault);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let state = SyncState { last_seq, server_url };
    let json = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())
}

/// Config global de la app (lista de conexiones). Vive en el dir de config, no en un vault.
fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("forge.json"))
}

#[tauri::command]
fn config_load(app: AppHandle) -> Result<String, String> {
    let p = config_file(&app)?;
    Ok(fs::read_to_string(&p).unwrap_or_default())
}

#[tauri::command]
fn config_save(app: AppHandle, data: String) -> Result<(), String> {
    let p = config_file(&app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&p, data).map_err(|e| e.to_string())
}

/// Detiene el stream SSE actual (invalida su generación).
#[tauri::command]
fn stop_event_stream(state: State<StreamState>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}

/// Abre `{server_url}/events` desde Rust (con `Authorization: Bearer`), parsea el
/// SSE y emite eventos Tauri: `server-status` (bool conectado) y `server-change`
/// (seq). Reconecta con backoff. Se hace en Rust porque el WKWebView no entrega
/// respuestas long-lived al JS (ni con EventSource ni con fetch streaming).
#[tauri::command]
fn start_event_stream(app: AppHandle, state: State<StreamState>, server_url: String, token: String) {
    let my_gen = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let generation = state.0.clone();
    let url = format!("{}/events", server_url.trim_end_matches('/'));

    tauri::async_runtime::spawn(async move {
        let client = reqwest::Client::new();
        while generation.load(Ordering::SeqCst) == my_gen {
            let mut req = client.get(&url);
            if !token.is_empty() {
                req = req.header("Authorization", format!("Bearer {token}"));
            }

            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    let _ = app.emit("server-status", true);
                    let mut stream = resp.bytes_stream();
                    let mut buf = String::new();
                    while let Some(chunk) = stream.next().await {
                        if generation.load(Ordering::SeqCst) != my_gen {
                            return;
                        }
                        let Ok(bytes) = chunk else { break };
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        // Eventos SSE separados por línea en blanco.
                        while let Some(idx) = buf.find("\n\n") {
                            let evt: String = buf.drain(..idx + 2).collect();
                            for line in evt.lines() {
                                let Some(data) = line.strip_prefix("data:") else { continue };
                                let Ok(v) = serde_json::from_str::<serde_json::Value>(data.trim()) else {
                                    continue;
                                };
                                if v.get("type").and_then(|t| t.as_str()) == Some("change") {
                                    if let Some(seq) = v.get("seq").and_then(|s| s.as_i64()) {
                                        let _ = app.emit("server-change", seq);
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(resp) => eprintln!("[sse] respuesta no-ok: status={}", resp.status()),
                Err(e) => eprintln!("[sse] error de conexión: {e}"),
            }

            // Desconectado o error: avisar y reconectar (si seguimos vigentes).
            if generation.load(Ordering::SeqCst) != my_gen {
                return;
            }
            let _ = app.emit("server-status", false);
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(StreamState::default())
        .invoke_handler(tauri::generate_handler![
            vault_write,
            vault_remove,
            vault_read,
            start_watch,
            state_load,
            state_save,
            config_load,
            config_save,
            start_event_stream,
            stop_event_stream
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Forge");
}
