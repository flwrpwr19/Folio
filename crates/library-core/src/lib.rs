use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use media_core::{
    ImageMetadata, decode_image, is_video_path, read_metadata_for_index, scan_supported_images,
};
use r2d2::{Pool, PooledConnection};
use rayon::prelude::*;
pub use rusqlite;
use rusqlite::OptionalExtension;
use std::sync::Arc;

#[derive(Debug)]
pub struct SharedMemoryConnectionManager {
    path: String,
}

impl SharedMemoryConnectionManager {
    pub fn new(path: impl Into<String>) -> Self {
        Self { path: path.into() }
    }
}

impl r2d2::ManageConnection for SharedMemoryConnectionManager {
    type Connection = rusqlite::Connection;
    type Error = rusqlite::Error;

    fn connect(&self) -> Result<Self::Connection, Self::Error> {
        let conn = rusqlite::Connection::open(&self.path)?;
        let _ = conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-64000;
             PRAGMA temp_store=MEMORY;
             PRAGMA foreign_keys=ON;",
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
    positions: HashMap<PathBuf, usize>,
}

impl LibraryIndex {
    pub fn new(root: PathBuf, items: Vec<LibraryItem>) -> Self {
        let mut index = Self {
            root,
            items,
            positions: HashMap::new(),
        };
        index.rebuild_positions();
        index
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    pub fn get(&self, path: &Path) -> Option<&LibraryItem> {
        self.positions
            .get(path)
            .and_then(|&idx| self.items.get(idx))
    }

    pub fn position(&self, path: &Path) -> Option<usize> {
        self.positions.get(path).copied()
    }

    pub fn get_mut(&mut self, path: &Path) -> Option<&mut LibraryItem> {
        let idx = *self.positions.get(path)?;
        self.items.get_mut(idx)
    }

    pub fn upsert(&mut self, item: LibraryItem) {
        if let Some(&idx) = self.positions.get(&item.path) {
            self.items[idx] = item;
        } else {
            self.positions.insert(item.path.clone(), self.items.len());
            self.items.push(item);
        }
    }

    pub fn remove(&mut self, path: &Path) -> bool {
        let Some(idx) = self.positions.remove(path) else {
            return false;
        };
        self.items.swap_remove(idx);
        if let Some(item) = self.items.get(idx) {
            self.positions.insert(item.path.clone(), idx);
        }
        true
    }

    fn rebuild_positions(&mut self) {
        self.positions.clear();
        self.positions.extend(
            self.items
                .iter()
                .enumerate()
                .map(|(idx, item)| (item.path.clone(), idx)),
        );
    }
}

static INDEX_THREAD_POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();

fn get_index_thread_pool() -> &'static rayon::ThreadPool {
    INDEX_THREAD_POOL.get_or_init(|| {
        let thread_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8);
        match rayon::ThreadPoolBuilder::new()
            .num_threads(thread_count)
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
                let file_meta = fs::metadata(path).ok();
                let modified = file_meta.as_ref().and_then(metadata_modified_secs);
                let metadata = match modified
                    .map(|modified| cache.cached_metadata_with_modified(path, modified as i64))
                    .unwrap_or(Ok(None))
                {
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
                let size = file_meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = modified.unwrap_or(0);
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

    Ok(LibraryIndex::new(root.to_path_buf(), items))
}

/// Refresh an existing index while reusing unchanged entries.
pub fn build_index_incremental(
    root: &Path,
    cache: &LibraryCache,
    previous: &LibraryIndex,
) -> Result<LibraryIndex> {
    if previous.root != root {
        return build_index(root, cache);
    }
    let paths = scan_supported_images(root)?;
    let pool = get_index_thread_pool();
    let items = pool.install(|| {
        paths
            .par_iter()
            .filter_map(|path| {
                let file_meta = fs::metadata(path).ok();
                let size = file_meta.as_ref().map(|m| m.len()).unwrap_or(0);
                let modified = file_meta
                    .as_ref()
                    .and_then(metadata_modified_secs)
                    .unwrap_or(0);
                if let Some(item) = previous.get(path)
                    && item.size == size
                    && item.modified == modified
                {
                    return Some(item.clone());
                }
                let metadata = cache
                    .cached_metadata_with_modified(path, modified as i64)
                    .ok()
                    .flatten()
                    .or_else(|| {
                        let metadata = read_metadata_for_index(path).ok()?;
                        let _ = cache.upsert_metadata(path, &metadata);
                        Some(metadata)
                    })?;
                Some(LibraryItem {
                    path: path.clone(),
                    metadata,
                    is_video: is_video_path(path),
                    size,
                    modified,
                })
            })
            .collect()
    });
    cache.schedule_flush();
    Ok(LibraryIndex::new(root.to_path_buf(), items))
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
    thumbnail_in_flight: Arc<(Mutex<HashSet<PathBuf>>, Condvar)>,
    decoded_in_flight: Arc<(Mutex<HashSet<PathBuf>>, Condvar)>,
    fingerprints: Mutex<HashMap<PathBuf, (i64, u64, String)>>,
    thumbnail_files: Mutex<HashMap<PathBuf, CacheFileInfo>>,
    decoded_files: Mutex<HashMap<PathBuf, CacheFileInfo>>,
}

pub type VisualHistogram = ([u32; 256], [u32; 256], [u32; 256], [u32; 256]);

#[derive(Clone)]
struct CacheFileInfo {
    size: u64,
    last_used: u64,
    last_persisted: u64,
}

struct HistogramRequest {
    pool: Pool<SharedMemoryConnectionManager>,
    path: PathBuf,
    thumbnail: PathBuf,
    image: Option<image::DynamicImage>,
}

static HISTOGRAM_QUEUE: OnceLock<std::sync::mpsc::SyncSender<HistogramRequest>> = OnceLock::new();

fn histogram_queue() -> &'static std::sync::mpsc::SyncSender<HistogramRequest> {
    HISTOGRAM_QUEUE.get_or_init(|| {
        let (sender, receiver) = std::sync::mpsc::sync_channel::<HistogramRequest>(128);
        let receiver = Arc::new(Mutex::new(receiver));
        for idx in 0..LibraryCache::cache_parallelism().min(4) {
            let receiver = Arc::clone(&receiver);
            let _ = std::thread::Builder::new()
                .name(format!("folio-histogram-{idx}"))
                .spawn(move || {
                    loop {
                        let request = {
                            let guard = receiver.lock().unwrap_or_else(|e| e.into_inner());
                            guard.recv()
                        };
                        let Ok(request) = request else {
                            break;
                        };
                        let img = if let Some(img) = request.image {
                            img
                        } else {
                            let Ok(img) = image::open(&request.thumbnail) else {
                                continue;
                            };
                            img
                        };
                        let (r, g, b, lum) = media_core::compute_histogram_from_image(&img);
                        let focus_score = media_core::detect_focus_blur(&img);
                        if let Ok(conn) = request.pool.get() {
                            let _ = conn.execute(
                                "INSERT OR REPLACE INTO visual_histograms (path, r_blob, g_blob, b_blob, lum_blob) VALUES (?, ?, ?, ?, ?)",
                                rusqlite::params![
                                    request.path.to_string_lossy(),
                                    u32_vec_to_u8_vec(&r),
                                    u32_vec_to_u8_vec(&g),
                                    u32_vec_to_u8_vec(&b),
                                    u32_vec_to_u8_vec(&lum)
                                ],
                            );
                            let _ = conn.execute(
                                "UPDATE image_metadata SET focus_score = ?1 WHERE path = ?2",
                                rusqlite::params![focus_score, request.path.to_string_lossy()],
                            );
                        }
                    }
                });
        }
        sender
    })
}

fn scan_cache_files(dir: &Path) -> HashMap<PathBuf, CacheFileInfo> {
    let mut files = HashMap::new();
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata()
                && meta.is_file()
            {
                files.insert(
                    entry.path(),
                    CacheFileInfo {
                        size: meta.len(),
                        last_used: meta
                            .modified()
                            .unwrap_or(SystemTime::UNIX_EPOCH)
                            .duration_since(UNIX_EPOCH)
                            .map(|duration| duration.as_secs())
                            .unwrap_or(0),
                        last_persisted: 0,
                    },
                );
            }
        }
    }
    files
}

