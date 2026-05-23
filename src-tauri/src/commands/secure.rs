use crate::AppState;
use std::sync::Arc;
use std::path::PathBuf;
use std::process::Command;
use tauri::{command, State};
use std::sync::OnceLock;

static HELPER_HASH: OnceLock<String> = OnceLock::new();

#[command]
pub async fn authenticate_vault() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = dirs::cache_dir().unwrap_or_else(std::env::temp_dir);
        let bin_dir = base.join("folio-app").join("bin");
        let helper_path = bin_dir.join("touchid_helper");

        let mut compile_needed = true;
        if let Some(expected_hash) = HELPER_HASH.get() {
            if helper_path.exists() {
                if let Ok(bytes) = std::fs::read(&helper_path) {
                    let current_hash = blake3::hash(&bytes).to_hex().to_string();
                    if &current_hash == expected_hash {
                        compile_needed = false;
                    }
                }
            }
        }

        if compile_needed {
            let _ = std::fs::remove_file(&helper_path);
            let _ = std::fs::create_dir_all(&bin_dir);
            let swift_source = r#"
import LocalAuthentication
import Foundation

let context = LAContext()
var error: NSError?

let policy: LAPolicy
if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
    policy = .deviceOwnerAuthenticationWithBiometrics
} else {
    policy = .deviceOwnerAuthentication
}

let sema = DispatchSemaphore(value: 0)
var authSuccess = false

context.evaluatePolicy(policy, localizedReason: "unlock your Secure Vault in Folio") { success, _ in
    authSuccess = success
    sema.signal()
}

sema.wait()
exit(authSuccess ? 0 : 1)
"#;
            let temp_swift_path = bin_dir.join("touchid_helper.swift");
            std::fs::write(&temp_swift_path, swift_source)
                .map_err(|e| format!("Failed to write Swift helper source: {}", e))?;

            let compile_output = Command::new("swiftc")
                .arg("-O")
                .arg("-o")
                .arg(&helper_path)
                .arg(&temp_swift_path)
                .output();

            let _ = std::fs::remove_file(&temp_swift_path);

            match compile_output {
                Ok(out) if out.status.success() => {
                    let bytes = std::fs::read(&helper_path)
                        .map_err(|e| format!("Failed to read compiled helper: {}", e))?;
                    let new_hash = blake3::hash(&bytes).to_hex().to_string();
                    HELPER_HASH.get_or_init(|| new_hash);
                }
                Ok(out) => {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    return Err(format!("Failed to compile biometric helper: {}", stderr));
                }
                Err(e) => {
                    return Err(format!("Swift compiler execution failed: {}", e));
                }
            }
        }

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

#[command]
pub async fn scrub_exif_metadata(path: String, state: State<'_, Arc<AppState>>) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target path lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let file = std::fs::File::open(&p).map_err(|e| format!("Failed to read file: {}", e))?;
        let mmap = unsafe { memmap2::Mmap::map(&file).map_err(|e| format!("Failed to mmap file: {}", e))? };
        let bytes = &mmap[..];
        if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
            return Err("File is not a valid JPEG".to_string());
        }

        let mut output = Vec::with_capacity(bytes.len());
        // SOI (Start of Image)
        output.push(0xFF);
        output.push(0xD8);

        let mut pos = 2;
        let mut skipped_exif = false;

        while pos < bytes.len() {
            if pos + 1 >= bytes.len() {
                output.extend_from_slice(&bytes[pos..]);
                break;
            }

            // A marker must start with 0xFF
            if bytes[pos] != 0xFF {
                // If it is not a marker, copy remaining and stop
                output.extend_from_slice(&bytes[pos..]);
                break;
            }

            let marker = bytes[pos + 1];
            if marker == 0xD9 {
                // EOI (End of Image)
                output.push(0xFF);
                output.push(0xD9);
                break;
            }

            if marker == 0xDA {
                // SOS (Start of Scan) - rest of file is compressed entropy stream
                output.extend_from_slice(&bytes[pos..]);
                break;
            }

            // Read segment length (2 bytes, big-endian)
            if pos + 3 >= bytes.len() {
                output.extend_from_slice(&bytes[pos..]);
                break;
            }
            let len = ((bytes[pos + 2] as usize) << 8) | (bytes[pos + 3] as usize);
            
            if pos + 2 + len > bytes.len() {
                output.extend_from_slice(&bytes[pos..]);
                break;
            }

            // APP1 (0xFFE1) and APP13 (0xFFED) hold EXIF, GPS, and IPTC/XMP metadata
            if marker == 0xE1 || marker == 0xED {
                // Skip these metadata segments entirely
                skipped_exif = true;
                pos += 2 + len;
                continue;
            }

            // Copy this segment to output
            output.extend_from_slice(&bytes[pos .. pos + 2 + len]);
            pos += 2 + len;
        }

        if !skipped_exif {
            return Ok("No EXIF metadata segment was found".to_string());
        }

        // Save lossless scrubbed file back in place
        std::fs::write(&p, &output).map_err(|e| format!("Failed to write scrubbed image: {}", e))?;
        Ok("EXIF and GPS metadata successfully scrubbed losslessly!".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[command]
pub async fn audit_file_checksum(path: String, state: State<'_, Arc<AppState>>) -> Result<String, String> {
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
                Ok(n) => { hasher.update(&buf[..n]); }
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
pub async fn search_directory_spotlight(dir_path: String, query: String, state: State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    let p = PathBuf::from(&dir_path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target directory lies outside safe sandbox limits".to_string());
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
                let list = stdout.lines()
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
pub async fn show_native_share_sheet(file_path: String, state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let p = PathBuf::from(&file_path);
    if !crate::is_path_safe(&p, &state) {
        return Err("Permission denied: target file lies outside safe sandbox limits".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Escape double-quotes and backslashes in path string for AppleScript safety
        let path_str = p.to_string_lossy().replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            r#"tell application "Finder" to reveal POSIX file "{}"
               tell application "System Events"
                   tell process "Finder"
                       click menu item "Share" of menu "File" of menu bar 1
                   end tell
               end tell"#,
            path_str
        );

        let output = Command::new("osascript")
            .arg("-e")
            .arg(&script)
            .output();

        match output {
            Ok(out) if out.status.success() => Ok(()),
            Ok(out) => {
                let stderr = String::from_utf8_lossy(&out.stderr);
                Err(format!("Sharing sheet failed to trigger: {}", stderr))
            }
            Err(e) => Err(format!("Sharing controller error: {}", e)),
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
        let content_hash = blake3::hash(capped_diagnostics.as_bytes()).to_hex().to_string();
        let short_hash = &content_hash[0..8];
        let file_path = reports_dir.join(format!("crash_report_{}_{}.json", timestamp, short_hash));
        
        let report = serde_json::json!({
            "timestamp": timestamp,
            "os": "macOS",
            "diagnostics": capped_diagnostics
        });
        
        let content = serde_json::to_string_pretty(&report)
            .map_err(|e| e.to_string())?;
        
        std::fs::write(&file_path, content)
            .map_err(|e| format!("Failed to write crash report: {}", e))?;
            
        Ok(file_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
