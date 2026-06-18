use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "dng", "raf", "raw",
    "cr2", "cr3", "nef", "arw", "orf", "rw2",
];

#[derive(Debug)]
struct MediaItem {
    path: PathBuf,
    name: String,
    size: u64,
    modified: i64,
}

fn main() {
    let Some(root) = env::args().nth(1) else {
        eprintln!("usage: folio-scanner <folder>");
        std::process::exit(2);
    };

    let root = PathBuf::from(root);
    if !root.is_dir() {
        eprintln!("not a folder: {}", root.display());
        std::process::exit(2);
    }

    let mut items = Vec::with_capacity(4096);
    scan_folder(&root, &mut items);
    items.sort_unstable_by(|a, b| b.modified.cmp(&a.modified).then_with(|| a.name.cmp(&b.name)));
    print_json(&root, &items);
}

fn scan_folder(folder: &Path, items: &mut Vec<MediaItem>) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };

        if file_type.is_dir() {
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if file_name.starts_with('.') || file_name == "node_modules" || file_name == "target" {
                continue;
            }
            scan_folder(&path, items);
            continue;
        }

        if !file_type.is_file() || !is_image(&path) {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or_default();

        items.push(MediaItem {
            name: entry.file_name().to_string_lossy().to_string(),
            path,
            size: metadata.len(),
            modified,
        });
    }
}

fn is_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            let extension = extension.to_ascii_lowercase();
            IMAGE_EXTENSIONS.contains(&extension.as_str())
        })
        .unwrap_or(false)
}

fn print_json(root: &Path, items: &[MediaItem]) {
    print!("{{\"root\":\"{}\",\"count\":{},\"items\":[", escape_json(&root.display().to_string()), items.len());
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            print!(",");
        }
        print!(
            "{{\"path\":\"{}\",\"name\":\"{}\",\"size\":{},\"modified\":{}}}",
            escape_json(&item.path.display().to_string()),
            escape_json(&item.name),
            item.size,
            item.modified
        );
    }
    println!("]}}");
}

fn escape_json(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            character if character.is_control() => {
                output.push_str(&format!("\\u{:04x}", character as u32));
            }
            character => output.push(character),
        }
    }
    output
}

