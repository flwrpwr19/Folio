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
    pub approved_open_paths: Mutex<Vec<PathBuf>>,
}

fn folio_data_root() -> std::path::PathBuf {
    let base = dirs::data_dir()
        .or_else(dirs::cache_dir)
        .unwrap_or_else(std::env::temp_dir);
    let root = base.join("folio-app");
    let _ = std::fs::create_dir_all(&root);
    root
}

fn legacy_recents_path() -> std::path::PathBuf {
    let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
    base.join("folio-app").join("recents.json")
}

pub fn get_recents_path() -> std::path::PathBuf {
    let root = folio_data_root();
    root.join("recents.json")
}

pub fn load_recent_folders() -> Vec<String> {
    for path in [get_recents_path(), legacy_recents_path()] {
        if let Ok(content) = std::fs::read_to_string(path) {
            if let Ok(list) = serde_json::from_str::<Vec<String>>(&content) {
                let mut valid_list = Vec::new();
                for p_str in list {
                    let p = std::path::Path::new(&p_str);
                    if p.exists() && p.is_dir() {
                        valid_list.push(p_str);
                    }
                }
                if !valid_list.is_empty() {
                    save_recent_folders(&valid_list);
                    return valid_list;
                }
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

/// MIME type for `<video>` / protocol responses. WebKit often rejects `.mov` when served as
/// `video/quicktime` over a custom scheme; H.264/HEVC MOV is served as `video/mp4`.
fn content_type_for_path(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    match ext.as_deref() {
        Some("mp4") | Some("m4v") | Some("mov") => "video/mp4".to_string(),
        Some("webm") => "video/webm".to_string(),
        Some("mkv") => "video/x-matroska".to_string(),
        Some("avi") => "video/x-msvideo".to_string(),
        _ => mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    }
}

fn parse_range(header: &str, file_len: u64) -> Option<(u64, u64)> {
    if file_len == 0 {
        return None;
    }
    let s = header.strip_prefix("bytes=")?;
    let mut parts = s.splitn(2, '-');
    let start_str = parts.next()?;
    let end_str = parts.next()?;

    let (start, end) = if start_str.is_empty() {
        // Suffix range: bytes=-500 (last 500 bytes) — WebKit uses this for moov atoms at EOF.
        let suffix: u64 = end_str.parse().ok()?;
        let start = file_len.saturating_sub(suffix);
        (start, file_len.saturating_sub(1))
    } else {
        let start: u64 = start_str.parse().ok()?;
        let end: u64 = if end_str.is_empty() {
            file_len.saturating_sub(1)
        } else {
            end_str.parse().ok()?
        };
        (start, end.min(file_len.saturating_sub(1)))
    };

    if start <= end && start < file_len {
        Some((start, end))
    } else {
        None
    }
}

fn is_allowed_protocol_origin(origin: &str) -> bool {
    origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
        || origin == "http://localhost:1420"
        || origin == "http://127.0.0.1:1420"
}

fn cors_origin(headers: &tauri::http::HeaderMap) -> Option<String> {
    headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .filter(|origin| is_allowed_protocol_origin(origin))
        .map(str::to_string)
}

fn protocol_response(
    status: u16,
    headers: Vec<(&'static str, String)>,
    cors: Option<&str>,
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    let mut response = tauri::http::Response::builder().status(status);
    if let Some(origin) = cors {
        response = response
            .header("Access-Control-Allow-Origin", origin)
            .header("Vary", "Origin");
    }
    for (name, value) in headers {
        response = response.header(name, value);
    }
    response
        .body(body)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

pub fn is_path_safe(path: &Path, state: &AppState) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };

    if state.vault.contains_canonical_path(&canonical_path) {
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

pub fn is_known_library_folder(path: &Path, state: &AppState) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };

    if let Some(ref idx) = *state.index.read()
        && let Ok(idx_root) = idx.root.canonicalize()
        && (canonical_path == idx_root || canonical_path.starts_with(idx_root))
    {
        return true;
    }

    state.recent_folders.read().iter().any(|recent| {
        PathBuf::from(recent)
            .canonicalize()
            .map(|canonical_recent| canonical_recent == canonical_path)
            .unwrap_or(false)
    })
}

pub fn approve_external_open_path(path: PathBuf, state: &AppState) {
    if let Ok(canonical_path) = path.canonicalize()
        && let Ok(mut approved) = state.approved_open_paths.lock()
    {
        approved.push(canonical_path);
        if approved.len() > 32 {
            let overflow = approved.len().saturating_sub(32);
            approved.drain(0..overflow);
        }
    }
}

pub fn consume_external_open_path(path: &Path, state: &AppState) -> bool {
    let Ok(canonical_path) = path.canonicalize() else {
        return false;
    };
    let Ok(mut approved) = state.approved_open_paths.lock() else {
        return false;
    };
    if let Some(pos) = approved.iter().position(|p| p == &canonical_path) {
        approved.remove(pos);
        return true;
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
        if recent_path.is_dir()
            && let Ok(recent_canonical) = recent_path.canonicalize()
        {
            new_roots.insert(recent_canonical);
        }
    }

    *state.canonical_roots.write() = new_roots;
}

struct PendingOpens(Mutex<Vec<PathBuf>>);

#[tauri::command]
fn drain_pending_open_paths(
    pending_state: tauri::State<'_, PendingOpens>,
    app_state: tauri::State<'_, Arc<AppState>>,
) -> Vec<String> {
    let Ok(mut pending) = pending_state.0.lock() else {
        return Vec::new();
    };
    pending
        .drain(..)
        .map(|p| {
            approve_external_open_path(p.clone(), app_state.inner());
            p.to_string_lossy().into_owned()
        })
        .collect()
}

fn main() {
    let cache = LibraryCache::open_default().unwrap_or_else(|error| {
        eprintln!("Failed to open Folio cache: {error}");
        std::process::exit(1);
    });
    let lru_capacity = std::num::NonZeroUsize::new(10000).unwrap_or(std::num::NonZeroUsize::MIN);
    let app_state = Arc::new(AppState {
        cache,
        index: RwLock::new(None),
        edits: RwLock::new(HashMap::new()),
        preview_cache: commands::media::ImageLruCache::new(512 * 1024 * 1024), // 512MB RAM preview cache
        recent_folders: RwLock::new(load_recent_folders()),
        resolved_thumbs: parking_lot::Mutex::new(lru::LruCache::new(lru_capacity)),
        watcher: RwLock::new(None),
        dominant_colors: parking_lot::Mutex::new(lru::LruCache::new(lru_capacity)),
        canonical_roots: RwLock::new(HashSet::new()),
        jobs: commands::jobs::JobRegistry::default(),
        vault: commands::vault::VaultRuntime::new(),
        decode_failures: parking_lot::Mutex::new(HashSet::new()),
        thumb_failures: parking_lot::Mutex::new(HashSet::new()),
        thumbnail_cache_limit_bytes: RwLock::new(2 * 1024 * 1024 * 1024),
        decoded_cache_limit_bytes: RwLock::new(4 * 1024 * 1024 * 1024),
        app_handle: parking_lot::RwLock::new(None),
        approved_open_paths: Mutex::new(Vec::new()),
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
    let app = builder
        .register_uri_scheme_protocol("folio", move |_ctx, request| {
            let path_str = request.uri().path();
            let allowed_cors_origin = cors_origin(request.headers());
            let cors = allowed_cors_origin.as_deref();
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
                return protocol_response(
                    403,
                    Vec::new(),
                    cors,
                    "403 Forbidden - Outside sandbox".as_bytes().to_vec(),
                );
            }

            let file_meta = match std::fs::metadata(&path) {
                Ok(m) => m,
                Err(_) => {
                    return protocol_response(404, Vec::new(), cors, Vec::new());
                }
            };
            let file_len = file_meta.len();
            let is_video = is_video_path(&path);
            let content_type = if is_video {
                content_type_for_path(&path)
            } else {
                mime_guess::from_path(&path)
                    .first_or_octet_stream()
                    .to_string()
            };

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
                    return protocol_response(304, Vec::new(), cors, Vec::new());
                }
            }

            const MAX_BUFFERED_PROTOCOL_RESPONSE: u64 = 64 * 1024 * 1024;
            const STREAM_CHUNK: u64 = 1024 * 1024;

            let range_header = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
                .or_else(|| {
                    // Large videos cannot be buffered whole; start byte-range delivery.
                    if is_video && file_len > MAX_BUFFERED_PROTOCOL_RESPONSE {
                        Some("bytes=0-".to_string())
                    } else {
                        None
                    }
                });

            if file_len > 0 {
                if let Some(ref range_val) = range_header {
                    if let Some((start, end)) = parse_range(range_val, file_len) {
                        let length = end - start + 1;
                        let max_chunk = if is_video {
                            MAX_BUFFERED_PROTOCOL_RESPONSE
                        } else {
                            STREAM_CHUNK
                        };
                        let chunk_size = length.min(max_chunk);

                        let file = match std::fs::File::open(&path) {
                            Ok(f) => f,
                            Err(_) => {
                                return protocol_response(500, Vec::new(), cors, Vec::new());
                            }
                        };

                        use std::io::{Read, Seek, SeekFrom};
                        let mut file = file;
                        let _ = file.seek(SeekFrom::Start(start));
                        let mut buf = vec![0u8; chunk_size as usize];
                        let bytes_read = file.read(&mut buf).unwrap_or(0);
                        buf.truncate(bytes_read);
                        return protocol_response(
                            206,
                            vec![
                                ("Content-Type", content_type.clone()),
                                ("Accept-Ranges", "bytes".to_string()),
                                (
                                    "Content-Range",
                                    format!(
                                        "bytes {}-{}/{}",
                                        start,
                                        start.saturating_add(bytes_read as u64).saturating_sub(1),
                                        file_len
                                    ),
                                ),
                                ("Content-Length", bytes_read.to_string()),
                            ],
                            cors,
                            buf,
                        );
                    }
                }
            }

            if file_len > MAX_BUFFERED_PROTOCOL_RESPONSE {
                return protocol_response(
                    413,
                    Vec::new(),
                    cors,
                    "413 Payload Too Large".as_bytes().to_vec(),
                );
            }

            use std::io::Read;
            let file = match std::fs::File::open(&path) {
                Ok(f) => f,
                Err(_) => {
                    return protocol_response(404, Vec::new(), cors, Vec::new());
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
            let mut headers = vec![
                ("Content-Type", content_type),
                ("Cache-Control", cache_val.to_string()),
                ("ETag", etag),
                ("Content-Length", data.len().to_string()),
            ];
            if is_video {
                headers.push(("Accept-Ranges", "bytes".to_string()));
            }
            protocol_response(200, headers, cors, data)
        })
        .setup(|app| {
            use tauri::Emitter;
            use tauri::Manager;

            if let Some(state) = app.try_state::<std::sync::Arc<AppState>>() {
                *state.app_handle.write() = Some(app.handle().clone());
            }
            use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
            use tauri::tray::{TrayIconBuilder, TrayIconEvent};

            let mut tray_builder = TrayIconBuilder::new();
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder
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
            commands::catalog::get_folder_preview_summary,
            commands::catalog::get_map_media_points,
            commands::catalog::get_media_metadata,
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
            commands::media::export_edited_with_picker,
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
        .unwrap_or_else(|error| {
            eprintln!("Error while building Tauri application: {error}");
            std::process::exit(1);
        });

    app.run(|app, event| {
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
                    if let Ok(mut pending_paths) = pending.0.lock() {
                        pending_paths.extend(paths.clone());
                    }
                }
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    for path in &paths {
                        approve_external_open_path(path.clone(), state.inner());
                    }
                }
                if let Some(path) = paths.last() {
                    let _ = app.emit("folio-open-path", path.to_string_lossy().to_string());
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mov_uses_mp4_mime_for_html_video() {
        assert_eq!(
            content_type_for_path(Path::new("/tmp/clip.MOV")),
            "video/mp4"
        );
    }

    #[test]
    fn parse_open_ended_range() {
        assert_eq!(parse_range("bytes=0-", 10_000_000), Some((0, 9_999_999)));
    }

    #[test]
    fn parse_suffix_range() {
        assert_eq!(parse_range("bytes=-500", 10_000), Some((9500, 9999)));
    }
}
