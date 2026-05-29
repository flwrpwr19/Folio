use crate::{AppState, UiExif, UiItem};
use library_core::{LibraryIndex, build_index};
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{Emitter, State};

fn setup_watcher(
    folder_path: &Path,
    state: &Arc<AppState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state_clone = Arc::clone(state);
    let path_buf = folder_path.to_path_buf();

    let mut watcher_lock = state.watcher.write();
    if let Some(mut old_watcher) = watcher_lock.take() {
        let _ = old_watcher.unwatch(&path_buf);
    }

    let app_handle_clone = app_handle.clone();
    let mut watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                match event.kind {
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_) => {
                        let state_arc = state_clone.clone();
                        let app_h = app_handle_clone.clone();

                        tauri::async_runtime::spawn(async move {
                            let state_for_blocking = state_arc.clone();
                            let res = tauri::async_runtime::spawn_blocking(move || {
                                let mut changed = false;
                                for path in &event.paths {
                                    let is_supported =
                                        match path.extension().and_then(|ext| ext.to_str()) {
                                            Some(ext) => {
                                                let ext_lower = ext.to_ascii_lowercase();
                                                matches!(
                                                    ext_lower.as_str(),
                                                    "jpg"
                                                        | "jpeg"
                                                        | "png"
                                                        | "webp"
                                                        | "gif"
                                                        | "bmp"
                                                        | "heic"
                                                        | "heif"
                                                        | "dng"
                                                        | "raw"
                                                        | "cr2"
                                                        | "nef"
                                                        | "arw"
                                                        | "mp4"
                                                        | "mov"
                                                        | "mkv"
                                                        | "avi"
                                                )
                                            }
                                            None => false,
                                        };

                                    if path.exists() {
                                        if is_supported && path.is_file() {
                                            if let Ok(metadata) = media_core::read_metadata(path) {
                                                let _ = state_for_blocking
                                                    .cache
                                                    .upsert_metadata(path, &metadata);
                                                let is_video = media_core::is_video_path(path);
                                                let file_meta = std::fs::metadata(path).ok();
                                                let size = file_meta
                                                    .as_ref()
                                                    .map(|m| m.len())
                                                    .unwrap_or(0);
                                                let modified = file_meta
                                                    .as_ref()
                                                    .and_then(|m| m.modified().ok())
                                                    .and_then(|t| {
                                                        t.duration_since(std::time::UNIX_EPOCH).ok()
                                                    })
                                                    .map(|d| d.as_secs())
                                                    .unwrap_or(0);
                                                let item = library_core::LibraryItem {
                                                    path: path.clone(),
                                                    metadata,
                                                    is_video,
                                                    size,
                                                    modified,
                                                };

                                                let mut index_lock =
                                                    state_for_blocking.index.write();
                                                if let Some(index) = &mut *index_lock {
                                                    if let Some(existing) = index
                                                        .items
                                                        .iter_mut()
                                                        .find(|it| it.path == *path)
                                                    {
                                                        *existing = item;
                                                    } else {
                                                        index.items.push(item);
                                                    }
                                                    changed = true;
                                                }
                                            }
                                        }
                                    } else {
                                        // Path does not exist anymore (removed/moved)
                                        let mut index_lock = state_for_blocking.index.write();
                                        if let Some(index) = &mut *index_lock {
                                            let original_len = index.items.len();
                                            index.items.retain(|it| it.path != *path);
                                            if index.items.len() != original_len {
                                                changed = true;
                                            }
                                        }

                                        if let Ok(conn) = state_for_blocking.cache.conn() {
                                            let _ = conn.execute(
                                                "DELETE FROM image_metadata WHERE path = ?",
                                                library_core::rusqlite::params![
                                                    path.to_string_lossy()
                                                ],
                                            );
                                            state_for_blocking.cache.schedule_flush();
                                        }
                                    }
                                }
                                changed
                            })
                            .await;
                            if let Ok(true) = res {
                                let _ = app_h.emit("fs-change", ());
                            }
                        });
                    }
                    _ => {}
                }
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
        *state_arc.index.write() = Some(index.clone());

        // Spawn background thread to pre-warm thumbnails in parallel
        let state_clone = state_arc.clone();
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
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
    open_specific_folder(folder_str.clone(), state, app_handle).await?;
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
    let folder_path = PathBuf::from(&path);
    if !folder_path.exists() || !folder_path.is_dir() {
        return Err("The specified path does not exist or is not a directory".to_string());
    }
    let state_arc = state.inner().clone();
    let folder_path_clone = folder_path.clone();
    let state_arc_clone = state_arc.clone();
    let path_str = tauri::async_runtime::spawn_blocking(move || {
        let index =
            build_index(&folder_path_clone, &state_arc_clone.cache).map_err(|e| e.to_string())?;
        let path_str = folder_path_clone.to_string_lossy().to_string();
        *state_arc_clone.index.write() = Some(index.clone());

        // Spawn background thread to pre-warm thumbnails in parallel
        let state_clone = state_arc_clone.clone();
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
        std::thread::spawn(move || {
            state_clone.cache.warm_thumbnails(&paths, 0, 320);
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

        let index = build_index(&folder_path, &state_arc.cache).map_err(|e| e.to_string())?;
        let path_str = folder_path.to_string_lossy().to_string();
        *state_arc.index.write() = Some(index.clone());

        state_arc.resolved_thumbs.lock().clear();
        state_arc.preview_cache.clear();
        state_arc.decode_failures.lock().clear();
        state_arc.thumb_failures.lock().clear();
        state_arc.dominant_colors.lock().clear();

        let items = index_to_ui_items(&index);

        let state_clone = state_arc.clone();
        let paths: Vec<PathBuf> = index.items.iter().map(|item| item.path.clone()).collect();
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
            index.items.retain(|item| item.path != p_clone);
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
