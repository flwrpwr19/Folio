use crate::AppState;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use tauri::{State, command};

fn bundled_touchid_helper_path() -> Result<PathBuf, String> {
    if let Ok(path) = std::env::var("FOLIO_TOUCHID_HELPER") {
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

    let candidates = [
        exe_dir.join("touchid_helper"),
        exe_dir.join("../Resources/touchid_helper"),
        exe_dir.join("../../Resources/touchid_helper"),
    ];

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "Biometric helper is not bundled. Disable Biometric Album Lock or build the signed helper with the app bundle.".to_string())
}

#[command]
pub async fn authenticate_vault() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let helper_path = bundled_touchid_helper_path()?;
        let output = Command::new(&helper_path).output();

        match output {
            Ok(out) => {
                if out.status.success() {
                    Ok(true)
                } else {
                    match out.status.code() {
                        Some(1) => Ok(false),
                        _ => {
                            let stderr = String::from_utf8_lossy(&out.stderr);
                            Err(format!("Biometric helper failed: {}", stderr))
                        }
                    }
                }
            }
            Err(e) => Err(format!("Failed to run biometric helper: {}", e)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn scrub_exif_metadata_file(p: &std::path::Path) -> Result<String, String> {
    let bytes = std::fs::read(p).map_err(|e| format!("Failed to read file: {e}"))?;
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("File is not a valid JPEG".to_string());
    }

    let mut output = Vec::with_capacity(bytes.len());
    output.extend_from_slice(&[0xFF, 0xD8]);

    let mut pos = 2;
    let mut skipped_exif = false;

    while pos < bytes.len() {
        if pos + 1 >= bytes.len() {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        if bytes[pos] != 0xFF {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        let marker = bytes[pos + 1];
        if marker == 0xD9 {
            output.extend_from_slice(&[0xFF, 0xD9]);
            break;
        }

        if marker == 0xDA {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        if pos + 3 >= bytes.len() {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        let len = ((bytes[pos + 2] as usize) << 8) | (bytes[pos + 3] as usize);
        if pos + 2 + len > bytes.len() {
            output.extend_from_slice(&bytes[pos..]);
            break;
        }

        if marker == 0xE1 || marker == 0xED {
            skipped_exif = true;
            pos += 2 + len;
            continue;
        }

        output.extend_from_slice(&bytes[pos..pos + 2 + len]);
        pos += 2 + len;
    }

    if !skipped_exif {
        return Ok("No EXIF metadata segment was found".to_string());
    }

    let tmp = p.with_extension(format!(
        "{}.folio-tmp",
        p.extension().and_then(|e| e.to_str()).unwrap_or("jpg")
    ));
    std::fs::write(&tmp, &output).map_err(|e| format!("Failed to write scrubbed image: {e}"))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to replace original image atomically: {e}")
    })?;
    Ok("EXIF and GPS metadata successfully scrubbed losslessly!".to_string())
}

#[command]
pub async fn scrub_exif_metadata(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target path lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || scrub_exif_metadata_file(&p))
        .await
        .map_err(|e| e.to_string())?
}

#[command]
pub async fn audit_file_checksum(
    path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target path lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&p).map_err(|e| format!("Failed to read file: {}", e))?;
        let mut reader = std::io::BufReader::new(file);
        let mut hasher = blake3::Hasher::new();
        use std::io::Read;
        let mut buf = [0u8; 65536];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    hasher.update(&buf[..n]);
                }
                Err(e) => return Err(format!("Failed to read file: {}", e)),
            }
        }
        let hash = hasher.finalize().to_hex().to_string();
        Ok(hash)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn search_directory_spotlight(
    dir_path: String,
    query: String,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<String>, String> {
    let p = PathBuf::from(&dir_path);
    if !crate::is_path_safe(&p, &state) {
        return Err(
            "Permission denied: target directory lies outside safe sandbox limits".to_string(),
        );
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Sanitize the query string to prevent spotlight query injection
        let sanitized_query = query.replace('\\', "").replace('\'', "").replace('*', "");
        let output = Command::new("mdfind")
            .arg("-onlyin")
            .arg(&dir_path)
            .arg(format!("kMDItemFSName == '*{}*'", sanitized_query))
            .output();

        match output {
            Ok(out) if out.status.success() => {
                let stdout = String::from_utf8_lossy(&out.stdout);
                let list = stdout
                    .lines()
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<String>>();
                Ok(list)
            }
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(format!("mdfind query failed: {}", stderr))
            }
            Err(e) => Err(format!("mdfind command failed: {}", e)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn show_native_share_sheet(
    file_path: String,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let p = PathBuf::from(&file_path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target file lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            crate::commands::macos_bridge::share_file(&p)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = p;
            Err("Native share sheet is only supported on macOS".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn open_in_finder(
    path: String,
    reveal: bool,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target path lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = Command::new("open");
        if reveal || p.is_file() {
            cmd.arg("-R");
        }
        cmd.arg(&p);

        match cmd.output() {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(format!("Finder failed to open target: {stderr}"))
            }
            Err(e) => Err(format!("Failed to launch Finder: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn submit_crash_report(diagnostics: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Cap diagnostics to 1MB to prevent disk exhaustion
        let capped_diagnostics: String = diagnostics.chars().take(1_048_576).collect();

        let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
        let reports_dir = base.join("folio-app").join("crash_reports");
        let _ = std::fs::create_dir_all(&reports_dir);

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        // Calculate hash of content to ensure unique filename
        let content_hash = blake3::hash(capped_diagnostics.as_bytes())
            .to_hex()
            .to_string();
        let short_hash = &content_hash[0..8];
        let file_path = reports_dir.join(format!("crash_report_{}_{}.json", timestamp, short_hash));

        let report = serde_json::json!({
            "timestamp": timestamp,
            "os": "macOS",
            "diagnostics": capped_diagnostics
        });

        let content = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;

        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write crash report: {}", e))?;

        Ok(file_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::scrub_exif_metadata_file;

    fn temp_file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "folio_test_{}_{}_{}",
            name,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        ))
    }

    #[test]
    fn scrub_exif_metadata_file_removes_app1_segment() {
        let path = temp_file("scrub_exif.jpg");
        let bytes = vec![
            0xFF, 0xD8, // SOI
            0xFF, 0xE1, 0x00, 0x0C, b'E', b'x', b'i', b'f', 0x00, 0x00, 1, 2, 3, 4, // APP1
            0xFF, 0xDA, 0x00, 0x04, 0, 0, // SOS
            0x11, 0x22, 0x33, 0xFF, 0xD9, // EOI
        ];
        if let Err(e) = std::fs::write(&path, bytes) {
            panic!("failed to write fixture: {e}");
        }

        let result = match scrub_exif_metadata_file(&path) {
            Ok(result) => result,
            Err(e) => panic!("scrub failed: {e}"),
        };
        let scrubbed = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) => panic!("failed to read scrubbed fixture: {e}"),
        };
        let _ = std::fs::remove_file(&path);

        assert!(result.contains("successfully scrubbed"));
        assert!(!scrubbed.windows(6).any(|w| w == b"Exif\0\0"));
        assert_eq!(&scrubbed[0..2], &[0xFF, 0xD8]);
    }
}
