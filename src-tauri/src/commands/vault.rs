use crate::AppState;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use library_core::rusqlite;
use parking_lot::RwLock;
use rand::RngCore;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

const KEYCHAIN_SERVICE: &str = "com.folio.app.vault";
const DEFAULT_VAULT: &str = "Secure Album";
const VAULT_V2_MAGIC: &[u8; 8] = b"FOLIOV2\0";
const VAULT_CHUNK_SIZE: usize = 1024 * 1024;
const VAULT_TAG_SIZE: usize = 16;

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[derive(Default)]
pub struct VaultRuntime {
    unlocked_until: RwLock<Option<Instant>>,
    auto_lock_minutes: RwLock<u64>,
    canonical_dir: RwLock<Option<PathBuf>>,
}

impl VaultRuntime {
    pub fn new() -> Self {
        Self {
            unlocked_until: RwLock::new(None),
            auto_lock_minutes: RwLock::new(5),
            canonical_dir: RwLock::new(default_vault_dir().canonicalize().ok()),
        }
    }

    pub fn set_unlocked(&self) {
        let minutes = *self.auto_lock_minutes.read();
        *self.unlocked_until.write() = Some(Instant::now() + Duration::from_secs(minutes * 60));
    }

    pub fn lock(&self) {
        *self.unlocked_until.write() = None;
    }

    pub fn is_unlocked(&self) -> bool {
        let mut guard = self.unlocked_until.write();
        if let Some(until) = *guard {
            if Instant::now() <= until {
                return true;
            }
            *guard = None;
        }
        false
    }

    pub fn auto_lock_minutes(&self) -> u64 {
        *self.auto_lock_minutes.read()
    }

    pub fn refresh_canonical_dir(&self) {
        *self.canonical_dir.write() = default_vault_dir().canonicalize().ok();
    }

