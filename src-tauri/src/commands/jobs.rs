use crate::AppState;
use library_core::rusqlite;
use parking_lot::RwLock;
use rayon::prelude::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::State;

#[derive(Clone, Default)]
pub struct JobRegistry {
    inner: Arc<RwLock<HashMap<String, JobRecord>>>,
}

#[derive(Clone)]
struct JobRecord {
    status: JobStatus,
    cancel: Arc<AtomicBool>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct JobStarted {
    pub job_id: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct JobStatus {
    pub job_id: String,
    pub operation: String,
    pub state: String,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BatchOperation {
    Transcode {
        paths: Vec<String>,
        target_format: String,
    },
    TrashFiles {
        paths: Vec<String>,
    },
    ScrubExif {
        paths: Vec<String>,
    },
    AddTag {
        paths: Vec<String>,
        tag_name: String,
        tag_color: Option<String>,
    },
    SetRating {
        paths: Vec<String>,
        rating: Option<u8>,
    },
    SetFavorite {
        paths: Vec<String>,
        favorite: bool,
    },
    ThumbnailWarmup {
        paths: Vec<String>,
        max_side: u32,
    },
    FolderPreload {
        paths: Vec<String>,
        thumbnail_sizes: Vec<u32>,
        decode_viewer_images: bool,
    },
    VaultAdd {
        paths: Vec<String>,
    },
    VaultExport {
        ids: Vec<String>,
        destination: String,
    },
}

fn job_update(state: &Arc<AppState>, job_id: &str, update: impl FnOnce(&mut JobStatus)) {
    state.jobs.update(job_id, update);
    if let Some(status) = state.jobs.get(job_id) {
        if let Some(app) = state.app_handle.read().clone() {
            let _ = app.emit("job-update", status);
        }
    }
}

impl JobRegistry {
    fn insert(&self, operation: String, total: usize) -> (String, Arc<AtomicBool>) {
        let job_id = uuid::Uuid::new_v4().to_string();
        let cancel = Arc::new(AtomicBool::new(false));
        let status = JobStatus {
            job_id: job_id.clone(),
            operation,
            state: "running".to_string(),
            total,
            completed: 0,
            failed: 0,
            errors: Vec::new(),
        };
        self.inner.write().insert(
            job_id.clone(),
            JobRecord {
                status,
                cancel: cancel.clone(),
            },
        );
        (job_id, cancel)
    }

    fn update<F: FnOnce(&mut JobStatus)>(&self, job_id: &str, update: F) {
        if let Some(record) = self.inner.write().get_mut(job_id) {
            update(&mut record.status);
        }
    }

    fn get(&self, job_id: &str) -> Option<JobStatus> {
        self.inner.read().get(job_id).map(|r| r.status.clone())
    }

    fn cancel(&self, job_id: &str) -> bool {
        if let Some(record) = self.inner.read().get(job_id) {
            record.cancel.store(true, Ordering::SeqCst);
            true
        } else {
            false
        }
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn record_history(state: &AppState, operation: &str, payload: &serde_json::Value) {
    if let Ok(conn) = state.cache.conn() {
        let _ = conn.execute(
            "INSERT INTO batch_history (operation, payload_json, created_secs) VALUES (?, ?, ?)",
            rusqlite::params![operation, payload.to_string(), now_secs()],
        );
        state.cache.schedule_flush();
    }
}

fn push_job_error(status: &mut JobStatus, error: String) {
    status.failed += 1;
    if status.errors.len() < 10 {
        status.errors.push(error);
    }
}

fn validate_paths(paths: &[String], state: &AppState) -> Result<Vec<PathBuf>, String> {
    paths
        .iter()
        .map(|path| {
            let p = PathBuf::from(path);
            if !crate::is_path_safe(&p, state) {
                return Err(format!("{path}: outside safe sandbox boundaries"));
            }
            Ok(p)
        })
        .collect()
}

const VIEWER_DIRECT_IMAGE_MAX_PIXELS: u64 = 28_000_000;
const VIEWER_DIRECT_IMAGE_MAX_BYTES: u64 = 36 * 1024 * 1024;

fn browser_native_image_ext(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp")
}

pub fn should_preload_decoded_viewer_image(path: &Path, state: &AppState) -> bool {
    if media_core::is_video_path(path) {
        return false;
    }

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !browser_native_image_ext(&ext) {
        return media_core::is_supported_image_path(path);
    }

    let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
    if size > VIEWER_DIRECT_IMAGE_MAX_BYTES {
        return true;
    }

    let dimensions = state
        .index
        .read()
        .as_ref()
        .and_then(|index| index.get(path))
        .map(|item| (item.metadata.width, item.metadata.height))
        .or_else(|| {
            media_core::read_metadata_for_index(path)
                .ok()
                .map(|metadata| (metadata.width, metadata.height))
        });

    dimensions
        .map(|(w, h)| u64::from(w) * u64::from(h) > VIEWER_DIRECT_IMAGE_MAX_PIXELS)
        .unwrap_or(false)
}

fn transcode_one(path: &Path, target: &str) -> Result<(), String> {
    let fmt = match target {
        "jpeg" | "jpg" => image::ImageFormat::Jpeg,
        "png" => image::ImageFormat::Png,
        "webp" => image::ImageFormat::WebP,
        "tiff" | "tif" => image::ImageFormat::Tiff,
        "avif" => image::ImageFormat::Avif,
        _ => return Err(format!("Unsupported format: {target}")),
    };
    let img = media_core::open_image(path).map_err(|e| e.to_string())?;
    let parent = path.parent().unwrap_or(path);
    let dir = parent.join("Transcoded");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let ext = match fmt {
        image::ImageFormat::Jpeg => "jpg",
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        image::ImageFormat::Tiff => "tiff",
        image::ImageFormat::Avif => "avif",
        _ => "dat",
    };
    let hash = blake3::hash(path.to_string_lossy().as_bytes()).to_hex();
    let suffix = hash.as_str().get(..8).unwrap_or("00000000");
    let out_path = dir.join(format!("{stem}-folio-{suffix}.{ext}"));
    image::DynamicImage::ImageRgba8(img.into_rgba8())
        .save_with_format(out_path, fmt)
        .map_err(|e| e.to_string())
}

fn run_path_job<F>(
    _registry: JobRegistry,
    state: Arc<AppState>,
    job_id: String,
    cancel: Arc<AtomicBool>,
    paths: Vec<String>,
    operation: String,
    mut f: F,
) where
    F: FnMut(&str, &Path, &AppState) -> Result<(), String> + Send + 'static,
{
    let payload = serde_json::json!({ "paths": paths });
    record_history(&state, &operation, &payload);
    for path in paths {
        if cancel.load(Ordering::SeqCst) {
            job_update(&state, &job_id, |s| s.state = "cancelled".to_string());
            return;
        }
        let p = PathBuf::from(&path);
        let res = if crate::is_path_safe(&p, &state) {
            let first = f(&path, &p, &state);
            if first.is_err() && !cancel.load(Ordering::SeqCst) {
                f(&path, &p, &state)
            } else {
                first
            }
        } else {
            Err("outside safe sandbox boundaries".to_string())
        };
        job_update(&state, &job_id, |s| {
            s.completed += 1;
            if let Err(e) = res {
                push_job_error(s, format!("{path}: {e}"));
            }
        });
    }
    job_update(&state, &job_id, |s| {
        if s.state == "running" {
            s.state = "completed".to_string();
        }
    });
}

fn operation_total(operation: &BatchOperation) -> usize {
    match operation {
        BatchOperation::Transcode { paths, .. }
        | BatchOperation::TrashFiles { paths }
        | BatchOperation::ScrubExif { paths }
        | BatchOperation::AddTag { paths, .. }
        | BatchOperation::SetRating { paths, .. }
        | BatchOperation::SetFavorite { paths, .. }
        | BatchOperation::ThumbnailWarmup { paths, .. }
        | BatchOperation::VaultAdd { paths } => paths.len(),
        BatchOperation::FolderPreload {
            paths,
            thumbnail_sizes,
            decode_viewer_images,
        } => {
            paths.len() * thumbnail_sizes.len()
                + if *decode_viewer_images {
                    paths.len()
                } else {
                    0
                }
        }
        BatchOperation::VaultExport { ids, .. } => ids.len(),
    }
}

pub fn start_job(operation: BatchOperation, state: Arc<AppState>) -> Result<JobStarted, String> {
    let total = operation_total(&operation);
    let operation_name = match &operation {
        BatchOperation::Transcode { .. } => "transcode",
        BatchOperation::TrashFiles { .. } => "trash_files",
        BatchOperation::ScrubExif { .. } => "scrub_exif",
        BatchOperation::AddTag { .. } => "add_tag",
        BatchOperation::SetRating { .. } => "set_rating",
        BatchOperation::SetFavorite { .. } => "set_favorite",
        BatchOperation::ThumbnailWarmup { .. } => "thumbnail_warmup",
        BatchOperation::FolderPreload { .. } => "folder_preload",
        BatchOperation::VaultAdd { .. } => "vault_add",
        BatchOperation::VaultExport { .. } => "vault_export",
    }
    .to_string();
    let (job_id, cancel) = state.jobs.insert(operation_name.clone(), total);
    let registry = state.jobs.clone();
    let thread_state = state.clone();
    let thread_job_id = job_id.clone();

    match operation {
        BatchOperation::Transcode {
            paths,
            target_format,
        } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    move |_path, p, _state| transcode_one(p, &target_format.to_lowercase()),
                );
            });
        }
        BatchOperation::TrashFiles { paths } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    |path, p, state| {
                        trash::delete(p).map_err(|e| e.to_string())?;
                        if let Ok(conn) = state.cache.conn() {
                            let _ = conn.execute(
                                "DELETE FROM image_metadata WHERE path = ?",
                                rusqlite::params![path],
                            );
                            state.cache.schedule_flush();
                        }
                        Ok(())
                    },
                );
            });
        }
        BatchOperation::ScrubExif { paths } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    |_path, p, _state| {
                        crate::commands::secure::scrub_exif_metadata_file(p).map(|_| ())
                    },
                );
            });
        }
        BatchOperation::AddTag {
            paths,
            tag_name,
            tag_color,
        } => {
            validate_paths(&paths, &state)?;
            if tag_name.trim().is_empty() {
                return Err("Tag name cannot be empty".to_string());
            }
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    move |path, _p, state| {
                        let conn = state.cache.conn().map_err(|e| e.to_string())?;
                        let color = tag_color.clone().unwrap_or_else(|| "#D4A72C".to_string());
                        conn.execute(
                            "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)",
                            rusqlite::params![tag_name, color],
                        )
                        .map_err(|e| e.to_string())?;
                        conn.execute(
                            "INSERT OR IGNORE INTO image_tags (image_path, tag_name) VALUES (?, ?)",
                            rusqlite::params![path, tag_name],
                        )
                        .map_err(|e| e.to_string())?;
                        state.cache.schedule_flush();
                        Ok(())
                    },
                );
            });
        }
        BatchOperation::SetRating { paths, rating } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    move |path, _p, state| {
                        crate::commands::metadata::set_media_attribute_sync(
                            state, path, rating, None,
                        )
                    },
                );
            });
        }
        BatchOperation::SetFavorite { paths, favorite } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                run_path_job(
                    registry,
                    thread_state,
                    thread_job_id,
                    cancel,
                    paths,
                    operation_name,
                    move |path, _p, state| {
                        crate::commands::metadata::set_media_attribute_sync(
                            state,
                            path,
                            None,
                            Some(favorite),
                        )
                    },
                );
            });
        }
        BatchOperation::ThumbnailWarmup { paths, max_side } => {
            let path_bufs = validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                let total = path_bufs.len();
                let parallel = library_core::LibraryCache::cache_parallelism();
                let completed = AtomicUsize::new(0);
                for chunk in path_bufs.chunks(parallel) {
                    if cancel.load(Ordering::SeqCst) {
                        job_update(&thread_state, &thread_job_id, |s| {
                            s.state = "cancelled".to_string();
                        });
                        return;
                    }
                    chunk.par_iter().for_each(|p| {
                        if cancel.load(Ordering::SeqCst) {
                            return;
                        }
                        let path_key = p.to_string_lossy().to_string();
                        let mut res = thread_state.cache.ensure_thumbnail(p, max_side);
                        if res.is_err() {
                            thread_state.thumb_failures.lock().remove(&path_key);
                            res = thread_state.cache.ensure_thumbnail(p, max_side);
                        }
                        if let Err(ref e) = res {
                            thread_state.thumb_failures.lock().insert(path_key);
                            let msg = format!("{}: {e}", p.display());
                            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = done;
                                push_job_error(s, msg);
                            });
                        } else {
                            thread_state.thumb_failures.lock().remove(&path_key);
                            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = done;
                            });
                        }
                    });
                }
                let thumb_limit = *thread_state.thumbnail_cache_limit_bytes.read();
                let _ = thread_state.cache.prune_thumbnails_to_limit(thumb_limit);
                let decode_limit = *thread_state.decoded_cache_limit_bytes.read();
                thread_state.cache.prune_decoded_to_limit(decode_limit);
                job_update(&thread_state, &thread_job_id, |s| {
                    if s.completed < total {
                        s.completed = total;
                    }
                    s.state = "completed".to_string();
                });
            });
        }
        BatchOperation::FolderPreload {
            paths,
            thumbnail_sizes,
            decode_viewer_images,
        } => {
            let path_bufs = validate_paths(&paths, &state)?;
            let thumbnail_sizes = {
                let mut sizes = thumbnail_sizes
                    .into_iter()
                    .map(|size| size.clamp(64, 640))
                    .collect::<Vec<_>>();
                sizes.sort_unstable();
                sizes.dedup();
                if sizes.is_empty() {
                    sizes.push(192);
                }
                sizes
            };
            std::thread::spawn(move || {
                let decode_paths = if decode_viewer_images {
                    path_bufs
                        .iter()
                        .filter(|path| should_preload_decoded_viewer_image(path, &thread_state))
                        .cloned()
                        .collect::<Vec<_>>()
                } else {
                    Vec::new()
                };
                let total = path_bufs.len() * thumbnail_sizes.len() + decode_paths.len();
                job_update(&thread_state, &thread_job_id, |s| {
                    s.total = total;
                });

                let parallel = library_core::LibraryCache::cache_parallelism();
                let completed = AtomicUsize::new(0);

                for max_side in thumbnail_sizes {
                    for chunk in path_bufs.chunks(parallel) {
                        if cancel.load(Ordering::SeqCst) {
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.state = "cancelled".to_string();
                            });
                            return;
                        }
                        chunk.par_iter().for_each(|p| {
                            if cancel.load(Ordering::SeqCst) {
                                return;
                            }
                            let path_key = p.to_string_lossy().to_string();
                            let mut res = thread_state.cache.ensure_thumbnail(p, max_side);
                            if res.is_err() {
                                thread_state.thumb_failures.lock().remove(&path_key);
                                res = thread_state.cache.ensure_thumbnail(p, max_side);
                            }
                            let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                            if let Err(ref e) = res {
                                thread_state.thumb_failures.lock().insert(path_key);
                                let msg = format!("{} thumbnail {max_side}: {e}", p.display());
                                job_update(&thread_state, &thread_job_id, |s| {
                                    s.completed = done;
                                    push_job_error(s, msg);
                                });
                            } else {
                                thread_state.thumb_failures.lock().remove(&path_key);
                                job_update(&thread_state, &thread_job_id, |s| {
                                    s.completed = done;
                                });
                            }
                        });
                    }
                }

                for chunk in decode_paths.chunks(parallel) {
                    if cancel.load(Ordering::SeqCst) {
                        job_update(&thread_state, &thread_job_id, |s| {
                            s.state = "cancelled".to_string();
                        });
                        return;
                    }
                    chunk.par_iter().for_each(|p| {
                        if cancel.load(Ordering::SeqCst) {
                            return;
                        }
                        let path_key = p.to_string_lossy().to_string();
                        let mut res = thread_state.cache.ensure_decoded(p);
                        if res.is_err() {
                            thread_state.decode_failures.lock().remove(&path_key);
                            res = thread_state.cache.ensure_decoded(p);
                        }
                        let done = completed.fetch_add(1, Ordering::SeqCst) + 1;
                        if let Err(ref e) = res {
                            thread_state.decode_failures.lock().insert(path_key);
                            let msg = format!("{} decoded: {e}", p.display());
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = done;
                                push_job_error(s, msg);
                            });
                        } else {
                            thread_state.decode_failures.lock().remove(&path_key);
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = done;
                            });
                        }
                    });
                }

                let thumb_limit = *thread_state.thumbnail_cache_limit_bytes.read();
                let _ = thread_state.cache.prune_thumbnails_to_limit(thumb_limit);
                let decode_limit = *thread_state.decoded_cache_limit_bytes.read();
                thread_state.cache.prune_decoded_to_limit(decode_limit);
                job_update(&thread_state, &thread_job_id, |s| {
                    if s.completed < total {
                        s.completed = total;
                    }
                    s.state = "completed".to_string();
                });
            });
        }
        BatchOperation::VaultAdd { paths } => {
            validate_paths(&paths, &state)?;
            std::thread::spawn(move || {
                let result = crate::commands::vault::vault_add_files_sync(paths, &thread_state);
                job_update(&thread_state, &thread_job_id, |s| {
                    s.completed = result.success + result.failed;
                    s.failed = result.failed;
                    s.errors = result.errors;
                    s.state = "completed".to_string();
                });
            });
        }
        BatchOperation::VaultExport { ids, destination } => {
            std::thread::spawn(move || {
                let result = crate::commands::vault::vault_export_files_sync(
                    ids,
                    destination,
                    &thread_state,
                );
                job_update(&thread_state, &thread_job_id, |s| {
                    s.completed = result.success + result.failed;
                    s.failed = result.failed;
                    s.errors = result.errors;
                    s.state = "completed".to_string();
                });
            });
        }
    }

    Ok(JobStarted { job_id })
}

