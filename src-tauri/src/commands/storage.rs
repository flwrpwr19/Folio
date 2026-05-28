use crate::AppState;
use std::path::Path;
use tauri::State;

#[derive(serde::Serialize)]
pub struct StorageDiagnostics {
    pub db_path: String,
    pub db_size: u64,
    pub cache_path: String,
    pub cache_size: u64,
    pub decoded_path: String,
    pub decoded_size: u64,
    pub memory_used_kb: u64,
    pub cpu_used_pct: f64,
}

fn get_dir_size(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut size = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let meta = entry.metadata().ok();
            if let Some(m) = meta {
                if m.is_file() {
                    size += m.len();
                } else if m.is_dir() {
                    size += get_dir_size(&entry.path());
                }
            }
        }
    }
    size
}

fn get_process_stats() -> (u64, f64) {
    let pid = std::process::id();
    let mut memory_kb = 0;
    let mut cpu_pct = 0.0;

    // Memory query
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            if let Ok(kb) = s.trim().parse::<u64>() {
                memory_kb = kb;
            }
        }
    }

    // CPU query
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-o", "%cpu=", "-p", &pid.to_string()])
        .output()
    {
        if output.status.success() {
            let s = String::from_utf8_lossy(&output.stdout);
            if let Ok(pct) = s.trim().parse::<f64>() {
                cpu_pct = pct;
            }
        }
    }

    (memory_kb, cpu_pct)
}

#[tauri::command]
pub async fn get_storage_diagnostics(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<StorageDiagnostics, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = state_arc.cache.db_path.to_string_lossy().into_owned();
        let db_size = std::fs::metadata(&state_arc.cache.db_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let cache_dir = state_arc.cache.thumb_dir();
        let cache_path = cache_dir.to_string_lossy().into_owned();
        let cache_size = get_dir_size(cache_dir);

        let decoded_dir = state_arc.cache.decoded_dir();
        let decoded_path = decoded_dir.to_string_lossy().into_owned();
        let decoded_size = get_dir_size(decoded_dir);

        let (memory_used_kb, cpu_used_pct) = get_process_stats();

        Ok(StorageDiagnostics {
            db_path,
            db_size,
            cache_path,
            cache_size,
            decoded_path,
            decoded_size,
            memory_used_kb,
            cpu_used_pct,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn purge_cache(state: State<'_, std::sync::Arc<AppState>>) -> Result<(), String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 1. Purge DB tables
        {
            let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM image_metadata", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM albums", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM album_images", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM image_tags", [])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM visual_histograms", [])
                .map_err(|e| e.to_string())?;
            state_arc.cache.schedule_flush();
        }

        // 2. Clear folder files
        let purge_dir = |dir: &Path| -> Result<(), String> {
            if dir.exists() {
                if let Ok(entries) = std::fs::read_dir(dir) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        if path.is_file() {
                            let _ = std::fs::remove_file(&path);
                        } else if path.is_dir() {
                            let _ = std::fs::remove_dir_all(&path);
                        }
                    }
                }
            }
            Ok(())
        };

        purge_dir(state_arc.cache.thumb_dir())?;
        purge_dir(state_arc.cache.decoded_dir())?;

        // 3. Reset in-memory states
        state_arc.resolved_thumbs.lock().clear();
        state_arc.dominant_colors.lock().clear();
        state_arc.preview_cache.clear();

        // If a catalog is loaded, empty its contents so the UI resets
        let mut index_guard = state_arc.index.write();
        if let Some(ref mut idx) = *index_guard {
            idx.items.clear();
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
