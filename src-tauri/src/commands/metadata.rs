use crate::AppState;
use library_core::rusqlite;
use media_core::SimpleEdit;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct TagInfo {
    pub name: String,
    pub color: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct AlbumInfo {
    pub id: i64,
    pub name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct MediaAttribute {
    pub path: String,
    pub rating: Option<u8>,
    pub favorite: bool,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct SmartFilter {
    pub tags: Vec<String>,
    pub rating_min: Option<u8>,
    pub favorite: Option<bool>,
    pub formats: Vec<String>,
    pub has_gps: Option<bool>,
    pub camera: Option<String>,
    pub date_range: Option<(i64, i64)>,
    pub size_range: Option<(u64, u64)>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct SmartAlbumInfo {
    pub id: i64,
    pub name: String,
    pub filter: SmartFilter,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
struct SidecarItem {
    path: String,
    tags: Vec<TagInfo>,
    rating: Option<u8>,
    favorite: bool,
    edit: SimpleEdit,
    albums: Vec<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct BatchResult {
    pub success: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

impl BatchResult {
    pub fn push_error(&mut self, error: String) {
        self.failed += 1;
        if self.errors.len() < 10 {
            self.errors.push(error);
        }
    }
}

fn ensure_safe_path(path: &str, state: &AppState) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if !crate::is_path_safe(&p, state) {
        return Err("Permission denied: path lies outside safe sandbox boundaries".to_string());
    }
    Ok(p)
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn set_media_attribute_sync(
    state: &AppState,
    path: &str,
    rating: Option<u8>,
    favorite: Option<bool>,
) -> Result<(), String> {
    if let Some(r) = rating
        && r > 5
    {
        return Err("Rating must be between 0 and 5".to_string());
    }
    let conn = state.cache.conn().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO media_attributes (path, rating, favorite, updated_secs) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
             rating = COALESCE(excluded.rating, media_attributes.rating),
             favorite = COALESCE(?5, media_attributes.favorite),
             updated_secs = excluded.updated_secs",
        rusqlite::params![
            path,
            rating,
            favorite.map(i64::from).unwrap_or(0),
            now_secs(),
            favorite.map(i64::from)
        ],
    )
    .map_err(|e| e.to_string())?;
    state.cache.schedule_flush();
    Ok(())
}

fn set_media_attributes_batch_sync(
    state: &AppState,
    paths: &[String],
    rating: Option<u8>,
    favorite: Option<bool>,
) -> Result<BatchResult, String> {
    if rating.is_some_and(|value| value > 5) {
        return Err("Rating must be between 0 and 5".to_string());
    }
    let mut conn = state.cache.conn().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut stmt = tx
        .prepare_cached(
            "INSERT INTO media_attributes (path, rating, favorite, updated_secs) VALUES (?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET
                 rating = COALESCE(excluded.rating, media_attributes.rating),
                 favorite = COALESCE(?5, media_attributes.favorite),
                 updated_secs = excluded.updated_secs",
        )
        .map_err(|e| e.to_string())?;
    let mut result = BatchResult::default();
    for path in paths {
        match stmt.execute(rusqlite::params![
            path,
            rating,
            favorite.map(i64::from).unwrap_or(0),
            now_secs(),
            favorite.map(i64::from)
        ]) {
            Ok(_) => result.success += 1,
            Err(e) => result.push_error(format!("{path}: {e}")),
        }
    }
    drop(stmt);
    tx.commit().map_err(|e| e.to_string())?;
    state.cache.schedule_flush();
    Ok(result)
}

fn record_batch_history(state: &AppState, operation: &str, payload: serde_json::Value) {
    if let Ok(conn) = state.cache.conn() {
        let _ = conn.execute(
            "INSERT INTO batch_history (operation, payload_json, created_secs) VALUES (?, ?, ?)",
            rusqlite::params![operation, payload.to_string(), now_secs()],
        );
        state.cache.schedule_flush();
    }
}

#[tauri::command]
pub async fn update_exif_metadata(
    path: String,
    camera: Option<String>,
    aperture: Option<String>,
    shutter_speed: Option<String>,
    iso: Option<String>,
    focal_length: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE image_metadata SET camera = ?, aperture = ?, shutter_speed = ?, iso = ?, focal_length = ? WHERE path = ?",
            rusqlite::params![camera, aperture, shutter_speed, iso, focal_length, path],
        ).map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();

        let mut index_lock = state_arc.index.write();
        if let Some(index) = &mut *index_lock {
            if let Some(item) = index.get_mut(PathBuf::from(&path).as_path()) {
                if item.metadata.exif.is_none() {
                    item.metadata.exif = Some(media_core::ExifData::default());
                }
                if let Some(exif) = &mut item.metadata.exif {
                    exif.camera = camera;
                    exif.aperture = aperture;
                    exif.shutter_speed = shutter_speed;
                    exif.iso = iso;
                    exif.focal_length = focal_length;
                }
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_tag_to_image(
    path: String,
    tag_name: String,
    tag_color: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let color = tag_color.unwrap_or_else(|| "#D4A72C".to_string());
        let _ = conn.execute(
            "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)",
            rusqlite::params![tag_name, color],
        );
        conn.execute(
            "INSERT OR IGNORE INTO image_tags (image_path, tag_name) VALUES (?, ?)",
            rusqlite::params![path, tag_name],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_tag_from_image(
    path: String,
    tag_name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM image_tags WHERE image_path = ? AND tag_name = ?",
            rusqlite::params![path, tag_name],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_image_tags(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<TagInfo>, String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT it.tag_name, COALESCE(t.color, '#D4A72C') FROM image_tags it LEFT JOIN tags t ON it.tag_name = t.name WHERE it.image_path = ?"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(rusqlite::params![path], |row| {
            Ok(TagInfo {
                name: row.get(0)?,
                color: row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|e| e.to_string())?);
        }
        Ok::<Vec<TagInfo>, String>(tags)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_all_tags(state: State<'_, Arc<AppState>>) -> Result<Vec<TagInfo>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT name, color FROM tags")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(TagInfo {
                    name: row.get(0)?,
                    color: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(|e| e.to_string())?);
        }
        Ok::<Vec<TagInfo>, String>(tags)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_album(name: String, state: State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO albums (name) VALUES (?)",
            rusqlite::params![name],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<i64, String>(conn.last_insert_rowid())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_image_to_album(
    album_id: i64,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO album_images (album_id, image_path) VALUES (?, ?)",
            rusqlite::params![album_id, path],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_image_from_album(
    album_id: i64,
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM album_images WHERE album_id = ? AND image_path = ?",
            rusqlite::params![album_id, path],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_all_albums(state: State<'_, Arc<AppState>>) -> Result<Vec<AlbumInfo>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name FROM albums")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(AlbumInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut albums = Vec::new();
        for row in rows {
            albums.push(row.map_err(|e| e.to_string())?);
        }
        Ok::<Vec<AlbumInfo>, String>(albums)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_folder_tags_summary(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<(String, String, String)>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let folder_paths: Vec<String> = state_arc
            .index
            .read()
            .as_ref()
            .map(|idx| {
                idx.items
                    .iter()
                    .map(|item| item.path.to_string_lossy().to_string())
                    .collect()
            })
            .unwrap_or_default();

        if folder_paths.is_empty() {
            return Ok(Vec::new());
        }

        let mut conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS active_folder_paths(path TEXT PRIMARY KEY);
             DELETE FROM active_folder_paths;",
        )
        .map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare_cached("INSERT OR IGNORE INTO active_folder_paths(path) VALUES (?)")
                .map_err(|e| e.to_string())?;
            for path in folder_paths {
                insert
                    .execute(rusqlite::params![path])
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut stmt = tx
            .prepare(
                "SELECT it.image_path, it.tag_name, COALESCE(t.color, '#D4A72C')
             FROM active_folder_paths fp
             JOIN image_tags it ON it.image_path = fp.path
             LEFT JOIN tags t ON it.tag_name = t.name",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| e.to_string())?);
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_edit(path: String, state: State<'_, Arc<AppState>>) -> Result<SimpleEdit, String> {
    ensure_safe_path(&path, &state)?;
    let edit = state.edits.read().get(&path).cloned().unwrap_or_default();
    Ok(edit)
}

#[tauri::command]
pub async fn set_edit(
    path: String,
    edit: SimpleEdit,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    ensure_safe_path(&path, &state)?;
    state.edits.write().insert(path, edit);
    Ok(())
}

#[tauri::command]
pub async fn batch_add_tag(
    paths: Vec<String>,
    tag_name: String,
    tag_color: Option<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    if tag_name.trim().is_empty() {
        return Err("Tag name cannot be empty".to_string());
    }
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }

    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let color = tag_color.unwrap_or_else(|| "#D4A72C".to_string());
        let mut result = BatchResult::default();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)",
            rusqlite::params![tag_name, color],
        )
        .map_err(|e| e.to_string())?;

        let mut stmt = tx
            .prepare_cached("INSERT OR IGNORE INTO image_tags (image_path, tag_name) VALUES (?, ?)")
            .map_err(|e| e.to_string())?;
        for path in paths {
            match stmt.execute(rusqlite::params![path, tag_name]) {
                Ok(_) => result.success += 1,
                Err(e) => result.push_error(e.to_string()),
            }
        }
        drop(stmt);
        tx.commit().map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn batch_trash_files(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }

    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = BatchResult::default();
        for path in paths {
            let p = PathBuf::from(&path);
            match trash::delete(&p) {
                Ok(()) => {
                    result.success += 1;
                    if let Ok(conn) = state_arc.cache.conn() {
                        let _ = conn.execute(
                            "DELETE FROM image_metadata WHERE path = ?",
                            rusqlite::params![path],
                        );
                    }
                    if let Some(index) = &mut *state_arc.index.write() {
                        index.remove(&p);
                    }
                }
                Err(e) => result.push_error(e.to_string()),
            }
        }
        state_arc.cache.schedule_flush();
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn batch_scrub_exif(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut result = BatchResult::default();
        for path in paths {
            let p = PathBuf::from(&path);
            match crate::commands::secure::scrub_exif_metadata_file(&p) {
                Ok(_) => result.success += 1,
                Err(e) => result.push_error(format!("{}: {}", p.display(), e)),
            }
        }
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_media_rating(
    paths: Vec<String>,
    rating: Option<u8>,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = set_media_attributes_batch_sync(&state_arc, &paths, rating, None)?;
        record_batch_history(
            &state_arc,
            "set_rating",
            serde_json::json!({ "paths": paths, "rating": rating }),
        );
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_media_favorite(
    paths: Vec<String>,
    favorite: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = set_media_attributes_batch_sync(&state_arc, &paths, None, Some(favorite))?;
        record_batch_history(
            &state_arc,
            "set_favorite",
            serde_json::json!({ "paths": paths, "favorite": favorite }),
        );
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_media_attributes(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<MediaAttribute>, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS requested_attribute_paths(path TEXT PRIMARY KEY);
             DELETE FROM requested_attribute_paths;",
        )
        .map_err(|e| e.to_string())?;
        {
            let mut insert = tx
                .prepare_cached("INSERT OR IGNORE INTO requested_attribute_paths(path) VALUES (?)")
                .map_err(|e| e.to_string())?;
            for path in &paths {
                insert
                    .execute(rusqlite::params![path])
                    .map_err(|e| e.to_string())?;
            }
        }
        let mut stmt = tx
            .prepare(
                "SELECT rp.path, ma.rating, COALESCE(ma.favorite, 0)
                 FROM requested_attribute_paths rp
                 LEFT JOIN media_attributes ma ON ma.path = rp.path",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(MediaAttribute {
                    path: row.get(0)?,
                    rating: row.get(1)?,
                    favorite: row.get::<_, i64>(2)? != 0,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut by_path = HashMap::with_capacity(paths.len());
        for row in rows {
            let attr = row.map_err(|e| e.to_string())?;
            by_path.insert(attr.path.clone(), attr);
        }
        let attrs = paths
            .into_iter()
            .map(|path| {
                by_path.remove(&path).unwrap_or(MediaAttribute {
                    path,
                    rating: None,
                    favorite: false,
                })
            })
            .collect();
        Ok::<Vec<MediaAttribute>, String>(attrs)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_smart_album(
    name: String,
    filter: SmartFilter,
    state: State<'_, Arc<AppState>>,
) -> Result<i64, String> {
    if name.trim().is_empty() {
        return Err("Smart album name cannot be empty".to_string());
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let filter_json = serde_json::to_string(&filter).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO smart_albums (name, filter_json, created_secs, updated_secs) VALUES (?, ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET filter_json = excluded.filter_json, updated_secs = excluded.updated_secs",
            rusqlite::params![name, filter_json, now_secs(), now_secs()],
        )
        .map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<i64, String>(conn.last_insert_rowid())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_smart_albums(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<SmartAlbumInfo>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare("SELECT id, name, filter_json FROM smart_albums ORDER BY name")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let filter_json: String = row.get(2)?;
                let filter = serde_json::from_str(&filter_json).unwrap_or_default();
                Ok(SmartAlbumInfo {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    filter,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut albums = Vec::new();
        for row in rows {
            albums.push(row.map_err(|e| e.to_string())?);
        }
        Ok::<Vec<SmartAlbumInfo>, String>(albums)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn export_sidecar(
    paths: Vec<String>,
    destination: String,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    for path in &paths {
        ensure_safe_path(path, &state)?;
    }
    let dest = PathBuf::from(&destination);
    if let Some(parent) = dest.parent() {
        if !crate::is_path_safe(&parent.to_path_buf(), &state) {
            return Err("Destination lies outside safe sandbox boundaries".to_string());
        }
    }
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut result = BatchResult::default();
        let mut sidecar = Vec::new();
        for path in &paths {
            let tags = {
                let mut stmt = conn
                    .prepare(
                        "SELECT it.tag_name, COALESCE(t.color, '#D4A72C') FROM image_tags it LEFT JOIN tags t ON it.tag_name = t.name WHERE it.image_path = ?",
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(rusqlite::params![path], |row| {
                        Ok(TagInfo {
                            name: row.get(0)?,
                            color: row.get(1)?,
                        })
                    })
                    .map_err(|e| e.to_string())?;
                rows.filter_map(Result::ok).collect::<Vec<_>>()
            };
            let (rating, favorite) = conn
                .query_row(
                    "SELECT rating, favorite FROM media_attributes WHERE path = ?",
                    rusqlite::params![path],
                    |row| Ok((row.get::<_, Option<u8>>(0)?, row.get::<_, i64>(1)? != 0)),
                )
                .unwrap_or((None, false));
            let edit = state_arc.edits.read().get(path).cloned().unwrap_or_default();
            sidecar.push(SidecarItem {
                path: path.clone(),
                tags,
                rating,
                favorite,
                edit,
                albums: Vec::new(),
            });
            result.success += 1;
        }
        let json = serde_json::to_string_pretty(&sidecar).map_err(|e| e.to_string())?;
        std::fs::write(&dest, json).map_err(|e| e.to_string())?;
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_sidecar(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<BatchResult, String> {
    let sidecar_path = ensure_safe_path(&path, &state)?;
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let content = std::fs::read_to_string(&sidecar_path).map_err(|e| e.to_string())?;
        let items: Vec<SidecarItem> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut result = BatchResult::default();
        for item in items {
            if !crate::is_path_safe(&PathBuf::from(&item.path), &state_arc) {
                result.push_error(format!("{}: outside safe roots", item.path));
                continue;
            }
            for tag in item.tags {
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)",
                    rusqlite::params![tag.name, tag.color],
                );
                let _ = conn.execute(
                    "INSERT OR IGNORE INTO image_tags (image_path, tag_name) VALUES (?, ?)",
                    rusqlite::params![item.path, tag.name],
                );
            }
            let _ =
                set_media_attribute_sync(&state_arc, &item.path, item.rating, Some(item.favorite));
            state_arc.edits.write().insert(item.path, item.edit);
            result.success += 1;
        }
        state_arc.cache.schedule_flush();
        Ok::<BatchResult, String>(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
