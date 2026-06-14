use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use keyring::Entry;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt;

/// Watchers vivos, uno por conexión (conn_id = path del vault). Dropear el valor
/// detiene ese watcher sin tocar los demás.
#[derive(Default)]
struct WatcherState(Mutex<HashMap<String, RecommendedWatcher>>);

/// Generación del stream SSE activo, por conexión. Cada start incrementa el
/// contador de SU conn; el task en curso se detiene cuando ve que la generación
/// cambió (reconexión/disconnect). Parar/reconectar una conn no toca las otras.
#[derive(Default)]
struct StreamState(Mutex<HashMap<String, Arc<AtomicU64>>>);

/// Payloads de eventos hacia el front: todos llevan `conn_id` para que un único
/// listener global en JS los rutee a la sesión correcta.
#[derive(Clone, Serialize)]
struct VaultChange {
    conn_id: String,
    paths: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ServerChange {
    conn_id: String,
    seq: i64,
}

#[derive(Clone, Serialize)]
struct ServerStatus {
    conn_id: String,
    connected: bool,
}

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

#[tauri::command]
fn vault_read(vault: String, path: String) -> Result<String, String> {
    let abs = resolve_in_vault(&vault, &path)?;
    fs::read_to_string(&abs).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct ScannedDoc {
    path: String,
    content: String,
}

/// Escanea el vault y devuelve todos los .md (path relativo + contenido).
/// Ignora ocultos (empiezan con '.') y node_modules. Sirve para detectar
/// notas locales preexistentes al conectar.
#[tauri::command]
fn vault_scan(vault: String) -> Result<Vec<ScannedDoc>, String> {
    let root = PathBuf::from(&vault);
    let mut out = Vec::new();
    scan_dir(&root, &root, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn scan_dir(root: &Path, dir: &Path, out: &mut Vec<ScannedDoc>) -> std::io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            scan_dir(root, &path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            if let (Ok(content), Ok(rel)) = (fs::read_to_string(&path), path.strip_prefix(root)) {
                out.push(ScannedDoc {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    content,
                });
            }
        }
    }
    Ok(())
}

/// Observa el vault y emite "vault-change" con las rutas .md afectadas (relativas).
/// Ignora .bridges/, .obsidian/ y cualquier componente que empiece con punto.
#[tauri::command]
fn start_watch(
    app: AppHandle,
    state: State<WatcherState>,
    conn_id: String,
    vault: String,
) -> Result<(), String> {
    let root = PathBuf::from(&vault);
    let root_cb = root.clone();
    let conn = conn_id.clone();

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
            let _ = app.emit(
                "vault-change",
                VaultChange {
                    conn_id: conn.clone(),
                    paths: rels,
                },
            );
        }
    })
    .map_err(|e| e.to_string())?;

    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // reemplaza (y por ende dropea/detiene) cualquier watcher anterior de esta conn
    state.0.lock().unwrap().insert(conn_id, watcher);
    Ok(())
}

/// Detiene el watcher de una conexión (dropea su entrada del mapa).
#[tauri::command]
fn stop_watch(state: State<WatcherState>, conn_id: String) {
    state.0.lock().unwrap().remove(&conn_id);
}

fn state_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(".bridges").join("state.json")
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

fn index_path(vault: &str) -> PathBuf {
    PathBuf::from(vault).join(".bridges").join("index.json")
}

/// Índice de reconciliación offline (base del 3-way merge + cola de cambios sucios).
/// El schema lo dueña el JS; acá es un blob opaco. Devuelve "" si no existe.
#[tauri::command]
fn index_load(vault: String) -> Result<String, String> {
    Ok(fs::read_to_string(index_path(&vault)).unwrap_or_default())
}

/// Guarda el índice de forma atómica (write a .tmp + rename) para no corromperlo
/// si la app muere a mitad de escritura.
#[tauri::command]
fn index_save(vault: String, data: String) -> Result<(), String> {
    let p = index_path(&vault);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, data).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

/// Config global de la app (lista de conexiones). Vive en el dir de config, no en un vault.
fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("bridges.json"))
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

// --- secretos (tokens) en el keychain del SO, keyeados por path del vault ---
const KEYRING_SERVICE: &str = "bridges";

/// Guarda (o reemplaza) el token de una conexión en el keychain.
#[tauri::command]
fn secret_set(account: String, secret: String) -> Result<(), String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    e.set_password(&secret).map_err(|e| e.to_string())
}

/// Lee el token de una conexión. `None` si no hay entrada (conexión sin token).
#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Borra el token de una conexión. No-op si ya no existe.
#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    let e = Entry::new(KEYRING_SERVICE, &account).map_err(|e| e.to_string())?;
    match e.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Detiene el stream SSE de una conexión (invalida su generación).
#[tauri::command]
fn stop_event_stream(state: State<StreamState>, conn_id: String) {
    if let Some(g) = state.0.lock().unwrap().get(&conn_id) {
        g.fetch_add(1, Ordering::SeqCst);
    }
}

/// Abre `{server_url}/events` desde Rust (con `Authorization: Bearer`), parsea el
/// SSE y emite eventos Tauri: `server-status` (bool conectado) y `server-change`
/// (seq), ambos con `conn_id`. Reconecta con backoff. Se hace en Rust porque el
/// WKWebView no entrega respuestas long-lived al JS (ni con EventSource ni con
/// fetch streaming). La generación es por conn: reconectar una no toca las otras.
#[tauri::command]
fn start_event_stream(
    app: AppHandle,
    state: State<StreamState>,
    conn_id: String,
    server_url: String,
    token: String,
) {
    let generation = {
        let mut map = state.0.lock().unwrap();
        map.entry(conn_id.clone()).or_default().clone()
    };
    let my_gen = generation.fetch_add(1, Ordering::SeqCst) + 1;
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
                    let _ = app.emit(
                        "server-status",
                        ServerStatus {
                            conn_id: conn_id.clone(),
                            connected: true,
                        },
                    );
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
                                        let _ = app.emit(
                                            "server-change",
                                            ServerChange {
                                                conn_id: conn_id.clone(),
                                                seq,
                                            },
                                        );
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
            let _ = app.emit(
                "server-status",
                ServerStatus {
                    conn_id: conn_id.clone(),
                    connected: false,
                },
            );
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

/// Muestra y enfoca la ventana principal (desde el tray o el single-instance).
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// ¿Está habilitado el arranque automático al login?
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Habilita/deshabilita el arranque automático al login (configurable desde la UI).
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let m = app.autolaunch();
    if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance va PRIMERO: si ya hay una corriendo, la segunda
        // invocación solo enfoca la ventana existente y sale.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .manage(StreamState::default())
        .invoke_handler(tauri::generate_handler![
            vault_write,
            vault_remove,
            vault_trash,
            vault_read,
            vault_scan,
            start_watch,
            stop_watch,
            state_load,
            state_save,
            index_load,
            index_save,
            config_load,
            config_save,
            secret_set,
            secret_get,
            secret_delete,
            start_event_stream,
            stop_event_stream,
            get_autostart,
            set_autostart
        ])
        .setup(|app| {
            // System tray: menú Mostrar / Salir + click en el ícono para reabrir.
            let show = MenuItem::with_id(app, "show", "Mostrar Bridges", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Bridges")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        // Cerrar la ventana (la X) la oculta a la bandeja en vez de terminar el
        // proceso: así el SSE y el watcher siguen sincronizando en segundo plano.
        // Salir de verdad: menú "Salir" del tray.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error al arrancar Bridges");
}
