use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

use anyhow::{Context, Result};
use media_core::{
    ImageMetadata, decode_image, is_video_path, read_metadata_for_index,
    scan_supported_images,
};
use r2d2::{Pool, PooledConnection};
use rayon::prelude::*;
pub use rusqlite;
use rusqlite::OptionalExtension;
use std::sync::Arc;

#[derive(Debug)]
pub struct SharedMemoryConnectionManager {
    uri: String,
}

impl SharedMemoryConnectionManager {
    pub fn new(uri: impl Into<String>) -> Self {
        Self { uri: uri.into() }
    }
}

impl r2d2::ManageConnection for SharedMemoryConnectionManager {
    type Connection = rusqlite::Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        use rusqlite::OpenFlags;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_SHARED_CACHE;
        let conn = rusqlite::Connection::open_with_flags(&self.uri, flags)?;
        let _ = conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-64000;
             PRAGMA temp_store=MEMORY;",
        );
        Ok(conn)
    }

    fn is_valid(&self, conn: &mut Self::Connection) -> Result<(), Self::Error> {
        conn.execute_batch("SELECT 1;")
    }

    fn has_broken(&self, _conn: &mut Self::Connection) -> bool {
        false
    }
}

pub struct UpsertRequest {
    pub path: PathBuf,
    pub metadata: ImageMetadata,
}

fn copy_db(src: &rusqlite::Connection, dest: &mut rusqlite::Connection) -> Result<()> {
    let backup = rusqlite::backup::Backup::new(src, dest)?;
    backup.run_to_completion(100, std::time::Duration::from_millis(10), None)?;
    Ok(())
}

pub fn u32_vec_to_u8_vec(arr: &[u32; 256]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(1024);
    for &val in arr {
        bytes.extend_from_slice(&val.to_le_bytes());
    }
    bytes
}

pub fn u8_vec_to_u32_vec(bytes: &[u8]) -> [u32; 256] {
    let mut arr = [0u32; 256];
    if bytes.len() == 1024 {
        for i in 0..256 {
            let chunk = &bytes[i * 4..(i + 1) * 4];
            arr[i] = u32::from_le_bytes(chunk.try_into().unwrap_or([0; 4]));
        }
    }
    arr
}

#[derive(Debug, Clone)]
pub struct LibraryItem {
    pub path: PathBuf,
    pub metadata: ImageMetadata,
    pub is_video: bool,
    pub size: u64,
    pub modified: u64,
}

#[derive(Debug, Clone, Default)]
pub struct LibraryIndex {
    pub root: PathBuf,
    pub items: Vec<LibraryItem>,
}

impl LibraryIndex {
    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }
}

static INDEX_THREAD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

fn get_index_thread_pool() -> &'static rayon::ThreadPool {
    INDEX_THREAD_POOL.get_or_init(|| {
        match rayon::ThreadPoolBuilder::new()
            .num_threads(8)
            .thread_name(|idx| format!("folio-index-{}", idx))
            .build()
        {
            Ok(pool) => pool,
            Err(e) => panic!("failed to build Folio index thread pool: {e}"),
        }
    })
}

/// Build index — skips files that fail metadata reads instead of aborting
pub fn build_index(root: &Path, cache: &LibraryCache) -> Result<LibraryIndex> {
    let paths = scan_supported_images(root)?;
    let pool = get_index_thread_pool();

    let items: Vec<LibraryItem> = pool.install(|| {
        paths
            .par_iter()
            .filter_map(|path| {
                let metadata = match cache.cached_metadata(path) {
                    Ok(Some(metadata)) => Some(metadata),
                    _ => {
                        match read_metadata_for_index(path) {
                            Ok(metadata) => {
                                let _ = cache.upsert_metadata(path, &metadata);
                                Some(metadata)
                            }
                            Err(_) => None, // Skip files that fail
                        }
                    }
                }?;
                let file_meta = fs::metadata(path).ok();
                let size = file_meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = file_meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let video = is_video_path(path);
                Some(LibraryItem {
                    path: path.clone(),
                    metadata,
                    is_video: video,
                    size,
                    modified,
                })
            })
            .collect()
    });

    cache.schedule_flush();
    if let Ok(conn) = cache.conn() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(PASSIVE); PRAGMA incremental_vacuum(20);");
    }

    Ok(LibraryIndex {
        root: root.to_path_buf(),
        items,
    })
}