pub fn start_vault_add_job(paths: Vec<String>, state: Arc<AppState>) -> Result<JobStarted, String> {
    start_job(BatchOperation::VaultAdd { paths }, state)
}

pub fn start_vault_export_job(
    ids: Vec<String>,
    destination: String,
    state: Arc<AppState>,
) -> Result<JobStarted, String> {
    start_job(BatchOperation::VaultExport { ids, destination }, state)
}

#[tauri::command]
pub async fn start_batch_job(
    operation: BatchOperation,
    state: State<'_, Arc<AppState>>,
) -> Result<JobStarted, String> {
    start_job(operation, state.inner().clone())
}

#[tauri::command]
pub async fn get_job_status(
    job_id: String,
    state: State<'_, Arc<AppState>>,
) -> Result<JobStatus, String> {
    state
        .jobs
        .get(&job_id)
        .ok_or_else(|| "Job not found".to_string())
}

#[tauri::command]
pub async fn cancel_job(job_id: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    if state.jobs.cancel(&job_id) {
        Ok(())
    } else {
        Err("Job not found".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{BatchOperation, JobRegistry, browser_native_image_ext, operation_total};

    #[test]
    fn job_registry_tracks_cancel() {
        let registry = JobRegistry::default();
        let (id, _) = registry.insert("test".to_string(), 1);
        assert!(registry.cancel(&id));
        assert!(registry.get(&id).is_some());
    }

    #[test]
    fn folder_preload_total_counts_thumbnail_sizes_and_decode_candidates_upper_bound() {
        let operation = BatchOperation::FolderPreload {
            paths: vec!["/tmp/a.jpg".to_string(), "/tmp/b.heic".to_string()],
            thumbnail_sizes: vec![192, 640],
            decode_viewer_images: true,
        };
        assert_eq!(operation_total(&operation), 6);
    }

    #[test]
    fn browser_native_decode_set_matches_viewer_fast_path() {
        assert!(browser_native_image_ext("jpg"));
        assert!(browser_native_image_ext("webp"));
        assert!(!browser_native_image_ext("heic"));
        assert!(!browser_native_image_ext("tiff"));
    }
}
