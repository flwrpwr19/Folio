#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(
    clippy::collapsible_if,
    clippy::collapsible_str_replace,
    clippy::identity_op,
    clippy::io_other_error,
    clippy::manual_div_ceil,
    clippy::manual_split_once,
    clippy::needless_borrow,
    clippy::type_complexity,
    clippy::unnecessary_to_owned
)]

pub mod commands;

use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use library_core::{LibraryCache, LibraryIndex};
use media_core::{SimpleEdit, is_video_path};

#[derive(serde::Serialize)]
pub struct UiExif {
    pub camera: Option<String>,
    pub aperture: Option<String>,
    pub shutter_speed: Option<String>,
    pub iso: Option<String>,
    pub focal_length: Option<String>,
    pub latitude: Option<f64>,
    pub longitude: Option<f64>,
}

#[derive(serde::Serialize)]
pub struct UiItem {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub orientation: u16,
    pub format: Option<String>,
    pub is_video: bool,
    pub size: u64,
    pub modified: u64,
    pub exif: Option<UiExif>,
    pub focus_score: Option<f64>,
}

pub struct AppState {
    pub cache: LibraryCache,
    pub index: RwLock<Option<LibraryIndex>>,
    /// Per-path simple edits — keyed by absolute path string
    pub edits: RwLock<HashMap<String, SimpleEdit>>,
    /// In-memory cache for downscaled preview images (un-edited)
    pub preview_cache: commands::media::ImageLruCache,
    /// List of recently opened folder paths
    pub recent_folders: RwLock<Vec<String>>,
    /// In-memory cache of already resolved thumbnail paths: key is (path_string, max_side), value is thumb_path_string
    pub resolved_thumbs: parking_lot::Mutex<lru::LruCache<(String, u32), String>>,
    pub watcher: RwLock<Option<notify::RecommendedWatcher>>,
    pub dominant_colors: parking_lot::Mutex<lru::LruCache<String, Vec<String>>>,
    /// Pre-computed canonical roots for fast sandbox checks
    pub canonical_roots: RwLock<HashSet<PathBuf>>,
    pub jobs: commands::jobs::JobRegistry,
    pub vault: commands::vault::VaultRuntime,
    pub decode_failures: parking_lot::Mutex<HashSet<String>>,
    /// Paths whose thumbnail generation failed recently (avoid hot-loop retries).
    pub thumb_failures: parking_lot::Mutex<HashSet<String>>,
    pub thumbnail_cache_limit_bytes: RwLock<u64>,
    pub decoded_cache_limit_bytes: RwLock<u64>,
    pub app_handle: parking_lot::RwLock<Option<tauri::AppHandle>>,
}

pub fn get_recents_path() -> std::path::PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let root = base.join("folio-app");
    let _ = std::fs::create_dir_all(&root);
    root.join("recents.json")
}

pub fn load_recent_folders() -> Vec<String> {
    let path = get_recents_path();
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
                let mut valid_list = Vec::new();
                for p_str in list {
                    let p = std::path::Path::new(&p_str);
                    if p.exists() && p.is_dir() {
                        valid_list.push(p_str);
                    }
                }
                return valid_list;
            }
        }
    }
    Vec::new()
}

pub fn save_recent_folders(recents: &[String]) {
    let path = get_recents_path();
    if let Ok(content) = serde_json::to_string(recents) {
        let _ = std::fs::write(path, content);
    }
}

fn parse_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    let s = header.strip_prefix("bytes=")?;
    let mut parts = s.splitn(2, '-');
    let start_str = parts.next()?;
    let end_str = parts.next()?;
    let start: u64 = if start_str.is_empty() {
        let suffix: u64 = end_str.parse().ok()?;
        file_len.saturating_sub(suffix)
    } else {
        start_str.parse().ok()?
    };
    let end: u64 = if end_str.is_empty() {
        file_len.saturating_sub(1)
    } else {
        end_str.parse().ok()?
    };
    if start <= end && start < file_len {
        Some((start, end.min(file_len - 1)))
    } else {
        None
    }
}

pub fn is_path_safe(path: &Path, state: &AppState) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };

    if commands::vault::is_vault_path(&canonical_path) {
        return false;
    }

    let roots = state.canonical_roots.read();
    for root in roots.iter() {
        if canonical_path.starts_with(root) {
            return true;
        }
    }

    false
}