pub struct LibraryCache {
    pub pool: Pool<SharedMemoryConnectionManager>,
    thumb_dir: PathBuf,
    decoded_dir: PathBuf,
    temp_dir: PathBuf,
    pub db_path: PathBuf,
    pub flush_pending: Arc<std::sync::atomic::AtomicBool>,
    pub tx: std::sync::mpsc::Sender<UpsertRequest>,
    pub shutdown: Arc<std::sync::atomic::AtomicBool>,
}

pub type VisualHistogram = ([u32; 256], [u32; 256], [u32; 256], [u32; 256]);

struct FileDropGuard {
    path: PathBuf,
}

impl Drop for FileDropGuard {
    fn drop(&mut self) {
        if self.path.exists() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

impl LibraryCache {
    pub fn open_default() -> Result<Self> {
        let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
        let root = base.join("folio-app");
        fs::create_dir_all(&root)?;
        let db_path = root.join("library.sqlite3");
        let thumb_dir = root.join("thumbs");
        fs::create_dir_all(&thumb_dir)?;
        let decoded_dir = root.join("decoded");
        fs::create_dir_all(&decoded_dir)?;
        let temp_dir = root.join("temp");

        // Clean up temp directory from prior crashes on startup
        if temp_dir.exists() {
            let _ = fs::remove_dir_all(&temp_dir);
        }
        fs::create_dir_all(&temp_dir)?;

        // Open disk database and configure optimizations (WAL, Normal Sync, Incremental Vacuum)
        let mut disk_conn = rusqlite::Connection::open(&db_path)?;
        disk_conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA auto_vacuum=INCREMENTAL;",
        )?;

        // Open transient shared in-memory connection
        let in_mem_uri = "file:foliomem?mode=memory&cache=shared";
        use rusqlite::OpenFlags;
        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_SHARED_CACHE;
        let mut in_mem_conn = rusqlite::Connection::open_with_flags(in_mem_uri, flags)?;

        // Restore disk database to memory mirror on startup
        if let Err(e) = copy_db(&disk_conn, &mut in_mem_conn) {
            eprintln!("Failed to restore database to memory: {e:?}");
        }

        // Build r2d2 connection pool pointing to memory mirror
        let manager = SharedMemoryConnectionManager::new(in_mem_uri);
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)
            .context("failed to build rusqlite connection pool")?;

        let flush_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Spawn background sequential writer thread for metadata upserts
        let (tx, rx) = std::sync::mpsc::channel::<UpsertRequest>();
        let in_mem_uri_str = in_mem_uri.to_string();
        std::thread::spawn(move || {
            if let Ok(mut conn) = rusqlite::Connection::open_with_flags(&in_mem_uri_str, flags) {
                let _ = conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
                let mut batch: Vec<UpsertRequest> = Vec::with_capacity(64);
                loop {
                    batch.clear();
                    match rx.recv() {
                        Ok(req) => batch.push(req),
                        Err(_) => break,
                    }
                    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(50);
                    while let Ok(req) = rx.recv_timeout(std::time::Duration::from_millis(1)) {
                        batch.push(req);
                        if std::time::Instant::now() >= deadline || batch.len() >= 64 {
                            break;
                        }
                    }

                    let tx = match conn.transaction() {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    for req in &batch {
                        let modified = match modified_secs(&req.path) {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        let (
                            camera,
                            aperture,
                            shutter_speed,
                            iso,
                            focal_length,
                            latitude,
                            longitude,
                        ) = match &req.metadata.exif {
                            Some(e) => (
                                e.camera.clone(),
                                e.aperture.clone(),
                                e.shutter_speed.clone(),
                                e.iso.clone(),
                                e.focal_length.clone(),
                                e.latitude,
                                e.longitude,
                            ),
                            None => (None, None, None, None, None, None, None),
                        };

                        let _ = tx.execute(
                            r#"
                            INSERT INTO image_metadata(path, modified_secs, width, height, orientation, format, camera, aperture, shutter_speed, iso, focal_length, latitude, longitude, focus_score)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                            ON CONFLICT(path) DO UPDATE SET
                                modified_secs = excluded.modified_secs,
                                width = excluded.width,
                                height = excluded.height,
                                orientation = excluded.orientation,
                                format = excluded.format,
                                camera = excluded.camera,
                                aperture = excluded.aperture,
                                shutter_speed = excluded.shutter_speed,
                                iso = excluded.iso,
                                focal_length = excluded.focal_length,
                                latitude = excluded.latitude,
                                longitude = excluded.longitude,
                                focus_score = COALESCE(excluded.focus_score, image_metadata.focus_score)
                            "#,
                            rusqlite::params![
                                req.path.to_string_lossy(),
                                modified,
                                i64::from(req.metadata.width),
                                i64::from(req.metadata.height),
                                i64::from(req.metadata.orientation),
                                req.metadata.format.map(|f| format!("{f:?}")),
                                camera,
                                aperture,
                                shutter_speed,
                                iso,
                                focal_length,
                                latitude,
                                longitude,
                                req.metadata.focus_score,
                            ],
                        );
                    }
                    let _ = tx.commit();
                }
            }
        });

        let shutdown = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let cache = Self {
            pool,
            thumb_dir,
            decoded_dir,
            temp_dir,
            db_path: db_path.clone(),
            flush_pending: Arc::clone(&flush_pending),
            tx,
            shutdown: Arc::clone(&shutdown),
        };

        // Schema validation & updates
        cache.ensure_schema()?;

        // Perform initial backup from memory to disk immediately so disk has schema
        {
            if let Ok(mem_conn) = cache.conn() {
                let _ = copy_db(&mem_conn, &mut disk_conn);
            }
        }

        // Spawn background mirror-to-disk flushing thread (WAL Checkpoint & Incremental Vacuum)
        let db_path_clone = db_path.clone();
        let flush_pending_clone = Arc::clone(&flush_pending);
        let in_mem_uri_str_flush = in_mem_uri.to_string();
        let shutdown_clone_flush = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            let mem_conn = match rusqlite::Connection::open_with_flags(&in_mem_uri_str_flush, flags)
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Flush thread: failed to open memory connection: {e:?}");
                    return;
                }
            };
            let mut disk_conn = match rusqlite::Connection::open(&db_path_clone) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("Flush thread: failed to open disk connection: {e:?}");
                    return;
                }
            };
            while !shutdown_clone_flush.load(std::sync::atomic::Ordering::SeqCst) {
                for _ in 0..10 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if shutdown_clone_flush.load(std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                }
                if flush_pending_clone
                    .compare_exchange(
                        true,
                        false,
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                    )
                    .is_ok()
                {
                    if let Err(e) = copy_db(&mem_conn, &mut disk_conn) {
                        eprintln!("Background DB flush failed: {e:?}");
                    } else {
                        let _ = disk_conn.execute_batch(
                            "PRAGMA wal_checkpoint(PASSIVE);
                             PRAGMA incremental_vacuum(50);",
                        );
                    }
                }
            }
        });

        // Spawn background database auto-backup thread (runs every 10 minutes)
        let db_path_backup = db_path.clone();
        let in_mem_uri_str_backup = in_mem_uri.to_string();
        let shutdown_clone_backup = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            let mem_conn =
                match rusqlite::Connection::open_with_flags(&in_mem_uri_str_backup, flags) {
                    Ok(c) => c,
                    Err(e) => {
                        eprintln!("Backup thread: failed to open memory connection: {e:?}");
                        return;
                    }
                };
            while !shutdown_clone_backup.load(std::sync::atomic::Ordering::SeqCst) {
                let mut exited = false;
                for _ in 0..3000 {
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    if shutdown_clone_backup.load(std::sync::atomic::Ordering::SeqCst) {
                        exited = true;
                        break;
                    }
                }
                if exited {
                    break;
                }
                let backup_path = db_path_backup.with_extension("sqlite3.bak");
                let mut backup_conn_res = rusqlite::Connection::open(&backup_path);

                match &mut backup_conn_res {
                    Ok(backup_conn) => {
                        if let Err(e) = copy_db(&mem_conn, backup_conn) {
                            eprintln!("Automated database backup failed: {e:?}");
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to open connection for automated backup: {e:?}");
                    }
                }
            }
        });

        // Spawn background thumbnail LRU cleaner (files older than 30 days) 5 seconds after startup
        let thumb_dir_clone = cache.thumb_dir.clone();
        let shutdown_clone_lru = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            for _ in 0..25 {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if shutdown_clone_lru.load(std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
            }
            let now = std::time::SystemTime::now();
            let max_age = std::time::Duration::from_secs(30 * 24 * 60 * 60);
            if thumb_dir_clone.exists() {
                for entry in walkdir::WalkDir::new(&thumb_dir_clone)
                    .into_iter()
                    .filter_map(|e| e.ok())
                {
                    let path = entry.path().to_path_buf();
                    if path.is_file()
                        && let Ok(meta) = fs::metadata(&path)
                    {
                        let accessed = meta.accessed().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                        let last_used = accessed.max(modified);
                        if let Ok(age) = now.duration_since(last_used)
                            && age > max_age
                        {
                            let _ = fs::remove_file(&path);
                        }
                    }
                }
            }
        });

        Ok(cache)
    }

    pub fn conn(&self) -> Result<PooledConnection<SharedMemoryConnectionManager>> {
        self.pool
            .get()
            .context("failed to get database connection from pool")
    }

    pub fn thumb_dir(&self) -> &Path {
        &self.thumb_dir
    }

    pub fn decoded_dir(&self) -> &Path {
        &self.decoded_dir
    }

    pub fn schedule_flush(&self) {
        self.flush_pending
            .store(true, std::sync::atomic::Ordering::SeqCst);
    }

    fn ensure_schema(&self) -> Result<()> {
        let conn = self.conn()?;

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;

        if current_version < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS image_metadata (
                    path TEXT PRIMARY KEY,
                    modified_secs INTEGER NOT NULL,
                    width INTEGER NOT NULL,
                    height INTEGER NOT NULL,
                    orientation INTEGER NOT NULL,
                    format TEXT,
                    camera TEXT,
                    aperture TEXT,
                    shutter_speed TEXT,
                    iso TEXT,
                    focal_length TEXT,
                    latitude REAL,
                    longitude REAL,
                    focus_score REAL
                );
                CREATE TABLE IF NOT EXISTS albums (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL
                );
                CREATE TABLE IF NOT EXISTS album_images (
                    album_id INTEGER,
                    image_path TEXT,
                    PRIMARY KEY (album_id, image_path),
                    FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
                );
                CREATE TABLE IF NOT EXISTS tags (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    color TEXT
                );
                CREATE TABLE IF NOT EXISTS image_tags (
                    image_path TEXT,
                    tag_name TEXT,
                    PRIMARY KEY (image_path, tag_name)
                );
                "#,
            )?;
            conn.execute("PRAGMA user_version = 1;", [])?;
        }

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < 2 {
            let table_info: Vec<String> = {
                let mut stmt = conn.prepare("PRAGMA table_info(image_metadata)")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };

            let columns_to_add = [
                ("latitude", "REAL"),
                ("longitude", "REAL"),
                ("camera", "TEXT"),
                ("aperture", "TEXT"),
                ("shutter_speed", "TEXT"),
                ("iso", "TEXT"),
                ("focal_length", "TEXT"),
            ];

            for (col_name, col_type) in &columns_to_add {
                if !table_info.contains(&col_name.to_string()) {
                    let query = format!(
                        "ALTER TABLE image_metadata ADD COLUMN {} {};",
                        col_name, col_type
                    );
                    let _ = conn.execute(&query, []);
                }
            }
            conn.execute("PRAGMA user_version = 2;", [])?;
        }

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < 3 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS visual_histograms (
                    path TEXT PRIMARY KEY,
                    r_blob BLOB NOT NULL,
                    g_blob BLOB NOT NULL,
                    b_blob BLOB NOT NULL,
                    lum_blob BLOB NOT NULL
                );
                "#,
            )?;
            conn.execute("PRAGMA user_version = 3;", [])?;
        }

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < 4 {
            let table_info: Vec<String> = {
                let mut stmt = conn.prepare("PRAGMA table_info(image_metadata)")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            if !table_info.contains(&"focus_score".to_string()) {
                let _ = conn.execute(
                    "ALTER TABLE image_metadata ADD COLUMN focus_score REAL;",
                    [],
                );
            }
            conn.execute("PRAGMA user_version = 4;", [])?;
        }

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < 5 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS media_attributes (
                    path TEXT PRIMARY KEY,
                    rating INTEGER,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    updated_secs INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS smart_albums (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT UNIQUE NOT NULL,
                    filter_json TEXT NOT NULL,
                    created_secs INTEGER NOT NULL,
                    updated_secs INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS batch_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    operation TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_secs INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS vault_items (
                    id TEXT PRIMARY KEY,
                    vault_name TEXT NOT NULL,
                    original_path TEXT NOT NULL,
                    file_name TEXT NOT NULL,
                    encrypted_path TEXT NOT NULL,
                    size INTEGER NOT NULL,
                    added_secs INTEGER NOT NULL
                );
                "#,
            )?;
            conn.execute("PRAGMA user_version = 5;", [])?;
        }

        Ok(())
    }

    pub fn upsert_metadata(&self, path: &Path, metadata: &ImageMetadata) -> Result<()> {
        let req = UpsertRequest {
            path: path.to_path_buf(),
            metadata: metadata.clone(),
        };
        let _ = self.tx.send(req);
        self.schedule_flush();
        Ok(())
    }

    pub fn cached_metadata(&self, path: &Path) -> Result<Option<ImageMetadata>> {
        let modified = modified_secs(path)?;
        let conn = self.conn()?;
        let row = conn
            .query_row(
                r#"
                SELECT width, height, orientation, format, modified_secs, camera, aperture, shutter_speed, iso, focal_length, latitude, longitude, focus_score
                FROM image_metadata
                WHERE path = ?1
                "#,
                rusqlite::params![path.to_string_lossy()],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<String>>(9)?,
                        row.get::<_, Option<f64>>(10)?,
                        row.get::<_, Option<f64>>(11)?,
                        row.get::<_, Option<f64>>(12)?,
                    ))
                },
            )
            .optional()?;

        let Some((
            width,
            height,
            orientation,
            format_name,
            cached_modified,
            camera,
            aperture,
            shutter_speed,
            iso,
            focal_length,
            latitude,
            longitude,
            focus_score,
        )) = row
        else {
            return Ok(None);
        };
        if cached_modified != modified {
            return Ok(None);
        }
        let format = format_name.as_deref().and_then(parse_image_format);

        let has_exif = camera.is_some()
            || aperture.is_some()
            || shutter_speed.is_some()
            || iso.is_some()
            || focal_length.is_some()
            || latitude.is_some()
            || longitude.is_some();
        let exif = if has_exif {
            Some(media_core::ExifData {
                camera,
                aperture,
                shutter_speed,
                iso,
                focal_length,
                latitude,
                longitude,
            })
        } else {
            None
        };

        Ok(Some(ImageMetadata {
            width: width as u32,
            height: height as u32,
            orientation: orientation as u16,
            format,
            exif,
            focus_score,
        }))
    }

    pub fn thumbnail_path(&self, path: &Path, max_side: u32) -> Result<PathBuf> {
        let fingerprint = image_fingerprint(path)?;
        Ok(self.thumb_dir.join(format!("{fingerprint}_{max_side}.jpg")))
    }

    pub fn ensure_thumbnail(&self, path: &Path, max_side: u32) -> Result<PathBuf> {
        let thumb_path = self.thumbnail_path(path, max_side)?;
        if thumb_path.exists() {
            return Ok(thumb_path);
        }
        let tmp_path = thumb_path.with_extension("tmp");

        if is_video_path(path) {
            #[cfg(target_os = "macos")]
            {
                let temp_dir = &self.temp_dir;
                let output = std::process::Command::new("qlmanage")
                    .arg("-t")
                    .arg("-s")
                    .arg(max_side.to_string())
                    .arg("-o")
                    .arg(temp_dir)
                    .arg(path)
                    .output();

                if let Ok(out) = output
                    && out.status.success()
                {
                    let filename = path
                        .file_name()
                        .ok_or_else(|| anyhow::anyhow!("no filename for video"))?;
                    let generated_png =
                        temp_dir.join(format!("{}.png", filename.to_string_lossy()));
                    if generated_png.exists() {
                        let _guard = FileDropGuard {
                            path: generated_png.clone(),
                        };
                        let img = image::open(&generated_png).with_context(|| {
                            format!(
                                "failed to open generated video frame at {}",
                                generated_png.display()
                            )
                        })?;
                        let mut file = std::fs::File::create(&tmp_path).with_context(|| {
                            format!("failed to create temp file at {}", tmp_path.display())
                        })?;
                        let encoder =
                            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85);
                        image::DynamicImage::ImageRgba8(img.to_rgba8())
                            .write_with_encoder(encoder)
                            .with_context(|| {
                                format!("failed to write jpeg to {}", tmp_path.display())
                            })?;

                        std::fs::rename(&tmp_path, &thumb_path).with_context(|| {
                            format!("failed to finalize thumbnail {}", thumb_path.display())
                        })?;
                        return Ok(thumb_path);
                    }
                }
            }
            anyhow::bail!("cannot generate thumbnail for video: {}", path.display());
        }

        if media_core::can_use_sips(path) {
            media_core::sips_output_to_file(path, &tmp_path, Some(max_side), "jpeg")
                .with_context(|| format!("native sips thumbnail failed for {}", path.display()))?;
        } else {
            let decoded = decode_image(path, Some(max_side))
                .with_context(|| format!("failed to decode thumbnail input {}", path.display()))?;
            let rgba = image::RgbaImage::from_raw(decoded.width, decoded.height, decoded.rgba)
                .context("failed to construct RGBA thumbnail image")?;
            let mut file = std::fs::File::create(&tmp_path).with_context(|| {
                format!(
                    "failed to create temp thumbnail file: {}",
                    tmp_path.display()
                )
            })?;
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85);
            image::DynamicImage::ImageRgba8(rgba)
                .write_with_encoder(encoder)
                .with_context(|| {
                    format!("failed to write JPEG thumbnail {}", tmp_path.display())
                })?;
        }

        std::fs::rename(&tmp_path, &thumb_path)
            .with_context(|| format!("failed to finalize thumbnail {}", thumb_path.display()))?;

        // Compute histogram asynchronously so thumbnail is available immediately
        {
            let pool = self.pool.clone();
            let path_buf = path.to_path_buf();
            let thumb_path_buf = thumb_path.clone();
            std::thread::spawn(move || {
                let img = match image::open(&thumb_path_buf) {
                    Ok(img) => img,
                    Err(_) => return,
                };
                let (r, g, b, lum) = media_core::compute_histogram_from_image(&img);
                let r_bytes = u32_vec_to_u8_vec(&r);
                let g_bytes = u32_vec_to_u8_vec(&g);
                let b_bytes = u32_vec_to_u8_vec(&b);
                let lum_bytes = u32_vec_to_u8_vec(&lum);
                let focus_score = media_core::detect_focus_blur(&img);

                if let Ok(conn) = pool.get() {
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO visual_histograms (path, r_blob, g_blob, b_blob, lum_blob) VALUES (?, ?, ?, ?, ?)",
                        rusqlite::params![path_buf.to_string_lossy(), r_bytes, g_bytes, b_bytes, lum_bytes],
                    );
                    let _ = conn.execute(
                        "UPDATE image_metadata SET focus_score = ?1 WHERE path = ?2",
                        rusqlite::params![focus_score, path_buf.to_string_lossy()],
                    );
                }
            });
        }
        Ok(thumb_path)
    }

    pub fn cache_visual_histogram(&self, path: &Path, thumb_path: &Path) -> Result<()> {
        let img = image::open(thumb_path)?;
        let (r, g, b, lum) = media_core::compute_histogram_from_image(&img);
        let r_bytes = u32_vec_to_u8_vec(&r);
        let g_bytes = u32_vec_to_u8_vec(&g);
        let b_bytes = u32_vec_to_u8_vec(&b);
        let lum_bytes = u32_vec_to_u8_vec(&lum);

        let focus_score = media_core::detect_focus_blur(&img);

        let conn = self.conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO visual_histograms (path, r_blob, g_blob, b_blob, lum_blob) VALUES (?, ?, ?, ?, ?)",
            rusqlite::params![path.to_string_lossy(), r_bytes, g_bytes, b_bytes, lum_bytes],
        )?;
        conn.execute(
            "UPDATE image_metadata SET focus_score = ?1 WHERE path = ?2",
            rusqlite::params![focus_score, path.to_string_lossy()],
        )?;
        self.schedule_flush();
        Ok(())
    }

    pub fn get_visual_histogram(&self, path: &Path) -> Result<Option<VisualHistogram>> {
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT r_blob, g_blob, b_blob, lum_blob FROM visual_histograms WHERE path = ?",
                rusqlite::params![path.to_string_lossy()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, Vec<u8>>(3)?,
                    ))
                },
            )
            .optional()?;

        if let Some((r_bytes, g_bytes, b_bytes, lum_bytes)) = row {
            let r = u8_vec_to_u32_vec(&r_bytes);
            let g = u8_vec_to_u32_vec(&g_bytes);
            let b = u8_vec_to_u32_vec(&b_bytes);
            let lum = u8_vec_to_u32_vec(&lum_bytes);
            Ok(Some((r, g, b, lum)))
        } else {
            Ok(None)
        }
    }

    pub fn ensure_decoded(&self, path: &Path) -> Result<PathBuf> {
        let fingerprint = image_fingerprint(path)?;
        let cached = self.decoded_dir.join(format!("{fingerprint}.jpg"));
        if cached.exists() {
            return Ok(cached);
        }
        let tmp_path = cached.with_extension("tmp");

        if media_core::needs_sips_decode(path) {
            media_core::sips_output_to_file(path, &tmp_path, None, "jpeg")
                .with_context(|| format!("native sips decode failed for {}", path.display()))?;
        } else {
            let img = media_core::open_image(path)?;
            let img = media_core::apply_exif_orientation(&img, path);
            let rgb8 = img.to_rgb8();
            let mut file = std::fs::File::create(&tmp_path).with_context(|| {
                format!(
                    "failed to create decoded cache file: {}",
                    tmp_path.display()
                )
            })?;
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 95);
            image::DynamicImage::ImageRgb8(rgb8)
                .write_with_encoder(encoder)
                .with_context(|| format!("failed to encode decoded image: {}", path.display()))?;
        }

        std::fs::rename(&tmp_path, &cached)
            .with_context(|| format!("failed to finalize decoded image: {}", cached.display()))?;
        Ok(cached)
    }

    /// CPU-aware parallelism for thumbnail/decode warmup (2–8 workers).
    pub fn cache_parallelism() -> usize {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8)
    }

    pub fn warm_thumbnails(&self, paths: &[PathBuf], active_index: usize, max_side: u32) {
        const WARM_LIMIT: usize = 48;
        let parallel = Self::cache_parallelism();
        let mut indexed_paths: Vec<(usize, &PathBuf)> = paths.iter().enumerate().collect();
        indexed_paths
            .sort_by_key(|&(orig_idx, _)| (orig_idx as isize - active_index as isize).abs());
        indexed_paths.truncate(WARM_LIMIT);
        for chunk in indexed_paths.chunks(parallel) {
            chunk.par_iter().for_each(|&(_, path)| {
                let _ = self.ensure_thumbnail(path, max_side);
            });
        }
    }

    /// Parallel thumbnail warmup for job queue / large batches.
    pub fn warm_thumbnails_batch(&self, paths: &[PathBuf], max_side: u32) {
        let parallel = Self::cache_parallelism();
        for chunk in paths.chunks(parallel) {
            chunk.par_iter().for_each(|path| {
                let _ = self.ensure_thumbnail(path, max_side);
            });
        }
    }

    /// Decode non-native stills into the decoded cache (RAW/TIFF/etc.).
    pub fn warm_decoded(&self, paths: &[PathBuf]) {
        let parallel = Self::cache_parallelism();
        for chunk in paths.chunks(parallel) {
            chunk.par_iter().for_each(|path| {
                let ext = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let native = matches!(
                    ext.as_str(),
                    "jpg" | "jpeg" | "png" | "webp" | "gif" | "bmp"
                );
                if !native {
                    let _ = self.ensure_decoded(path);
                }
            });
        }
    }

    /// Drop oldest decoded cache files until total size is under `limit_bytes`.
    pub fn prune_decoded_to_limit(&self, limit_bytes: u64) -> u64 {
        prune_dir_lru(&self.decoded_dir, limit_bytes)
    }
}

