use crate::AppState;
use library_core::build_index;
use std::path::Path;
use tauri::State;

#[derive(serde::Serialize)]
pub struct CacheClearResult {
    pub bytes_freed: u64,
    pub warnings: Vec<String>,
    /// Number of items in the active folder index after re-index (0 if no folder open).
    pub items_reindexed: usize,
}

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
    pub thumbnail_cache_limit_bytes: u64,
    pub decoded_cache_limit_bytes: u64,
    pub cache_parallelism: usize,
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
            thumbnail_cache_limit_bytes: *state_arc.thumbnail_cache_limit_bytes.read(),
            decoded_cache_limit_bytes: *state_arc.decoded_cache_limit_bytes.read(),
            cache_parallelism: library_core::LibraryCache::cache_parallelism(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_thumbnail_cache_limit(
    limit_gb: f64,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    if !(0.25..=100.0).contains(&limit_gb) {
        return Err("Thumbnail cache limit must be between 0.25 GB and 100 GB".to_string());
    }
    *state.thumbnail_cache_limit_bytes.write() = (limit_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    Ok(())
}

#[tauri::command]
pub async fn set_decoded_cache_limit(
    limit_gb: f64,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    if !(0.5..=100.0).contains(&limit_gb) {
        return Err("Decoded cache limit must be between 0.5 GB and 100 GB".to_string());
    }
    *state.decoded_cache_limit_bytes.write() = (limit_gb * 1024.0 * 1024.0 * 1024.0) as u64;
    Ok(())
}

#[tauri::command]
pub async fn prune_thumbnail_cache(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<u64, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let limit = *state_arc.thumbnail_cache_limit_bytes.read();
        let removed = library_core::prune_dir_lru(state_arc.cache.thumb_dir(), limit);
        state_arc.resolved_thumbs.lock().clear();
        Ok::<u64, String>(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn prune_decoded_cache(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<u64, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let limit = *state_arc.decoded_cache_limit_bytes.read();
        Ok::<u64, String>(state_arc.cache.prune_decoded_to_limit(limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove files under `dir`, tolerating missing paths and locked files.
pub fn clear_directory(dir: &Path) -> (u64, Vec<String>) {
    let mut freed = 0u64;
    let mut warnings = Vec::new();
    if !dir.exists() {
        return (0, warnings);
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        warnings.push(format!("Could not read {}", dir.display()));
        return (0, warnings);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            match std::fs::remove_file(&path) {
                Ok(()) => freed += size,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => warnings.push(format!("{}: {e}", path.display())),
            }
        } else if path.is_dir() {
            let size = get_dir_size(&path);
            match std::fs::remove_dir_all(&path) {
                Ok(()) => freed += size,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    warnings.push(format!("{}: {e}", path.display()));
                    // Best-effort: remove individual files when directory removal fails (e.g. locked).
                    if let Ok(inner) = std::fs::read_dir(&path) {
                        for inner_entry in inner.flatten() {
                            let inner_path = inner_entry.path();
                            if inner_path.is_file() {
                                let inner_size =
                                    inner_entry.metadata().map(|m| m.len()).unwrap_or(0);
                                if std::fs::remove_file(&inner_path).is_ok() {
                                    freed += inner_size;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    (freed, warnings)
}

fn checkpoint_metadata_db(state_arc: &std::sync::Arc<AppState>) {
    if let Ok(conn) = state_arc.cache.conn() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(20);");
    }
    state_arc.cache.schedule_flush();
}

fn clear_metadata_index(state_arc: &std::sync::Arc<AppState>) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
    for table in ["visual_histograms", "image_metadata", "batch_history"] {
        if let Err(e) = conn.execute(&format!("DELETE FROM {table}"), []) {
            warnings.push(format!("Could not clear {table}: {e}"));
        }
    }
    checkpoint_metadata_db(state_arc);
    Ok(warnings)
}

fn reset_user_library_metadata(state_arc: &std::sync::Arc<AppState>) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
    for table in [
        "image_tags",
        "tags",
        "album_images",
        "albums",
        "media_attributes",
    ] {
        if let Err(e) = conn.execute(&format!("DELETE FROM {table}"), []) {
            warnings.push(format!("Could not clear {table}: {e}"));
        }
    }
    checkpoint_metadata_db(state_arc);
    Ok(warnings)
}

fn reset_in_memory_cache(state_arc: &std::sync::Arc<AppState>) {
    state_arc.resolved_thumbs.lock().clear();
    state_arc.dominant_colors.lock().clear();
    state_arc.preview_cache.clear();
    state_arc.decode_failures.lock().clear();
    state_arc.thumb_failures.lock().clear();
}

/// Rebuild the in-memory index for the currently open folder (preserves tags/ratings in DB).
fn reindex_active_folder(state_arc: &std::sync::Arc<AppState>) -> (usize, Vec<String>) {
    let mut warnings = Vec::new();
    let folder = {
        let guard = state_arc.index.read();
        guard.as_ref().map(|idx| idx.root.clone())
    };
    let Some(folder) = folder else {
        return (0, warnings);
    };
    if !folder.exists() || !folder.is_dir() {
        warnings.push("Active folder is no longer available.".to_string());
        return (0, warnings);
    }
    match build_index(&folder, &state_arc.cache) {
        Ok(index) => {
            let count = index.items.len();
            *state_arc.index.write() = Some(index);
            let paths: Vec<std::path::PathBuf> = state_arc
                .index
                .read()
                .as_ref()
                .map(|idx| idx.items.iter().map(|i| i.path.clone()).collect())
                .unwrap_or_default();
            let state_clone = state_arc.clone();
            std::thread::spawn(move || {
                state_clone.cache.warm_thumbnails(&paths, 0, 320);
            });
            (count, warnings)
        }
        Err(e) => {
            warnings.push(format!("Could not re-index active folder: {e}"));
            (0, warnings)
        }
    }
}

#[tauri::command]
pub async fn clear_thumbnail_cache(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<CacheClearResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes_freed, warnings) = clear_directory(state_arc.cache.thumb_dir());
        state_arc.resolved_thumbs.lock().clear();
        state_arc.thumb_failures.lock().clear();
        Ok(CacheClearResult {
            bytes_freed,
            warnings,
            items_reindexed: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_decoded_cache(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<CacheClearResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (bytes_freed, warnings) = clear_directory(state_arc.cache.decoded_dir());
        state_arc.preview_cache.clear();
        state_arc.decode_failures.lock().clear();
        Ok(CacheClearResult {
            bytes_freed,
            warnings,
            items_reindexed: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_metadata_database(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<CacheClearResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut warnings = clear_metadata_index(&state_arc)?;
        state_arc.dominant_colors.lock().clear();
        let (items_reindexed, reindex_warn) = reindex_active_folder(&state_arc);
        warnings.extend(reindex_warn);
        Ok(CacheClearResult {
            bytes_freed: 0,
            warnings,
            items_reindexed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reset_library_metadata(
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<CacheClearResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let warnings = reset_user_library_metadata(&state_arc)?;
        Ok(CacheClearResult {
            bytes_freed: 0,
            warnings,
            items_reindexed: 0,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_decode_failures(
    path: Option<String>,
    state: State<'_, std::sync::Arc<AppState>>,
) -> Result<(), String> {
    let mut guard = state.decode_failures.lock();
    if let Some(p) = path {
        guard.remove(&p);
        state.thumb_failures.lock().remove(&p);
    } else {
        guard.clear();
        state.thumb_failures.lock().clear();
    }
    Ok(())
}

#[tauri::command]
pub async fn purge_cache(state: State<'_, std::sync::Arc<AppState>>) -> Result<CacheClearResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut warnings = clear_metadata_index(&state_arc).unwrap_or_else(|e| vec![e]);
        let (thumb_freed, thumb_warn) = clear_directory(state_arc.cache.thumb_dir());
        let (decoded_freed, decoded_warn) = clear_directory(state_arc.cache.decoded_dir());
        warnings.extend(thumb_warn);
        warnings.extend(decoded_warn);
        reset_in_memory_cache(&state_arc);
        let (items_reindexed, reindex_warn) = reindex_active_folder(&state_arc);
        warnings.extend(reindex_warn);
        Ok(CacheClearResult {
            bytes_freed: thumb_freed + decoded_freed,
            warnings,
            items_reindexed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn clear_directory_removes_files_and_reports_size() {
        let dir = std::env::temp_dir().join(format!("folio_clear_test_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.jpg"), vec![0u8; 128]).unwrap();
        fs::write(dir.join("b.jpg"), vec![0u8; 64]).unwrap();

        let (freed, warnings) = clear_directory(&dir);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(freed, 192);
        assert!(fs::read_dir(&dir).unwrap().next().is_none());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_directory_missing_dir_is_ok() {
        let dir = std::env::temp_dir().join(format!("folio_clear_missing_{}", std::process::id()));
        let (freed, warnings) = clear_directory(&dir);
        assert_eq!(freed, 0);
        assert!(warnings.is_empty());
    }
}
