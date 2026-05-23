use std::sync::Arc;
use tauri::State;
use library_core::rusqlite;
use media_core::SimpleEdit;
use crate::AppState;

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
            if let Some(item) = index.items.iter_mut().find(|it| it.path.to_string_lossy() == path) {
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
        ).map_err(|e| e.to_string())?;
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
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM image_tags WHERE image_path = ? AND tag_name = ?",
            rusqlite::params![path, tag_name],
        ).map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_image_tags(path: String, state: State<'_, Arc<AppState>>) -> Result<Vec<TagInfo>, String> {
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
        let mut stmt = conn.prepare("SELECT name, color FROM tags").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
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
pub async fn create_album(name: String, state: State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO albums (name) VALUES (?)",
            rusqlite::params![name],
        ).map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<i64, String>(conn.last_insert_rowid())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn add_image_to_album(album_id: i64, path: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO album_images (album_id, image_path) VALUES (?, ?)",
            rusqlite::params![album_id, path],
        ).map_err(|e| e.to_string())?;
        state_arc.cache.schedule_flush();
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_image_from_album(album_id: i64, path: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM album_images WHERE album_id = ? AND image_path = ?",
            rusqlite::params![album_id, path],
        ).map_err(|e| e.to_string())?;
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
        let mut stmt = conn.prepare("SELECT id, name FROM albums").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(AlbumInfo {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        }).map_err(|e| e.to_string())?;
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
pub async fn get_folder_tags_summary(state: State<'_, Arc<AppState>>) -> Result<Vec<(String, String, String)>, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT it.image_path, it.tag_name, COALESCE(t.color, '#D4A72C') FROM image_tags it LEFT JOIN tags t ON it.tag_name = t.name"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }).map_err(|e| e.to_string())?;
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
    let edit = state.edits.read().get(&path).cloned().unwrap_or_default();
    Ok(edit)
}

#[tauri::command]
pub async fn set_edit(path: String, edit: SimpleEdit, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.edits.write().insert(path, edit);
    Ok(())
}