fn cache_size(files: &Mutex<HashMap<PathBuf, CacheFileInfo>>) -> u64 {
    files
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|entry| entry.size)
        .sum()
}

fn should_decode_with_sips(path: &Path) -> bool {
    const LARGE_DECODE_BYTES: u64 = 80 * 1024 * 1024;
    fs::metadata(path)
        .map(|meta| meta.len() > LARGE_DECODE_BYTES)
        .unwrap_or(false)
}

fn touch_cache_file(
    files: &Mutex<HashMap<PathBuf, CacheFileInfo>>,
    path: &Path,
    meta: &fs::Metadata,
) -> Option<CacheFileInfo> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut files = files.lock().unwrap_or_else(|e| e.into_inner());
    let entry = files.entry(path.to_path_buf()).or_insert(CacheFileInfo {
        size: meta.len(),
        last_used: now,
        last_persisted: 0,
    });
    entry.size = meta.len();
    entry.last_used = now;
    if now.saturating_sub(entry.last_persisted) >= 300 {
        entry.last_persisted = now;
        return Some(entry.clone());
    }
    None
}

fn prune_cache_files(
    files: &Mutex<HashMap<PathBuf, CacheFileInfo>>,
    limit_bytes: u64,
) -> (u64, Vec<PathBuf>) {
    let mut files = files.lock().unwrap_or_else(|e| e.into_inner());
    let mut total: u64 = files.values().map(|entry| entry.size).sum();
    if total <= limit_bytes {
        return (0, Vec::new());
    }
    let mut candidates: Vec<_> = files
        .iter()
        .map(|(path, entry)| (path.clone(), entry.clone()))
        .collect();
    candidates.sort_by_key(|(_, entry)| entry.last_used);
    let mut removed = 0;
    let mut removed_paths = Vec::new();
    for (path, entry) in candidates {
        if total <= limit_bytes {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            files.remove(&path);
            total = total.saturating_sub(entry.size);
            removed += entry.size;
            removed_paths.push(path);
        }
    }
    (removed, removed_paths)
}