/// LRU prune by file mtime (oldest removed first).
pub fn prune_dir_lru(dir: &Path, limit_bytes: u64) -> u64 {
    let mut entries = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(dir) {
        for entry in read_dir.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                let modified = meta
                    .modified()
                    .ok()
                    .and_then(|m| m.elapsed().ok())
                    .map(|e| e.as_secs())
                    .unwrap_or(u64::MAX);
                entries.push((path, meta.len(), modified));
            }
        }
    }
    let mut total: u64 = entries.iter().map(|(_, size, _)| *size).sum();
    if total <= limit_bytes {
        return 0;
    }
    entries.sort_by_key(|(_, _, age)| std::cmp::Reverse(*age));
    let mut removed = 0u64;
    for (path, size, _) in entries {
        if total <= limit_bytes {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(size);
            removed += size;
        }
    }
    removed
}

impl Drop for LibraryCache {
    fn drop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::SeqCst);

        // Trigger a final mirror backup to disk via copy_db & wal_checkpoint
        if let Ok(mem_conn) = self.conn()
            && let Ok(mut disk_conn) = rusqlite::Connection::open(&self.db_path)
        {
            if let Err(e) = copy_db(&mem_conn, &mut disk_conn) {
                eprintln!("Final Drop mirror backup failed: {:?}", e);
            } else {
                let _ = disk_conn.execute_batch(
                    "PRAGMA wal_checkpoint(PASSIVE);
                         PRAGMA incremental_vacuum(50);",
                );
            }
        }
    }
}

