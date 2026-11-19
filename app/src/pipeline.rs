//! Background pipeline: folder scans and image decodes run on worker threads
//! and land on the UI thread through a mailbox drained in `poll`.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Condvar, Mutex};

use crate::decode;

pub const THUMB_PX: u32 = 512;
pub const FULL_PX: u32 = 4096;

pub enum Msg {
    Scanned { items: Vec<folio_scanner::MediaEntry> },
    Thumb { path: PathBuf, width: u32, height: u32, pixels: rune::Pixels },
    Full { path: PathBuf, width: u32, height: u32, pixels: rune::Pixels },
}

pub enum Job {
    Thumb(PathBuf),
    Full(PathBuf),
}

struct QueueInner {
    jobs: VecDeque<Job>,
    shutdown: bool,
}

pub struct Queue {
    inner: Mutex<QueueInner>,
    signal: Condvar,
}

impl Queue {
    fn new() -> Self {
        Self {
            inner: Mutex::new(QueueInner { jobs: VecDeque::new(), shutdown: false }),
            signal: Condvar::new(),
        }
    }

    pub fn push(&self, job: Job) {
        self.inner.lock().unwrap().jobs.push_back(job);
        self.signal.notify_one();
    }

    /// Jump the queue (viewer neighbours decode before the backlog).
    pub fn push_front(&self, job: Job) {
        self.inner.lock().unwrap().jobs.push_front(job);
        self.signal.notify_one();
    }

    pub fn clear(&self) {
        self.inner.lock().unwrap().jobs.clear();
    }

    fn pop(&self) -> Option<Job> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if let Some(job) = inner.jobs.pop_front() {
                return Some(job);
            }
            if inner.shutdown {
                return None;
            }
            inner = self.signal.wait(inner).unwrap();
        }
    }
}

pub struct Pipeline {
    pub tx: Sender<Msg>,
    pub rx: Mutex<Receiver<Msg>>,
    pub queue: Arc<Queue>,
}

impl Pipeline {
    pub fn new() -> Self {
        let (tx, rx) = channel();
        Self { tx, rx: Mutex::new(rx), queue: Arc::new(Queue::new()) }
    }

    /// Spawn decoder workers. Call once from `setup`.
    pub fn spawn_workers(&self, wake: Arc<dyn Fn() + Send + Sync>) {
        let workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).clamp(2, 8);
        for _ in 0..workers {
            let queue = self.queue.clone();
            let tx = self.tx.clone();
            let wake = wake.clone();
            std::thread::spawn(move || {
                while let Some(job) = queue.pop() {
                    let msg = match job {
                        Job::Thumb(path) => thumb(&path).map(|(w, h, pixels)| Msg::Thumb { path, width: w, height: h, pixels }),
                        Job::Full(path) => full(&path).map(|(w, h, pixels)| Msg::Full { path, width: w, height: h, pixels }),
                    };
                    if let Some(msg) = msg {
                        let _ = tx.send(msg);
                        wake();
                    }
                }
            });
        }
    }
}

/// Decode a thumbnail: disk cache first, then the decode chain (and cache it).
fn thumb(path: &Path) -> Option<(u32, u32, rune::Pixels)> {
    if let Some(key) = cache_key(path) {
        if let Some(bytes) = std::fs::read(cache_dir().join(&key)).ok() {
            if let Some(decoded) = decode::decode_jpeg(&bytes) {
                return Some(to_pixels(decoded));
            }
        }
        if let Some(decoded) = decode::decode_scaled(path, THUMB_PX) {
            if let Some(jpeg) = decode::encode_jpeg(decoded.width, decoded.height, decoded.rgba.clone()) {
                let _ = std::fs::write(cache_dir().join(key), jpeg);
            }
            return Some(to_pixels(decoded));
        }
        None
    } else {
        decode::decode_scaled(path, THUMB_PX).map(to_pixels)
    }
}

/// Decode the viewer image (subsampled to screen-ish size by ImageIO).
fn full(path: &Path) -> Option<(u32, u32, rune::Pixels)> {
    decode::decode_scaled(path, FULL_PX).map(to_pixels)
}

fn to_pixels(decoded: decode::Decoded) -> (u32, u32, rune::Pixels) {
    let pixels = rune::Pixels::new();
    pixels.set(decoded.width, decoded.height, decoded.rgba);
    (decoded.width, decoded.height, pixels)
}

/// Stable cache key: path + mtime + size + thumbnail size.
fn cache_key(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    use std::hash::{Hash, Hasher};
    path.hash(&mut hasher);
    modified.hash(&mut hasher);
    metadata.len().hash(&mut hasher);
    THUMB_PX.hash(&mut hasher);
    Some(format!("{:016x}.jpg", hasher.finish()))
}

pub fn cache_dir() -> PathBuf {
    let base = std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/tmp"));
    let dir = base.join("Library/Caches/Folio/thumbs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