struct FileDropGuard {
    path: PathBuf,
}

struct InFlightGuard<'a> {
    state: &'a (Mutex<HashSet<PathBuf>>, Condvar),
    key: PathBuf,
}

impl<'a> InFlightGuard<'a> {
    fn acquire(state: &'a (Mutex<HashSet<PathBuf>>, Condvar), key: &Path) -> Self {
        let (lock, ready) = state;
        let mut in_flight = lock.lock().unwrap_or_else(|e| e.into_inner());
        while in_flight.contains(key) {
            in_flight = ready.wait(in_flight).unwrap_or_else(|e| e.into_inner());
        }
        in_flight.insert(key.to_path_buf());
        Self {
            state,
            key: key.to_path_buf(),
        }
    }
}

impl Drop for InFlightGuard<'_> {
    fn drop(&mut self) {
        let (lock, ready) = self.state;
        lock.lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.key);
        ready.notify_all();
    }
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
        let disk_conn = rusqlite::Connection::open(&db_path)?;
        disk_conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA auto_vacuum=INCREMENTAL;",
        )?;

        // Use pooled direct WAL connections. This avoids copying the complete database for
        // persistence while retaining SQLite's page cache and concurrent-reader behavior.
        let manager = SharedMemoryConnectionManager::new(db_path.to_string_lossy());
        let pool = Pool::builder()
            .max_size(10)
            .build(manager)
            .context("failed to build rusqlite connection pool")?;

        let flush_pending = Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Spawn background sequential writer thread for metadata upserts
        let (tx, rx) = std::sync::mpsc::channel::<UpsertRequest>();
        let writer_db_path = db_path.clone();
        std::thread::spawn(move || {
            if let Ok(mut conn) = rusqlite::Connection::open(&writer_db_path) {
                let _ = conn.execute_batch(
                    "PRAGMA journal_mode=WAL;
                     PRAGMA synchronous=NORMAL;
                     PRAGMA foreign_keys=ON;",
                );
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
                            INSERT INTO image_metadata(path, modified_secs, width, height, orientation, format, camera, aperture, shutter_speed, iso, focal_length, latitude, longitude, focus_score, orientation_indexed)
                            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1)
                            ON CONFLICT(path) DO UPDATE SET
                                modified_secs = excluded.modified_secs,
                                width = excluded.width,
                                height = excluded.height,
                                orientation = excluded.orientation,
                                orientation_indexed = 1,
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
        let thumbnail_files = scan_cache_files(&thumb_dir);
        let decoded_files = scan_cache_files(&decoded_dir);

        let cache = Self {
            pool,
            thumb_dir,
            decoded_dir,
            temp_dir,
            db_path: db_path.clone(),
            flush_pending: Arc::clone(&flush_pending),
            tx,
            shutdown: Arc::clone(&shutdown),
            thumbnail_in_flight: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
            decoded_in_flight: Arc::new((Mutex::new(HashSet::new()), Condvar::new())),
            fingerprints: Mutex::new(HashMap::new()),
            thumbnail_files: Mutex::new(thumbnail_files),
            decoded_files: Mutex::new(decoded_files),
        };

        // Schema validation & updates
        cache.ensure_schema()?;
        cache.restore_cache_inventory();

        // Spawn a lightweight WAL checkpoint worker. Normal writes are already durable on disk.
        let db_path_clone = db_path.clone();
        let flush_pending_clone = Arc::clone(&flush_pending);
        let shutdown_clone_flush = Arc::clone(&shutdown);
        std::thread::spawn(move || {
            let disk_conn = match rusqlite::Connection::open(&db_path_clone) {
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
                    let _ = disk_conn.execute_batch(
                        "PRAGMA wal_checkpoint(PASSIVE);
                         PRAGMA incremental_vacuum(50);",
                    );
                }
            }
        });

        // Spawn background database auto-backup thread (runs every 10 minutes)
        let db_path_backup = db_path.clone();
        let shutdown_clone_backup = Arc::clone(&shutdown);
        std::thread::spawn(move || {
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
                let source_conn_res = rusqlite::Connection::open(&db_path_backup);

                match (&source_conn_res, &mut backup_conn_res) {
                    (Ok(source_conn), Ok(backup_conn)) => {
                        if let Err(e) = copy_db(source_conn, backup_conn) {
                            eprintln!("Automated database backup failed: {e:?}");
                        }
                    }
                    (_, Err(e)) => {
                        eprintln!("Failed to open connection for automated backup: {e:?}");
                    }
                    (Err(e), _) => {
                        eprintln!("Failed to open connection for automated backup: {e:?}");
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

    pub fn thumbnail_cache_size(&self) -> u64 {
        cache_size(&self.thumbnail_files)
    }

    pub fn decoded_cache_size(&self) -> u64 {
        cache_size(&self.decoded_files)
    }

    pub fn prune_thumbnails_to_limit(&self, limit_bytes: u64) -> u64 {
        let (removed, paths) = prune_cache_files(&self.thumbnail_files, limit_bytes);
        self.remove_persisted_cache_paths(&paths);
        removed
    }

    pub fn reset_thumbnail_inventory(&self) {
        self.thumbnail_files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.clear_persisted_cache_kind("thumbnail");
    }

    pub fn reset_decoded_inventory(&self) {
        self.decoded_files
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
        self.clear_persisted_cache_kind("decoded");
    }

    fn restore_cache_inventory(&self) {
        let Ok(conn) = self.conn() else {
            return;
        };
        let Ok(mut stmt) = conn.prepare("SELECT path, kind, size, last_used FROM cache_files")
        else {
            return;
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                PathBuf::from(row.get::<_, String>(0)?),
                row.get::<_, String>(1)?,
                row.get::<_, u64>(2)?,
                row.get::<_, u64>(3)?,
            ))
        }) else {
            return;
        };
        for row in rows.flatten() {
            let (path, kind, _size, last_used) = row;
            let files = if kind == "thumbnail" {
                &self.thumbnail_files
            } else if kind == "decoded" {
                &self.decoded_files
            } else {
                continue;
            };
            if let Some(info) = files
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_mut(&path)
            {
                info.last_used = last_used;
                info.last_persisted = last_used;
            }
        }
    }

    fn clear_persisted_cache_kind(&self, kind: &str) {
        if let Ok(conn) = self.conn() {
            let _ = conn.execute("DELETE FROM cache_files WHERE kind = ?", [kind]);
        }
    }

    fn remove_persisted_cache_paths(&self, paths: &[PathBuf]) {
        if paths.is_empty() {
            return;
        }
        if let Ok(mut conn) = self.conn()
            && let Ok(tx) = conn.transaction()
        {
            if let Ok(mut stmt) = tx.prepare_cached("DELETE FROM cache_files WHERE path = ?") {
                for path in paths {
                    let _ = stmt.execute([path.to_string_lossy()]);
                }
            }
            let _ = tx.commit();
        }
    }

    fn touch_cache(
        &self,
        kind: &str,
        files: &Mutex<HashMap<PathBuf, CacheFileInfo>>,
        path: &Path,
        meta: &fs::Metadata,
    ) {
        let Some(info) = touch_cache_file(files, path, meta) else {
            return;
        };
        if let Ok(conn) = self.conn() {
            let _ = conn.execute(
                "INSERT INTO cache_files(path, kind, size, last_used) VALUES (?, ?, ?, ?)
                 ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size, last_used = excluded.last_used",
                rusqlite::params![path.to_string_lossy(), kind, info.size, info.last_used],
            );
        }
    }

    fn touch_thumbnail(&self, path: &Path, meta: &fs::Metadata) {
        self.touch_cache("thumbnail", &self.thumbnail_files, path, meta);
    }

    fn touch_decoded(&self, path: &Path, meta: &fs::Metadata) {
        self.touch_cache("decoded", &self.decoded_files, path, meta);
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
                    focus_score REAL,
                    orientation_indexed INTEGER NOT NULL DEFAULT 0
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

        let current_version: i32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if current_version < 6 {
            let table_info: Vec<String> = {
                let mut stmt = conn.prepare("PRAGMA table_info(image_metadata)")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            if !table_info.contains(&"orientation_indexed".to_string()) {
                conn.execute(
                    "ALTER TABLE image_metadata ADD COLUMN orientation_indexed INTEGER NOT NULL DEFAULT 0;",
                    [],
                )?;
            }
            conn.execute("PRAGMA user_version = 6;", [])?;
        }

        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_image_tags_tag_path ON image_tags(tag_name, image_path);
            CREATE INDEX IF NOT EXISTS idx_album_images_path ON album_images(image_path);
            CREATE INDEX IF NOT EXISTS idx_media_attributes_favorite_rating ON media_attributes(favorite, rating);
            CREATE INDEX IF NOT EXISTS idx_batch_history_created ON batch_history(created_secs);
            CREATE TABLE IF NOT EXISTS cache_files (
                path TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                size INTEGER NOT NULL,
                last_used INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_cache_files_kind_used ON cache_files(kind, last_used);
            "#,
        )?;

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
        self.cached_metadata_with_modified(path, modified)
    }

    fn cached_metadata_with_modified(
        &self,
        path: &Path,
        modified: i64,
    ) -> Result<Option<ImageMetadata>> {
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
        let (fingerprint, _) = self.image_fingerprint(path)?;
        Ok(self.thumb_dir.join(format!("{fingerprint}_{max_side}.jpg")))
    }

    fn cached_orientation(&self, path: &Path, modified: i64) -> Option<u16> {
        let conn = self.conn().ok()?;
        conn.query_row(
            "SELECT orientation FROM image_metadata
             WHERE path = ?1 AND modified_secs = ?2 AND orientation_indexed = 1",
            rusqlite::params![path.to_string_lossy(), modified],
            |row| row.get::<_, u16>(0),
        )
        .optional()
        .ok()
        .flatten()
    }

    pub fn ensure_thumbnail(&self, path: &Path, max_side: u32) -> Result<PathBuf> {
        let (fingerprint, modified) = self.image_fingerprint(path)?;
        let thumb_path = self.thumb_dir.join(format!("{fingerprint}_{max_side}.jpg"));
        if let Ok(meta) = fs::metadata(&thumb_path) {
            self.touch_thumbnail(&thumb_path, &meta);
            return Ok(thumb_path);
        }
        let _in_flight = InFlightGuard::acquire(&self.thumbnail_in_flight, &thumb_path);
        if let Ok(meta) = fs::metadata(&thumb_path) {
            self.touch_thumbnail(&thumb_path, &meta);
            return Ok(thumb_path);
        }
        let tmp_path = thumb_path.with_extension("tmp");

        if is_video_path(path) {
            #[cfg(target_os = "macos")]
            {
                let _permit = media_core::native_tool_permit();
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
                        if let Ok(meta) = fs::metadata(&thumb_path) {
                            self.touch_thumbnail(&thumb_path, &meta);
                        }
                        return Ok(thumb_path);
                    }
                }
            }
            anyhow::bail!("cannot generate thumbnail for video: {}", path.display());
        }

        let mut analysis_image = None;
        if media_core::can_use_sips(path) {
            media_core::sips_output_to_file(path, &tmp_path, Some(max_side), "jpeg")
                .with_context(|| format!("native sips thumbnail failed for {}", path.display()))?;
        } else {
            let decoded = if let Some(orientation) = self.cached_orientation(path, modified) {
                media_core::decode_image_with_orientation(path, Some(max_side), orientation)
            } else {
                decode_image(path, Some(max_side))
            }
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
            let image = image::DynamicImage::ImageRgba8(rgba);
            image.write_with_encoder(encoder).with_context(|| {
                format!("failed to write JPEG thumbnail {}", tmp_path.display())
            })?;
            analysis_image = Some(image);
        }

        std::fs::rename(&tmp_path, &thumb_path)
            .with_context(|| format!("failed to finalize thumbnail {}", thumb_path.display()))?;
        if let Ok(meta) = fs::metadata(&thumb_path) {
            self.touch_thumbnail(&thumb_path, &meta);
        }

        // Bound background analysis work so large warmups cannot create a thread burst.
        let _ = histogram_queue().try_send(HistogramRequest {
            pool: self.pool.clone(),
            path: path.to_path_buf(),
            thumbnail: thumb_path.clone(),
            image: analysis_image,
        });
        Ok(thumb_path)
    }

    pub fn cache_visual_histogram(
        &self,
        path: &Path,
        thumb_path: &Path,
    ) -> Result<VisualHistogram> {
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
        Ok((r, g, b, lum))
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
        let (fingerprint, _) = self.image_fingerprint(path)?;
        let cached = self.decoded_dir.join(format!("{fingerprint}.jpg"));
        if let Ok(meta) = fs::metadata(&cached) {
            self.touch_decoded(&cached, &meta);
            return Ok(cached);
        }
        let _in_flight = InFlightGuard::acquire(&self.decoded_in_flight, &cached);
        if let Ok(meta) = fs::metadata(&cached) {
            self.touch_decoded(&cached, &meta);
            return Ok(cached);
        }
        let tmp_path = cached.with_extension("tmp");

        let used_sips = if media_core::needs_sips_decode(path) || should_decode_with_sips(path) {
            match media_core::sips_output_to_file(path, &tmp_path, None, "jpeg") {
                Ok(()) => true,
                Err(err) if media_core::needs_sips_decode(path) => {
                    return Err(err).with_context(|| {
                        format!("native sips decode failed for {}", path.display())
                    });
                }
                Err(_) => false,
            }
        } else {
            false
        };

        if !used_sips {
            let img = media_core::open_image(path)?;
            let img = media_core::apply_exif_orientation(img, path);
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
        if let Ok(meta) = fs::metadata(&cached) {
            self.touch_decoded(&cached, &meta);
        }
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
        const WARM_LIMIT: usize = 20;
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
                if !native || should_decode_with_sips(path) {
                    let _ = self.ensure_decoded(path);
                }
            });
        }
    }

    /// Drop oldest decoded cache files until total size is under `limit_bytes`.
    pub fn prune_decoded_to_limit(&self, limit_bytes: u64) -> u64 {
        let (removed, paths) = prune_cache_files(&self.decoded_files, limit_bytes);
        self.remove_persisted_cache_paths(&paths);
        removed
    }

    fn image_fingerprint(&self, path: &Path) -> Result<(String, i64)> {
        let metadata = fs::metadata(path)?;
        let stamp = metadata_modified_secs(&metadata)
            .map(|secs| secs as i64)
            .with_context(|| format!("invalid modified time for {}", path.display()))?;
        let size = metadata.len();
        let mut fingerprints = self.fingerprints.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((cached_stamp, cached_size, fingerprint)) = fingerprints.get(path)
            && *cached_stamp == stamp
            && *cached_size == size
        {
            return Ok((fingerprint.clone(), stamp));
        }
        let key = format!("{}::{stamp}:{size}_v4", path.to_string_lossy());
        let fingerprint = blake3::hash(key.as_bytes()).to_hex().to_string();
        fingerprints.insert(path.to_path_buf(), (stamp, size, fingerprint.clone()));
        Ok((fingerprint, stamp))
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

        // Persist queued WAL pages before shutdown.
        if let Ok(conn) = self.conn() {
            let _ = conn.execute_batch(
                "PRAGMA wal_checkpoint(PASSIVE);
                 PRAGMA incremental_vacuum(50);",
            );
        }
    }
}

