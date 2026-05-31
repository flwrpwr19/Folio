use crate::AppState;
use library_core::rusqlite;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
    let out_path = dir.join(format!("{stem}.{ext}"));
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
        let mut res = if crate::is_path_safe(&p, &state) {
            f(&path, &p, &state)
        } else {
            Err("outside safe sandbox boundaries".to_string())
        };
        if res.is_err() && !cancel.load(Ordering::SeqCst) {
            res = f(&path, &p, &state);
        }
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
                for (chunk_idx, chunk) in path_bufs.chunks(parallel).enumerate() {
                    if cancel.load(Ordering::SeqCst) {
                        job_update(&thread_state, &thread_job_id, |s| {
                            s.state = "cancelled".to_string();
                        });
                        return;
                    }
                    for (i, p) in chunk.iter().enumerate() {
                        let idx = chunk_idx * parallel + i;
                        let path_key = p.to_string_lossy().to_string();
                        let mut res = thread_state.cache.ensure_thumbnail(p, max_side);
                        if res.is_err() {
                            thread_state.thumb_failures.lock().remove(&path_key);
                            res = thread_state.cache.ensure_thumbnail(p, max_side);
                        }
                        if let Err(ref e) = res {
                            thread_state.thumb_failures.lock().insert(path_key);
                            let msg = format!("{}: {e}", p.display());
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = idx + 1;
                                push_job_error(s, msg);
                            });
                        } else {
                            thread_state.thumb_failures.lock().remove(&path_key);
                            job_update(&thread_state, &thread_job_id, |s| {
                                s.completed = idx + 1;
                            });
                        }
                    }
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
    use super::JobRegistry;

    #[test]
    fn job_registry_tracks_cancel() {
        let registry = JobRegistry::default();
        let (id, _) = registry.insert("test".to_string(), 1);
        assert!(registry.cancel(&id));
        assert!(registry.get(&id).is_some());
    }
}
