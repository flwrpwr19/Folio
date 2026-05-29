use std::path::{Path, PathBuf};
use std::process::Command;

const BUNDLE_ID: &str = "com.folio.app";

const MEDIA_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "tiff", "tif", "bmp", "avif", "dng", "cr2",
    "nef", "arw", "orf", "mp4", "mov", "m4v", "mkv", "webm", "avi",
];

#[derive(serde::Serialize)]
pub struct DefaultHandlerResult {
    pub success: bool,
    pub message: String,
    pub method: String,
}

fn duti_available() -> bool {
    Command::new("which")
        .arg("duti")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn register_with_duti() -> Result<usize, String> {
    if !duti_available() {
        return Err("duti not installed".to_string());
    }
    let mut count = 0;
    for ext in MEDIA_EXTENSIONS {
        let status = Command::new("duti")
            .args(["-s", BUNDLE_ID, ext, "all"])
            .status()
            .map_err(|e| format!("duti failed: {e}"))?;
        if status.success() {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(target_os = "macos")]
fn refresh_launch_services() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = Command::new(
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        )
        .args(["-f"])
        .arg(&exe)
        .status();
    }
}

/// Register Folio as the default app for common photo/video extensions (requires `duti`).
#[tauri::command]
pub async fn set_default_media_handler() -> Result<DefaultHandlerResult, String> {
    #[cfg(not(target_os = "macos"))]
    {
        return Ok(DefaultHandlerResult {
            success: false,
            message: "Default handler registration is only supported on macOS.".to_string(),
            method: "unsupported".to_string(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        refresh_launch_services();
        match register_with_duti() {
            Ok(count) if count > 0 => Ok(DefaultHandlerResult {
                success: true,
                message: format!(
                    "Folio is now the default app for {count} common photo and video types."
                ),
                method: "duti".to_string(),
            }),
            Ok(_) => Ok(DefaultHandlerResult {
                success: false,
                message: "Could not update default handlers. Try the manual steps below.".to_string(),
                method: "duti".to_string(),
            }),
            Err(_) => Ok(DefaultHandlerResult {
                success: false,
                message: "Install duti (`brew install duti`) or set Folio manually: right-click a file → Open With → Folio, then Finder → Get Info → Open with → Change All…".to_string(),
                method: "manual".to_string(),
            }),
        }
    }
}

/// Reveal a file in Finder and open its Get Info panel (manual default-app flow).
#[tauri::command]
pub async fn show_file_open_with_help(sample_path: Option<String>) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = sample_path;
        return Err("Only supported on macOS".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        let path = resolve_sample_path(sample_path.as_deref())?;
        let path_str = path.to_string_lossy();
        let script = format!(
            r#"tell application "Finder"
  reveal POSIX file "{path}"
  activate
  open information window of (POSIX file "{path}" as alias)
end tell"#,
            path = path_str.replace('\\', "\\\\").replace('"', "\\\"")
        );
        Command::new("osascript")
            .args(["-e", &script])
            .status()
            .map_err(|e| format!("Failed to open Finder Get Info: {e}"))?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn resolve_sample_path(sample_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(p) = sample_path {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    let home = dirs::home_dir().ok_or("No home directory")?;
    let pictures = home.join("Pictures");
    if pictures.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&pictures) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_file() && is_media_path(&p) {
                    return Ok(p);
                }
            }
        }
    }
    Err("Open a photo or video in Finder first, or pass a sample file path.".to_string())
}

fn is_media_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| MEDIA_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

pub fn paths_from_opened_urls(urls: &[tauri::Url]) -> Vec<PathBuf> {
    urls.iter()
        .filter_map(|url| url.to_file_path().ok())
        .collect()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn set_default_media_handler() -> Result<DefaultHandlerResult, String> {
    Ok(DefaultHandlerResult {
        success: false,
        message: "Default handler registration is only supported on macOS.".to_string(),
        method: "unsupported".to_string(),
    })
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn show_file_open_with_help(_sample_path: Option<String>) -> Result<(), String> {
    Err("Only supported on macOS".to_string())
}