fn modified_secs(path: &Path) -> Result<i64> {
    let metadata = fs::metadata(path)?;
    metadata_modified_secs(&metadata)
        .map(|secs| secs as i64)
        .with_context(|| format!("invalid modified time for {}", path.display()))
}

fn metadata_modified_secs(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs())
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

    #[test]
    fn index_upsert_and_remove_keep_positions_current() {
        let item = |path: &str, width| LibraryItem {
            path: PathBuf::from(path),
            metadata: ImageMetadata {
                width,
                height: 100,
                orientation: 1,
                format: Some(image::ImageFormat::Jpeg),
                exif: None,
                focus_score: None,
            },
            is_video: false,
            size: 10,
            modified: 20,
        };
        let mut index = LibraryIndex::new(PathBuf::from("/tmp"), vec![item("/tmp/a.jpg", 100)]);
        index.upsert(item("/tmp/b.jpg", 200));
        index.upsert(item("/tmp/a.jpg", 300));
        assert_eq!(
            index
                .get(Path::new("/tmp/a.jpg"))
                .map(|item| item.metadata.width),
            Some(300)
        );
        assert!(index.remove(Path::new("/tmp/a.jpg")));
        assert_eq!(
            index
                .get(Path::new("/tmp/b.jpg"))
                .map(|item| item.metadata.width),
            Some(200)
        );
        assert!(!index.remove(Path::new("/tmp/missing.jpg")));
    }
}