    pub fn contains_canonical_path(&self, path: &Path) -> bool {
        if self.canonical_dir.read().is_none() {
            self.refresh_canonical_dir();
        }
        self.canonical_dir
            .read()
            .as_ref()
            .is_some_and(|vault| path.starts_with(vault))
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VaultStatus {
    pub configured: bool,
    pub unlocked: bool,
    pub item_count: usize,
    pub auto_lock_minutes: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct VaultInfo {
    pub name: String,
    pub item_count: usize,
}

pub fn default_vault_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("folio-app")
        .join("vault")
}

pub fn is_vault_path(path: &Path) -> bool {
    let Ok(vault) = default_vault_dir().canonicalize() else {
        return false;
    };
    path.canonicalize()
        .map(|p| p.starts_with(vault))
        .unwrap_or(false)
}

pub fn ensure_vault_unlocked(state: &AppState) -> Result<(), String> {
    if state.vault.is_unlocked() {
        Ok(())
    } else {
        Err("Secure Album Vault is locked".to_string())
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut chars = s.as_bytes().chunks_exact(2);
    for pair in &mut chars {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

fn key_file_path() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("folio-app")
        .join("vault.key")
}

fn read_keychain_password() -> Option<String> {
    let account = std::env::var("USER").unwrap_or_else(|_| "folio".to_string());
    let output = Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            &account,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn write_keychain_password(secret: &str) -> bool {
    let account = std::env::var("USER").unwrap_or_else(|_| "folio".to_string());
    Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            &account,
            "-s",
            KEYCHAIN_SERVICE,
            "-w",
            secret,
        ])
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn vault_key() -> Result<[u8; 32], String> {
    if let Some(secret) = read_keychain_password()
        && let Some(bytes) = hex_decode(&secret)
        && bytes.len() == 32
    {
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }

    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    let encoded = hex_encode(&key);
    if write_keychain_password(&encoded) {
        return Ok(key);
    }

    let path = key_file_path();
    if path.exists() {
        let stored = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read fallback vault key: {e}"))?;
        if let Some(bytes) = hex_decode(stored.trim())
            && bytes.len() == 32
        {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create key dir: {e}"))?;
    }
    std::fs::write(&path, encoded)
        .map_err(|e| format!("Failed to store fallback vault key: {e}"))?;
    Ok(key)
}

fn encrypt_file_to_vault(source: &Path, dest: &Path, key: &[u8; 32]) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let tmp = dest.with_extension("vault-tmp");
    let _tmp_guard = TempFileGuard(tmp.clone());
    let input = std::fs::File::open(source).map_err(|e| format!("Failed to read source: {e}"))?;
    let output =
        std::fs::File::create(&tmp).map_err(|e| format!("Failed to write encrypted file: {e}"))?;
    let mut reader = BufReader::new(input);
    let mut writer = BufWriter::new(output);
    writer
        .write_all(VAULT_V2_MAGIC)
        .map_err(|e| format!("Failed to write encrypted file: {e}"))?;
    let mut chunk = vec![0u8; VAULT_CHUNK_SIZE];
    let mut chunk_index = 0_u64;
    loop {
        let read = reader
            .read(&mut chunk)
            .map_err(|e| format!("Failed to read source: {e}"))?;
        if read == 0 {
            break;
        }
        let mut nonce_bytes = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &chunk[..read],
                    aad: &chunk_index.to_le_bytes(),
                },
            )
            .map_err(|e| format!("Failed to encrypt file: {e}"))?;
        let ciphertext_len = u32::try_from(ciphertext.len())
            .map_err(|_| "Encrypted vault chunk is too large".to_string())?;
        writer
            .write_all(&nonce_bytes)
            .and_then(|_| writer.write_all(&ciphertext_len.to_le_bytes()))
            .and_then(|_| writer.write_all(&ciphertext))
            .map_err(|e| format!("Failed to write encrypted file: {e}"))?;
        chunk_index += 1;
    }
    let mut terminal_nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut terminal_nonce);
    let terminal = cipher
        .encrypt(
            Nonce::from_slice(&terminal_nonce),
            Payload {
                msg: &[],
                aad: &chunk_index.to_le_bytes(),
            },
        )
        .map_err(|e| format!("Failed to encrypt file terminator: {e}"))?;
    writer
        .write_all(&terminal_nonce)
        .and_then(|_| writer.write_all(&(terminal.len() as u32).to_le_bytes()))
        .and_then(|_| writer.write_all(&terminal))
        .map_err(|e| format!("Failed to write encrypted file terminator: {e}"))?;
    writer
        .flush()
        .map_err(|e| format!("Failed to write encrypted file: {e}"))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize encrypted file: {e}")
    })
}

fn decrypt_file_to_path(source: &Path, dest: &Path, key: &[u8; 32]) -> Result<(), String> {
    let tmp = dest.with_extension("vault-export-tmp");
    let _tmp_guard = TempFileGuard(tmp.clone());
    let input =
        std::fs::File::open(source).map_err(|e| format!("Failed to read vault item: {e}"))?;
    let mut reader = BufReader::new(input);
    let mut magic = [0u8; 8];
    reader
        .read_exact(&mut magic)
        .map_err(|e| format!("Failed to read vault item: {e}"))?;
    if &magic == VAULT_V2_MAGIC {
        decrypt_v2(&mut reader, &tmp, key)?;
    } else {
        decrypt_legacy(source, &tmp, key)?;
    }
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize export: {e}")
    })
}

