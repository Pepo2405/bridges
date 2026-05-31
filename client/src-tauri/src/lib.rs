use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// Mantiene vivo el watcher del vault (si se dropea, deja de observar).
#[derive(Default)]
struct WatcherState(Mutex<Option<RecommendedWatcher>>);

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            vault_write,
            vault_remove,
            vault_read,
            start_watch,
            state_load,
            state_save,
            config_load,
            config_save
        ])
        .run(tauri::generate_context!())
        .expect("error al arrancar Forge");
}
