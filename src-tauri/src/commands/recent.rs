use crate::AppState;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn get_recent_folders(state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    Ok(state.recent_folders.read().clone())
}

#[tauri::command]
pub async fn add_recent_folder(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
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
    crate::rebuild_canonical_roots(&state);
    Ok(())
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