fn decrypt_v2(reader: &mut impl Read, dest: &Path, key: &[u8; 32]) -> Result<(), String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let output = std::fs::File::create(dest).map_err(|e| format!("Failed to write export: {e}"))?;
    let mut writer = BufWriter::new(output);
    let mut chunk_index = 0_u64;
    loop {
        let mut nonce_bytes = [0u8; 12];
        let read = reader
            .read(&mut nonce_bytes[..1])
            .map_err(|e| format!("Failed to read vault chunk: {e}"))?;
        if read == 0 {
            return Err("Vault item ended before terminal marker".to_string());
        }
        reader
            .read_exact(&mut nonce_bytes[1..])
            .map_err(|e| format!("Failed to read vault chunk: {e}"))?;
        let mut len_bytes = [0u8; 4];
        reader
            .read_exact(&mut len_bytes)
            .map_err(|e| format!("Failed to read vault chunk length: {e}"))?;
        let chunk_len = u32::from_le_bytes(len_bytes) as usize;
        if chunk_len > VAULT_CHUNK_SIZE + 32 {
            return Err("Encrypted vault chunk is too large".to_string());
        }
        let mut ciphertext = vec![0u8; chunk_len];
        reader
            .read_exact(&mut ciphertext)
            .map_err(|e| format!("Failed to read vault chunk: {e}"))?;
        let plaintext = cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: ciphertext.as_ref(),
                    aad: &chunk_index.to_le_bytes(),
                },
            )
            .map_err(|e| format!("Failed to decrypt vault chunk: {e}"))?;
        if chunk_len == VAULT_TAG_SIZE {
            if !plaintext.is_empty() {
                return Err("Vault item has an invalid terminal marker".to_string());
            }
            let mut trailing = [0_u8; 1];
            if reader
                .read(&mut trailing)
                .map_err(|e| format!("Failed to read vault item terminator: {e}"))?
                != 0
            {
                return Err("Vault item has trailing data".to_string());
            }
            break;
        }
        writer
            .write_all(&plaintext)
            .map_err(|e| format!("Failed to write export: {e}"))?;
        chunk_index += 1;
    }
    writer
        .flush()
        .map_err(|e| format!("Failed to write export: {e}"))
}

fn decrypt_legacy(source: &Path, dest: &Path, key: &[u8; 32]) -> Result<(), String> {
    let bytes = std::fs::read(source).map_err(|e| format!("Failed to read vault item: {e}"))?;
    if bytes.len() < 13 {
        return Err("Vault item is too small to decrypt".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| e.to_string())?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&bytes[..12]), &bytes[12..])
        .map_err(|e| format!("Failed to decrypt vault item: {e}"))?;
    std::fs::write(dest, plaintext).map_err(|e| format!("Failed to write export: {e}"))
}