pub fn rebuild_canonical_roots(state: &AppState) {
    let mut new_roots = HashSet::new();

    if let Some(ref idx) = *state.index.read() {
        if let Ok(idx_root) = idx.root.canonicalize() {
            new_roots.insert(idx_root);
        }
    }

    let cache_base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    let cache_root = cache_base.join("folio-app");
    if let Ok(cache_root_canonical) = cache_root.canonicalize() {
        new_roots.insert(cache_root_canonical);
    }

    let recents = state.recent_folders.read();
    for recent_str in recents.iter() {
        let recent_path = PathBuf::from(recent_str);
        if let Ok(recent_canonical) = recent_path.canonicalize() {
            new_roots.insert(recent_canonical);
        }
    }

    *state.canonical_roots.write() = new_roots;
}

struct PendingOpens(Mutex<Vec<PathBuf>>);

#[tauri::command]
fn drain_pending_open_paths(state: tauri::State<'_, PendingOpens>) -> Vec<String> {
    state
        .0
        .lock()
        .unwrap()
        .drain(..)
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

fn main() {
    let cache = LibraryCache::open_default().expect("Failed to open cache");
    let app_state = Arc::new(AppState {
        cache,
        index: RwLock::new(None),
        edits: RwLock::new(HashMap::new()),
        preview_cache: commands::media::ImageLruCache::new(512 * 1024 * 1024), // 512MB RAM preview cache
        recent_folders: RwLock::new(load_recent_folders()),
        resolved_thumbs: parking_lot::Mutex::new(lru::LruCache::new(
            std::num::NonZeroUsize::new(10000).unwrap(),
        )),
        watcher: RwLock::new(None),
        dominant_colors: parking_lot::Mutex::new(lru::LruCache::new(
            std::num::NonZeroUsize::new(10000).unwrap(),
        )),
        canonical_roots: RwLock::new(HashSet::new()),
        jobs: commands::jobs::JobRegistry::default(),
        vault: commands::vault::VaultRuntime::new(),
        decode_failures: parking_lot::Mutex::new(HashSet::new()),
        thumb_failures: parking_lot::Mutex::new(HashSet::new()),
        thumbnail_cache_limit_bytes: RwLock::new(2 * 1024 * 1024 * 1024),
        decoded_cache_limit_bytes: RwLock::new(4 * 1024 * 1024 * 1024),
        app_handle: parking_lot::RwLock::new(None),
    });

    rebuild_canonical_roots(&app_state);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state.clone())
        .manage(PendingOpens(Mutex::new(Vec::new())));

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_plugin_macos_fps::init());
    }

    let state_for_uri = Arc::clone(&app_state);
    builder
        .register_uri_scheme_protocol("folio", move |_ctx, request| {
            let path_str = request.uri().path();
            let mut decoded = urlencoding::decode(path_str)
                .unwrap_or(std::borrow::Cow::Borrowed(path_str))
                .to_string();

            while decoded.starts_with("//") {
                decoded.remove(0);
            }
            if !decoded.starts_with('/') {
                decoded.insert(0, '/');
            }

            let path = std::path::PathBuf::from(&decoded);

            // Path traversal sandboxing guard
            if !is_path_safe(&path, &state_for_uri) {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Access-Control-Allow-Origin", "*")
                    .body("403 Forbidden - Outside sandbox".as_bytes().to_vec())
                    .unwrap();
            }

            let file_meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(vec![])
                        .unwrap();
                }
            };
            let file_len = file_meta.len();
            let mime = mime_guess::from_path(&path).first_or_octet_stream();
            let is_video = is_video_path(&path);

            let modified = file_meta
                .modified()
                .map(|t| {
                    t.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_secs())
                        .unwrap_or(0)
                })
                .unwrap_or(0);
            let etag = format!("W/\"{:x}-{:x}\"", file_len, modified);

            if let Some(if_none_match) = request
                .headers()
                .get("if-none-match")
                .and_then(|v| v.to_str().ok())
            {
                if if_none_match == etag {
                    return tauri::http::Response::builder()
                        .status(304)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(vec![])
                        .unwrap();
                }
            }

            let range_header = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .or_else(|| {
                    if is_video {
                        Some("bytes=0-".to_string())
                    } else {
                        None
                    }
                });

            const STREAM_CHUNK: u64 = 1024 * 1024;

            if file_len > 0 {
                if let Some(ref range_val) = range_header {
                    if let Some((start, end)) = parse_range(range_val, file_len) {
                        let length = end - start + 1;
                        let chunk_size = length.min(STREAM_CHUNK);

                        let file = match std::fs::File::open(&path) {
                            Ok(f) => f,
                            Err(_) => {
                                return tauri::http::Response::builder()
                                    .status(500)
                                    .body(vec![])
                                    .unwrap();
                            }
                        };

                        use std::io::{Read, Seek, SeekFrom};
                        let mut file = file;
                        let _ = file.seek(SeekFrom::Start(start));
                        let mut buf = vec![0u8; chunk_size as usize];
                        let bytes_read = file.read(&mut buf).unwrap_or(0);
                        buf.truncate(bytes_read);
                        return tauri::http::Response::builder()
                            .status(206)
                            .header("Content-Type", mime.as_ref())
                            .header("Accept-Ranges", "bytes")
                            .header(
                                "Content-Range",
                                format!(
                                    "bytes {}-{}/{}",
                                    start,
                                    start.saturating_add(bytes_read as u64).saturating_sub(1),
                                    file_len
                                ),
                            )
                            .header("Content-Length", bytes_read.to_string())
                            .header("Access-Control-Allow-Origin", "*")
                            .body(buf)
                            .unwrap();
                    }
                }
            }

            const MAX_BUFFERED_PROTOCOL_RESPONSE: u64 = 64 * 1024 * 1024;
            if file_len > MAX_BUFFERED_PROTOCOL_RESPONSE {
                return tauri::http::Response::builder()
                    .status(413)
                    .header("Access-Control-Allow-Origin", "*")
                    .body("413 Payload Too Large".as_bytes().to_vec())
                    .unwrap();
            }

            use std::io::Read;
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(vec![])
                        .unwrap();
                }
            };
            let mut file = std::io::BufReader::new(file);
            let mut data = Vec::with_capacity(file_len as usize);
            let _ = file.read_to_end(&mut data);
            let cache_val = if path_str.contains("/thumbs/") || path_str.contains("/decoded/") {
                "public, max-age=604800, immutable"
            } else {
                "public, max-age=3600"
            };
            tauri::http::Response::builder()
                .header("Access-Control-Allow-Origin", "*")
                .header("Content-Type", mime.as_ref())
                .header("Cache-Control", cache_val)
                .header("ETag", etag)
                .header("Content-Length", data.len().to_string())
                .body(data)
                .unwrap()
        })
        .setup(|app| {
            use tauri::Emitter;
            use tauri::Manager;

            if let Some(state) = app.try_state::<std::sync::Arc<AppState>>() {
                *state.app_handle.write() = Some(app.handle().clone());
            }
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            let open_folder = MenuItem::with_id(
                app,
                "open-folder",
                "Open Folder...",
                true,
                Some("CmdOrControl+O"),
            )?;
            let open_in_finder = MenuItem::with_id(
                app,
                "open-in-finder",
                "Open Current Folder in Finder",
                true,
                Some("CmdOrControl+Shift+O"),
            )?;
            let settings =
                MenuItem::with_id(app, "settings", "Settings...", true, Some("CmdOrControl+,"))?;
            let file_menu =
                Submenu::with_items(app, "File", true, &[&open_folder, &open_in_finder])?;
            #[cfg(target_os = "macos")]
            let quit = PredefinedMenuItem::quit(app, None)?;
            #[cfg(target_os = "macos")]
            let app_menu = Submenu::with_items(app, "Folio", true, &[&settings, &quit])?;
            #[cfg(not(target_os = "macos"))]
            let app_menu = Submenu::with_items(app, "Folio", true, &[&settings])?;
            let menu = Menu::with_items(app, &[&app_menu, &file_menu])?;
            app.set_menu(menu)?;
            let handle = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                let id: &str = event.id().as_ref();
                match id {
                    "open-folder" => {
                        let _ = handle.emit("menu-open-folder", ());
                    }
                    "open-in-finder" => {
                        let _ = handle.emit("menu-open-in-finder", ());
                    }
                    "settings" => {
                        let _ = handle.emit("menu-settings", ());
                    }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::catalog::open_folder_picker,
            commands::catalog::open_specific_folder,
            commands::catalog::open_media_at_path,
            drain_pending_open_paths,
            commands::catalog::get_folder_items,
            commands::catalog::refresh_active_library,
            commands::catalog::create_physical_folder,
            commands::catalog::delete_physical_file,
            commands::recent::get_recent_folders,
            commands::recent::add_recent_folder,
            commands::recent::clear_recent_folders,
            commands::media::set_window_vibrancy,
            commands::media::trigger_macos_sound,
            commands::media::get_thumbnail,
            commands::media::get_full_image,
            commands::media::prepare_edit_preview,
            commands::media::edit_image,
            commands::media::export_edited,
            commands::media::get_dominant_colors,
            commands::media::get_folder_dominant_colors,
            commands::media::find_visual_duplicates,
            commands::media::batch_transcode,
            commands::media::prefetch_media,
            commands::media::prefetch_decoded_media,
            commands::media::get_visual_histogram,
            commands::metadata::update_exif_metadata,
            commands::metadata::add_tag_to_image,
            commands::metadata::remove_tag_from_image,
            commands::metadata::get_image_tags,
            commands::metadata::get_all_tags,
            commands::metadata::create_album,
            commands::metadata::add_image_to_album,
            commands::metadata::remove_image_from_album,
            commands::metadata::get_all_albums,
            commands::metadata::get_folder_tags_summary,
            commands::metadata::get_edit,
            commands::metadata::set_edit,
            commands::metadata::batch_add_tag,
            commands::metadata::batch_trash_files,
            commands::metadata::batch_scrub_exif,
            commands::metadata::set_media_rating,
            commands::metadata::set_media_favorite,
            commands::metadata::get_media_attributes,
            commands::metadata::save_smart_album,
            commands::metadata::get_smart_albums,
            commands::metadata::export_sidecar,
            commands::metadata::import_sidecar,
            commands::jobs::start_batch_job,
            commands::jobs::get_job_status,
            commands::jobs::cancel_job,
            commands::vault::vault_status,
            commands::vault::vault_create,
            commands::vault::vault_unlock,
            commands::vault::vault_lock,
            commands::vault::vault_add_files,
            commands::vault::vault_export_files,
            commands::vault::vault_set_auto_lock,
            commands::vault::vault_repair_catalog,
            commands::platform::macos_haptic_tick,
            commands::platform::classify_image_path,
            commands::platform::play_live_photo_native,
            commands::storage::get_storage_diagnostics,
            commands::storage::purge_cache,
            commands::storage::clear_thumbnail_cache,
            commands::storage::clear_decoded_cache,
            commands::storage::clear_metadata_database,
            commands::storage::reset_library_metadata,
            commands::storage::clear_decode_failures,
            commands::storage::set_thumbnail_cache_limit,
            commands::storage::set_decoded_cache_limit,
            commands::storage::prune_thumbnail_cache,
            commands::storage::prune_decoded_cache,
            commands::secure::authenticate_vault,
            commands::secure::scrub_exif_metadata,
            commands::secure::audit_file_checksum,
            commands::secure::search_directory_spotlight,
            commands::secure::show_native_share_sheet,
            commands::secure::open_in_finder,
            commands::secure::submit_crash_report,
            commands::macos::set_default_media_handler,
            commands::macos::show_file_open_with_help,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Opened { urls } = event {
                use tauri::Emitter;
                use tauri::Manager;
                let paths = {
                    #[cfg(target_os = "macos")]
                    {
                        commands::macos::paths_from_opened_urls(&urls)
                    }
                    #[cfg(not(target_os = "macos"))]
                    {
                        urls.iter()
                            .filter_map(|u| u.to_file_path().ok())
                            .collect::<Vec<_>>()
                    }
                };
                if !paths.is_empty() {
                    if let Some(pending) = app.try_state::<PendingOpens>() {
                        pending.0.lock().unwrap().extend(paths.clone());
                    }
                    if let Some(path) = paths.last() {
                        let _ = app.emit("folio-open-path", path.to_string_lossy().to_string());
                    }
                }
            }
        });
}
