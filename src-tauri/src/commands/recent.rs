use crate::AppState;
use std::sync::Arc;
use tauri::State;

pub fn remember_recent_folder_path(path: String, state: &Arc<AppState>) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() || !p.is_dir() {
        return Err("The specified path does not exist or is not a directory".to_string());
    }
    let mut recents = state.recent_folders.write();
    if let Some(pos) = recents.iter().position(|p| p == &path) {
        recents.remove(pos);
    }
    recents.insert(0, path);
    if recents.len() > 10 {
        recents.pop();
    }
    crate::save_recent_folders(&recents);
    drop(recents);
    crate::rebuild_canonical_roots(state);
    Ok(())
}

#[tauri::command]
pub async fn get_recent_folders(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    let persisted = crate::load_recent_folders();
    let mut recents = state.recent_folders.write();
    for path in persisted.into_iter().rev() {
        if let Some(pos) = recents.iter().position(|p| p == &path) {
            recents.remove(pos);
        }
        recents.insert(0, path);
    }
    if recents.len() > 10 {
        recents.truncate(10);
    }
    let merged = recents.clone();
    drop(recents);
    crate::rebuild_canonical_roots(&state);
    Ok(merged)
}

#[tauri::command]
pub async fn add_recent_folder(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !crate::is_known_library_folder(std::path::Path::new(&path), state.inner()) {
        return Err(
            "Permission denied: folder must be opened with Folio before it can be remembered"
                .to_string(),
        );
    }
    remember_recent_folder_path(path, state.inner())
}

#[tauri::command]
pub async fn clear_recent_folders(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut recents = state.recent_folders.write();
    recents.clear();
    crate::save_recent_folders(&[]);
    drop(recents);
    crate::rebuild_canonical_roots(&state);
    Ok(())
}
