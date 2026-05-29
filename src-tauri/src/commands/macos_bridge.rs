use std::path::{Path, PathBuf};
use std::process::Command;

fn helper_path() -> Result<PathBuf, String> {
    if let Some(path) = option_env!("FOLIO_MACOS_HELPER") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }
    if let Ok(path) = std::env::var("FOLIO_MACOS_HELPER") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Ok(p);
        }
    }

    let exe = std::env::current_exe()
        .map_err(|e| format!("Unable to resolve Folio executable path: {e}"))?;
    let exe_dir = exe
        .parent()
        .ok_or_else(|| "Unable to resolve Folio executable directory".to_string())?;

    for candidate in [
        exe_dir.join("folio_macos_helper"),
        exe_dir.join("../Resources/folio_macos_helper"),
        exe_dir.join("../../Resources/folio_macos_helper"),
    ] {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("macOS helper is not bundled. Rebuild the app with folio_macos_helper.".to_string())
}

fn run_helper(args: &[&str]) -> Result<std::process::Output, String> {
    let helper = helper_path()?;
    Command::new(helper)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run macOS helper: {e}"))
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct ImageClassification {
    pub label: String,
    pub confidence: f64,
}

pub fn share_file(path: &Path) -> Result<(), String> {
    let path_str = path.to_string_lossy();
    let output = run_helper(&["share", &path_str])?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(format!("Share sheet failed: {stderr}"))
    }
}

pub fn haptic_tick(style: &str) -> Result<(), String> {
    let _ = run_helper(&["haptic", style])?;
    Ok(())
}

pub fn classify_image(path: &Path) -> Result<Vec<ImageClassification>, String> {
    let path_str = path.to_string_lossy();
    let output = run_helper(&["classify", &path_str])?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str(stdout.trim())
        .map_err(|e| format!("Failed to parse classification JSON: {e}"))
}

pub fn play_live_photo_video(video_path: &Path) -> Result<(), String> {
    let path_str = video_path.to_string_lossy().into_owned();
    std::thread::spawn(move || {
        let _ = run_helper(&["livephoto", &path_str]);
    });
    Ok(())
}
