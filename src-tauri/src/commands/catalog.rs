use crate::{AppState, UiExif, UiItem};
use library_core::{LibraryIndex, build_index, build_index_incremental};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};

fn apply_watcher_paths(paths: HashSet<PathBuf>, state: &AppState) -> bool {
    let mut changed = false;
    for path in paths {
        if let Ok(file_meta) = std::fs::metadata(&path) {
            if media_core::is_supported_media_path(&path)
                && file_meta.is_file()
                && let Ok(metadata) = media_core::read_metadata(&path)
            {
                let _ = state.cache.upsert_metadata(&path, &metadata);
                let item = library_core::LibraryItem {
                    path: path.clone(),
                    metadata,
                    is_video: media_core::is_video_path(&path),
                    size: file_meta.len(),
                    modified: file_meta
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                };
                if let Some(index) = &mut *state.index.write() {
                    index.upsert(item);
                    changed = true;
                }
            }
        } else {
            if let Some(index) = &mut *state.index.write() {
                changed |= index.remove(&path);
            }
            if let Ok(conn) = state.cache.conn() {
                let _ = conn.execute(
                    "DELETE FROM image_metadata WHERE path = ?",
                    library_core::rusqlite::params![path.to_string_lossy()],
                );
                state.cache.schedule_flush();
            }
        }
    }
    changed
}

fn setup_watcher(
    folder_path: &Path,
    state: &Arc<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let path_buf = folder_path.to_path_buf();

    let mut watcher_lock = state.watcher.write();
    if let Some(mut old_watcher) = watcher_lock.take() {
        let _ = old_watcher.unwatch(&path_buf);
    }

    let (event_tx, event_rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
    let worker_state = Arc::clone(state);
    let worker_app = app_handle.clone();
    std::thread::spawn(move || {
        while let Ok(first_paths) = event_rx.recv() {
            let mut pending: HashSet<PathBuf> = first_paths.into_iter().collect();
            while let Ok(paths) = event_rx.recv_timeout(Duration::from_millis(150)) {
                pending.extend(paths);
            }
            if apply_watcher_paths(pending, &worker_state) {
                let _ = worker_app.emit("fs-change", ());
            }
        }
    });

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res
                && matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
                )
            {
                let _ = event_tx.send(event.paths);
            }
        },
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    watcher
        .watch(folder_path, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;
    *watcher_lock = Some(watcher);

    Ok(())
}