fn modified_secs(path: &Path) -> Result<i64> {
    let modified = fs::metadata(path)?
        .modified()
        .with_context(|| format!("missing modified time for {}", path.display()))?;
    let secs = modified
        .duration_since(UNIX_EPOCH)
        .with_context(|| format!("invalid modified time for {}", path.display()))?
        .as_secs();
    Ok(secs as i64)
}

fn image_fingerprint(path: &Path) -> Result<String> {
    let stamp = modified_secs(path)?;
    let key = format!("{}::{stamp}_v3", path.to_string_lossy());
    Ok(blake3::hash(key.as_bytes()).to_hex().to_string())
}

fn parse_image_format(name: &str) -> Option<image::ImageFormat> {
    match name {
        "Jpeg" => Some(image::ImageFormat::Jpeg),
        "Png" => Some(image::ImageFormat::Png),
        "Gif" => Some(image::ImageFormat::Gif),
        "WebP" => Some(image::ImageFormat::WebP),
        "Tiff" => Some(image::ImageFormat::Tiff),
        "Bmp" => Some(image::ImageFormat::Bmp),
        "Avif" => Some(image::ImageFormat::Avif),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_known_image_format() {
        assert_eq!(parse_image_format("Png"), Some(image::ImageFormat::Png));
        assert_eq!(parse_image_format("Unknown"), None);
    }

    #[test]
    fn index_default_is_empty() {
        let index = LibraryIndex::default();
        assert!(index.is_empty());
        assert_eq!(index.len(), 0);
        assert_eq!(index.root, Path::new(""));
    }
}