pub fn vault_add_files_sync(
    paths: Vec<String>,
    state: &AppState,
) -> crate::commands::metadata::BatchResult {
    let mut result = crate::commands::metadata::BatchResult::default();
    if let Err(e) = ensure_vault_unlocked(state) {
        result.push_error(e);
        return result;
    }
    let key = match vault_key() {
        Ok(key) => key,
        Err(e) => {
            result.push_error(e);
            return result;
        }
    };
    let vault_dir = default_vault_dir();
    if let Err(e) = std::fs::create_dir_all(&vault_dir) {
        result.push_error(format!("Failed to create vault dir: {e}"));
        return result;
    }
    state.vault.refresh_canonical_dir();

    let conn = match state.cache.conn() {
        Ok(conn) => conn,
        Err(e) => {
            result.push_error(e.to_string());
            return result;
        }
    };

    for path in paths {
        let source = PathBuf::from(&path);
        if !crate::is_path_safe(&source, state) {
            result.push_error(format!("{path}: outside safe roots"));
            continue;
        }
        if !source.is_file() {
            result.push_error(format!("{path}: not a file"));
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        let file_name = source
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("vault-item")
            .to_string();
        let encrypted = vault_dir.join(format!("{id}.folio-vault"));
        match encrypt_file_to_vault(&source, &encrypted, &key) {
            Ok(()) => {
                let size = std::fs::metadata(&source)
                    .map(|m| m.len() as i64)
                    .unwrap_or(0);
                let inserted = conn.execute(
                    "INSERT INTO vault_items (id, vault_name, original_path, file_name, encrypted_path, size, added_secs) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    rusqlite::params![id, DEFAULT_VAULT, path, file_name, encrypted.to_string_lossy(), size, now_secs()],
                );
                match inserted {
                    Ok(_) => result.success += 1,
                    Err(e) => result.push_error(e.to_string()),
                }
            }
            Err(e) => result.push_error(format!("{path}: {e}")),
        }
    }
    state.cache.schedule_flush();
    result
}

pub fn vault_export_files_sync(
    ids: Vec<String>,
    destination: String,
    state: &AppState,
) -> crate::commands::metadata::BatchResult {
    let mut result = crate::commands::metadata::BatchResult::default();
    if let Err(e) = ensure_vault_unlocked(state) {
        result.push_error(e);
        return result;
    }
    let dest_dir = PathBuf::from(&destination);
    if !crate::is_path_safe(&dest_dir, state) || !dest_dir.is_dir() {
        result.push_error("Destination is outside safe roots or is not a folder".to_string());
        return result;
    }
    if is_vault_path(&dest_dir) {
        result.push_error(
            "Cannot export vault items into the Secure Album storage folder".to_string(),
        );
        return result;
    }
    let key = match vault_key() {
        Ok(key) => key,
        Err(e) => {
            result.push_error(e);
            return result;
        }
    };
    let conn = match state.cache.conn() {
        Ok(conn) => conn,
        Err(e) => {
            result.push_error(e.to_string());
            return result;
        }
    };
    for id in ids {
        let row = conn.query_row(
            "SELECT encrypted_path, file_name FROM vault_items WHERE id = ?",
            rusqlite::params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        );
        match row {
            Ok((encrypted, file_name)) => {
                let dest = dest_dir.join(file_name);
                match decrypt_file_to_path(Path::new(&encrypted), &dest, &key) {
                    Ok(()) => result.success += 1,
                    Err(e) => result.push_error(e),
                }
            }
            Err(e) => result.push_error(e.to_string()),
        }
    }
    result
}

#[tauri::command]
pub async fn vault_status(state: State<'_, Arc<AppState>>) -> Result<VaultStatus, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_items", [], |row| row.get(0))
            .unwrap_or(0);
        Ok(VaultStatus {
            configured: read_keychain_password().is_some() || key_file_path().exists(),
            unlocked: state_arc.vault.is_unlocked(),
            item_count: count.max(0) as usize,
            auto_lock_minutes: state_arc.vault.auto_lock_minutes(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_create(
    name: String,
    state: State<'_, Arc<AppState>>,
) -> Result<VaultInfo, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(default_vault_dir()).map_err(|e| e.to_string())?;
        state_arc.vault.refresh_canonical_dir();
        let _ = vault_key()?;
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM vault_items", [], |row| row.get(0))
            .unwrap_or(0);
        Ok(VaultInfo {
            name: if name.trim().is_empty() {
                DEFAULT_VAULT.to_string()
            } else {
                name
            },
            item_count: count.max(0) as usize,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_unlock(state: State<'_, Arc<AppState>>) -> Result<bool, String> {
    let ok = crate::commands::secure::authenticate_vault().await?;
    if ok {
        let _ = vault_key()?;
        state.vault.set_unlocked();
    }
    Ok(ok)
}

#[tauri::command]
pub async fn vault_lock(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    state.vault.lock();
    Ok(())
}

#[derive(serde::Serialize)]
pub struct VaultRepairResult {
    pub removed_rows: usize,
    pub removed_files: usize,
}

#[tauri::command]
pub async fn vault_set_auto_lock(
    minutes: u64,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !(1..=120).contains(&minutes) {
        return Err("Auto-lock must be between 1 and 120 minutes".to_string());
    }
    *state.vault.auto_lock_minutes.write() = minutes;
    if state.vault.is_unlocked() {
        state.vault.set_unlocked();
    }
    Ok(())
}

#[tauri::command]
pub async fn vault_repair_catalog(
    state: State<'_, Arc<AppState>>,
) -> Result<VaultRepairResult, String> {
    let state_arc = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        ensure_vault_unlocked(&state_arc)?;
        let conn = state_arc.cache.conn().map_err(|e| e.to_string())?;
        let mut removed_rows = 0usize;
        let mut removed_files = 0usize;

        let mut stmt = conn
            .prepare("SELECT id, encrypted_path FROM vault_items")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        for (id, encrypted_path) in rows {
            if !Path::new(&encrypted_path).exists() {
                conn.execute(
                    "DELETE FROM vault_items WHERE id = ?",
                    rusqlite::params![id],
                )
                .map_err(|e| e.to_string())?;
                removed_rows += 1;
            }
        }

        let known: std::collections::HashSet<String> = conn
            .prepare("SELECT encrypted_path FROM vault_items")
            .map_err(|e| e.to_string())?
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let vault_dir = default_vault_dir();
        if vault_dir.exists() {
            for entry in std::fs::read_dir(&vault_dir)
                .map_err(|e| e.to_string())?
                .flatten()
            {
                let path = entry.path();
                if !path.is_file() {
                    continue;
                }
                let key = path.to_string_lossy().to_string();
                if !known.contains(&key)
                    && path.extension().and_then(|e| e.to_str()) == Some("folio-vault")
                {
                    if std::fs::remove_file(&path).is_ok() {
                        removed_files += 1;
                    }
                }
            }
        }

        state_arc.cache.schedule_flush();
        Ok(VaultRepairResult {
            removed_rows,
            removed_files,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vault_add_files(
    paths: Vec<String>,
    state: State<'_, Arc<AppState>>,
) -> Result<crate::commands::jobs::JobStarted, String> {
    crate::commands::jobs::start_vault_add_job(paths, state.inner().clone())
}

#[tauri::command]
pub async fn vault_export_files(
    ids: Vec<String>,
    destination: String,
    state: State<'_, Arc<AppState>>,
) -> Result<crate::commands::jobs::JobStarted, String> {
    crate::commands::jobs::start_vault_export_job(ids, destination, state.inner().clone())
}

#[cfg(test)]
mod tests {
    use super::{VAULT_CHUNK_SIZE, decrypt_file_to_path, encrypt_file_to_vault};
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    fn test_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("folio_vault_test_{}_{}", std::process::id(), name))
    }

    #[test]
    fn encrypt_decrypt_round_trip() {
        let base = test_dir("small");
        if let Err(e) = std::fs::create_dir_all(&base) {
            panic!("failed to create test dir: {e}");
        }
        let source = base.join("source.txt");
        let encrypted = base.join("item.vault");
        let output = base.join("output.txt");
        let key = [7u8; 32];
        if let Err(e) = std::fs::write(&source, b"secret-data") {
            panic!("failed to write source: {e}");
        }
        if let Err(e) = encrypt_file_to_vault(&source, &encrypted, &key) {
            panic!("encrypt failed: {e}");
        }
        if let Err(e) = decrypt_file_to_path(&encrypted, &output, &key) {
            panic!("decrypt failed: {e}");
        }
        let data = match std::fs::read(&output) {
            Ok(data) => data,
            Err(e) => panic!("read output failed: {e}"),
        };
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(data, b"secret-data");
    }

    #[test]
    fn encrypt_decrypt_multi_chunk_round_trip() {
        let base = test_dir("large");
        if let Err(e) = std::fs::create_dir_all(&base) {
            panic!("failed to create test dir: {e}");
        }
        let source = base.join("source.bin");
        let encrypted = base.join("item.vault");
        let output = base.join("output.bin");
        let key = [11u8; 32];
        let data = vec![42u8; VAULT_CHUNK_SIZE * 2 + 37];
        if let Err(e) = std::fs::write(&source, &data) {
            panic!("failed to write source: {e}");
        }
        if let Err(e) = encrypt_file_to_vault(&source, &encrypted, &key) {
            panic!("encrypt failed: {e}");
        }
        if let Err(e) = decrypt_file_to_path(&encrypted, &output, &key) {
            panic!("decrypt failed: {e}");
        }
        let restored = match std::fs::read(&output) {
            Ok(data) => data,
            Err(e) => panic!("read output failed: {e}"),
        };
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(restored, data);
    }

    #[test]
    fn decrypts_legacy_vault_item() {
        let base = test_dir("legacy");
        if let Err(e) = std::fs::create_dir_all(&base) {
            panic!("failed to create test dir: {e}");
        }
        let encrypted = base.join("legacy.vault");
        let output = base.join("output.txt");
        let key = [13u8; 32];
        let nonce = [5u8; 12];
        let cipher = match Aes256Gcm::new_from_slice(&key) {
            Ok(cipher) => cipher,
            Err(e) => panic!("failed to construct cipher: {e}"),
        };
        let ciphertext = match cipher.encrypt(Nonce::from_slice(&nonce), b"legacy-data".as_ref()) {
            Ok(ciphertext) => ciphertext,
            Err(e) => panic!("failed to encrypt legacy data: {e}"),
        };
        let mut bytes = nonce.to_vec();
        bytes.extend(ciphertext);
        if let Err(e) = std::fs::write(&encrypted, bytes) {
            panic!("failed to write legacy item: {e}");
        }
        if let Err(e) = decrypt_file_to_path(&encrypted, &output, &key) {
            panic!("legacy decrypt failed: {e}");
        }
        let restored = match std::fs::read(&output) {
            Ok(data) => data,
            Err(e) => panic!("read output failed: {e}"),
        };
        let _ = std::fs::remove_dir_all(&base);
        assert_eq!(restored, b"legacy-data");
    }

    #[test]
    fn rejects_vault_item_without_authenticated_terminal() {
        let base = test_dir("truncated");
        if let Err(e) = std::fs::create_dir_all(&base) {
            panic!("failed to create test dir: {e}");
        }
        let source = base.join("source.txt");
        let encrypted = base.join("item.vault");
        let output = base.join("output.txt");
        let key = [17u8; 32];
        if let Err(e) = std::fs::write(&source, b"secret-data") {
            panic!("failed to write source: {e}");
        }
        if let Err(e) = encrypt_file_to_vault(&source, &encrypted, &key) {
            panic!("encrypt failed: {e}");
        }
        let mut bytes = match std::fs::read(&encrypted) {
            Ok(bytes) => bytes,
            Err(e) => panic!("read encrypted item failed: {e}"),
        };
        bytes.truncate(bytes.len() - 32);
        if let Err(e) = std::fs::write(&encrypted, bytes) {
            panic!("failed to truncate encrypted item: {e}");
        }
        assert!(decrypt_file_to_path(&encrypted, &output, &key).is_err());
        assert!(!output.with_extension("vault-export-tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn rejects_vault_item_with_trailing_data() {
        let base = test_dir("trailing");
        if let Err(e) = std::fs::create_dir_all(&base) {
            panic!("failed to create test dir: {e}");
        }
        let source = base.join("source.txt");
        let encrypted = base.join("item.vault");
        let output = base.join("output.txt");
        let key = [19u8; 32];
        if let Err(e) = std::fs::write(&source, b"secret-data") {
            panic!("failed to write source: {e}");
        }
        if let Err(e) = encrypt_file_to_vault(&source, &encrypted, &key) {
            panic!("encrypt failed: {e}");
        }
        let mut bytes = match std::fs::read(&encrypted) {
            Ok(bytes) => bytes,
            Err(e) => panic!("read encrypted item failed: {e}"),
        };
        bytes.push(0);
        if let Err(e) = std::fs::write(&encrypted, bytes) {
            panic!("failed to append encrypted item: {e}");
        }
        assert!(decrypt_file_to_path(&encrypted, &output, &key).is_err());
        assert!(!output.with_extension("vault-export-tmp").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
