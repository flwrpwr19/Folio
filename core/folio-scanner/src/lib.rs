use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use jwalk::WalkDir;

pub const IMAGE_EXTENSIONS: &[&str] = &[
    // Raster
    "jpg", "jpeg", "jpe", "jif", "jfif", "png", "apng", "gif", "webp", "tif", "tiff", "bmp", "dib",
    "ico", "icns", "tga", "icb", "vda", "vst", "pnm", "pbm", "pgm", "ppm", "pfm", "pam", "qoi",
    "dds", "ff", "farbfeld", "hdr", "pic", "exr", "avif", "jxl",
    // Apple
    "heic", "heif", "hif",
    // Camera RAW
    "dng", "crw", "cr2", "cr3", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "rwl",
    "raw", "rwz", "pef", "ptx", "srw", "x3f", "3fr", "erf", "mef", "mos", "iiq", "kdc", "dcr",
    "k25", "mrw", "bay", "bmq", "cs1", "dc2", "fff", "ia", "kc2", "mdc", "mfw", "nkc", "ori",
    "pef", "pxn", "rdc", "srf", "sti",
];

pub fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| IMAGE_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

#[derive(Debug, Clone)]
pub struct MediaEntry {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified: i64,
}

/// Recursively collect image files under `root` in parallel (jwalk), sorted by
/// modified time (newest first), then name. Unreadable entries are skipped.
pub fn scan(root: &Path) -> Vec<MediaEntry> {
    let mut items: Vec<MediaEntry> = WalkDir::new(root)
        .skip_hidden(true)
        .process_read_dir(|_depth, _path, _state, children| {
            children.retain(|entry| match entry {
                Ok(entry) => {
                    let file_type = entry.file_type();
                    if file_type.is_dir() {
                        let name = entry.file_name().to_string_lossy();
                        name != "node_modules" && name != "target"
                    } else {
                        file_type.is_file() && is_image(&entry.path())
                    }
                }
                Err(_) => false,
            })
        })
        .into_iter()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            if !entry.file_type().is_file() {
                return None;
            }
            let metadata = fs::metadata(entry.path()).ok()?;
            let modified = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_secs() as i64)
                .unwrap_or_default();
            Some(MediaEntry {
                path: entry.path(),
                name: entry.file_name().to_string_lossy().to_string(),
                size: metadata.len(),
                modified,
            })
        })
        .collect();
    items.sort_unstable_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    items
}