#[tauri::command]
pub async fn open_folder_picker(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    let folder = rfd::AsyncFileDialog::new().pick_folder().await;
    let Some(folder) = folder else {
        return Ok(None);
    };
    let folder_path = folder.path().to_path_buf();
    let state_arc = state.inner().clone();
    let path_str = tauri::async_runtime::spawn_blocking(move || {
        let index = build_index(&folder_path, &state_arc.cache).map_err(|e| e.to_string())?;
        let path_str = folder_path.to_string_lossy().to_string();
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
        *state_arc.index.write() = Some(index);

        // Spawn background thread to pre-warm thumbnails in parallel
        let state_clone = state_arc.clone();
        std::thread::spawn(move || {
            state_clone.cache.warm_thumbnails(&paths, 0, 320);
        });

        Ok::<String, String>(path_str)
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = setup_watcher(
        &PathBuf::from(&path_str),
        &state.inner().clone(),
        app_handle,
    );
    crate::rebuild_canonical_roots(&state.inner());
    Ok(Some(path_str))
}

#[derive(serde::Serialize, Clone)]
pub struct OpenMediaResult {
    pub folder: String,
    pub file: String,
}

#[tauri::command]
pub async fn open_media_at_path(
    file_path: String,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<OpenMediaResult, String> {
    let path = PathBuf::from(&file_path);
    if path.is_dir() {
        let folder = open_specific_folder(file_path, state, app_handle).await?;
        return Ok(OpenMediaResult {
            folder,
            file: String::new(),
        });
    }
    if !path.is_file() {
        return Err("Path is not a file or folder".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "File has no parent directory".to_string())?;
    let folder_str = parent.to_string_lossy().to_string();
    let file_str = path.to_string_lossy().to_string();
    open_specific_folder_with_active(
        folder_str.clone(),
        Some(path),
        state.inner().clone(),
        app_handle,
    )
    .await?;
    Ok(OpenMediaResult {
        folder: folder_str,
        file: file_str,
    })
}

#[tauri::command]
pub async fn open_specific_folder(
    path: String,
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    open_specific_folder_with_active(path, None, state.inner().clone(), app_handle).await
}

async fn open_specific_folder_with_active(
    path: String,
    active_path: Option<PathBuf>,
    state_arc: Arc<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let folder_path = PathBuf::from(&path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("The specified path does not exist or is not a directory".to_string());
    }
    let folder_path_clone = folder_path.clone();
    let state_arc_clone = state_arc.clone();
    let path_str = tauri::async_runtime::spawn_blocking(move || {
        let index =
            build_index(&folder_path_clone, &state_arc_clone.cache).map_err(|e| e.to_string())?;
        let path_str = folder_path_clone.to_string_lossy().to_string();
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
        let active_index = active_path
            .as_deref()
            .and_then(|path| index.position(path))
            .unwrap_or(0);
        *state_arc_clone.index.write() = Some(index);

        // Spawn background thread to pre-warm thumbnails in parallel
        let state_clone = state_arc_clone.clone();
        std::thread::spawn(move || {
            state_clone.cache.warm_thumbnails(&paths, active_index, 320);
        });

        Ok::<String, String>(path_str)
    })
    .await
    .map_err(|e| e.to_string())??;

    let _ = setup_watcher(&folder_path, &state_arc, app_handle);
    crate::rebuild_canonical_roots(&state_arc);
    Ok(path_str)
}

fn index_to_ui_items(index: &LibraryIndex) -> Vec<UiItem> {
    index
        .items
        .iter()
        .map(|item| {
            let exif = item.metadata.exif.as_ref().map(|e| UiExif {
                camera: e.camera.clone(),
                aperture: e.aperture.clone(),
                shutter_speed: e.shutter_speed.clone(),
                iso: e.iso.clone(),
                focal_length: e.focal_length.clone(),
                latitude: e.latitude,
                longitude: e.longitude,
            });
            UiItem {
                path: item.path.to_string_lossy().to_string(),
                width: item.metadata.width,
                height: item.metadata.height,
                orientation: item.metadata.orientation,
                format: item.metadata.format.map(|f| format!("{:?}", f)),
                is_video: item.is_video,
                size: item.size,
                modified: item.modified,
                exif,
                focus_score: item.metadata.focus_score,
            }
        })
        .collect()
}

fn exif_to_ui(exif: media_core::ExifData) -> UiExif {
    UiExif {
        camera: exif.camera,
        aperture: exif.aperture,
        shutter_speed: exif.shutter_speed,
        iso: exif.iso,
        focal_length: exif.focal_length,
        latitude: exif.latitude,
        longitude: exif.longitude,
    }
}

#[tauri::command]
pub async fn get_media_metadata(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Option<UiExif>, String> {
    let media_path = PathBuf::from(&path);
    if !crate::is_path_safe(&media_path, &state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut metadata = media_core::read_metadata(&media_path).map_err(|e| e.to_string())?;
        let exif = metadata.exif.clone().map(exif_to_ui);
        if let Some(index) = &mut *state_arc.index.write()
            && let Some(item) = index.get_mut(&media_path)
        {
            metadata.focus_score = metadata.focus_score.or(item.metadata.focus_score);
            item.metadata = metadata.clone();
        }
        state_arc
            .cache
            .upsert_metadata(&media_path, &metadata)
            .map_err(|e| e.to_string())?;
        Ok::<Option<UiExif>, String>(exif)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct RefreshLibraryResult {
    pub folder: String,
    pub items: Vec<UiItem>,
}

#[tauri::command]
pub async fn refresh_active_library(
    state: State<'_, Arc<AppState>>,
    app_handle: tauri::AppHandle,
) -> Result<Option<RefreshLibraryResult>, String> {
    let state_arc = state.inner().clone();
    let state_for_watcher = state_arc.clone();
    let refresh = tauri::async_runtime::spawn_blocking(move || {
        let folder_path = {
            let guard = state_arc.index.read();
            guard.as_ref().map(|idx| idx.root.clone())
        };
        let Some(folder_path) = folder_path else {
            return Ok(None);
        };
        if !folder_path.exists() || !folder_path.is_dir() {
            return Err("The active folder no longer exists".to_string());
        }

        let index = {
            let guard = state_arc.index.read();
            let previous = guard
                .as_ref()
                .ok_or_else(|| "No active library index".to_string())?;
            build_index_incremental(&folder_path, &state_arc.cache, previous)
                .map_err(|e| e.to_string())?
        };
        let path_str = folder_path.to_string_lossy().to_string();
        let items = index_to_ui_items(&index);
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
        *state_arc.index.write() = Some(index);

        state_arc.resolved_thumbs.lock().clear();
        state_arc.preview_cache.clear();
        state_arc.decode_failures.lock().clear();
        state_arc.thumb_failures.lock().clear();
        state_arc.dominant_colors.lock().clear();

        let state_clone = state_arc.clone();
        std::thread::spawn(move || {
            state_clone.cache.warm_thumbnails(&paths, 0, 320);
        });

        Ok(Some(RefreshLibraryResult {
            folder: path_str,
            items,
        }))
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(ref res) = refresh {
        let _ = setup_watcher(&PathBuf::from(&res.folder), &state_for_watcher, app_handle);
        crate::rebuild_canonical_roots(&state_for_watcher);
    }

    Ok(refresh)
}

#[tauri::command]
pub async fn get_folder_items(state: State<'_, Arc<AppState>>) -> Result<Vec<UiItem>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let index_lock = state_arc.index.read();
        if let Some(index) = &*index_lock {
            Ok(index_to_ui_items(index))
        } else {
            Ok(vec![])
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_physical_folder(
    parent_path: String,
    folder_name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if folder_name.contains('/') || folder_name.contains('\\') || folder_name.contains("..") {
        return Err(
            "Invalid folder name: traversal segments or path separators are forbidden".to_string(),
        );
    }

    let parent = std::path::PathBuf::from(&parent_path);
    if !crate::is_path_safe(&parent, &state) {
        return Err(
            "Permission denied: parent directory lies outside safe sandbox boundaries".to_string(),
        );
    }

    let p = parent.join(&folder_name);
    std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_physical_file(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let p = std::path::PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err(
            "Permission denied: path deletion lies outside safe sandbox boundaries".to_string(),
        );
    }

    let state_arc = state.inner().clone();
    let p_clone = p.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if p_clone.exists() {
            trash::delete(&p_clone).map_err(|e| e.to_string())?;
        }

        let mut index_lock = state_arc.index.write();
        if let Some(index) = &mut *index_lock {
            index.remove(&p_clone);
        }

        // Also remove metadata from SQLite database cache
        if let Ok(conn) = state_arc.cache.conn() {
            let _ = conn.execute(
                "DELETE FROM image_metadata WHERE path = ?",
                library_core::rusqlite::params![p_clone.to_string_lossy()],
            );
            state_arc.cache.schedule_flush();
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}
