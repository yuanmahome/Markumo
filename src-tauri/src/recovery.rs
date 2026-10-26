//! Bounded, atomic recovery snapshots for unsaved text documents.
//!
//! Snapshots live only under the application data directory. Each file is a
//! self-contained JSON record with its own checksum, so a crash can leave at
//! worst an unreadable temporary file; a half-written record is never accepted
//! as valid. User paths are metadata only and are never used as storage names.
use crate::files::{atomic, disk_version, version_of};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_RECORDS: usize = 64;
pub const MAX_TEXT: usize = 8 * 1024 * 1024;
pub const MAX_TOTAL: u64 = 64 * 1024 * 1024;
const MAX_FILE: usize = MAX_TEXT + 1024 * 1024;
const MAX_NAME: usize = 512;
const MAX_PATH: usize = 16384;
const MAX_PANES: usize = 8;
const SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryPane {
    pub pane: String,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(deserialize_with = "bounded_text")]
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub panes: Vec<RecoveryPane>,
    #[serde(default)]
    pub disk_version: Option<String>,
    /// Version of the snapshot file this caller last observed. When present the
    /// write is a compare-and-swap: a concurrent change is never overwritten,
    /// it is preserved under a fresh snapshot id instead.
    #[serde(default)]
    pub expected_version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecoveryRecord {
    pub schema_version: u8,
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub text: String,
    pub encoding: String,
    pub bom: bool,
    pub eol: String,
    pub mode: Option<String>,
    #[serde(default)]
    pub panes: Vec<RecoveryPane>,
    pub disk_version: Option<String>,
    pub disk_size: Option<u64>,
    pub disk_modified_ns: Option<u64>,
    pub char_count: usize,
    pub updated_at: u64,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySummary {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub updated_at: u64,
    pub char_count: usize,
    pub size_bytes: u64,
    pub mode: Option<String>,
    pub panes: Vec<RecoveryPane>,
    pub disk_exists: bool,
    pub disk_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryList {
    pub records: Vec<RecoverySummary>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoverySaveResult {
    pub record: RecoverySummary,
    pub warnings: Vec<String>,
    /// Version of the snapshot as just written. The next update must send this
    /// back as `expectedVersion`.
    pub version: String,
}

/// A snapshot body plus the version of the exact bytes that were read. The
/// version is not stored in the JSON: it describes the file, not the record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryRead {
    #[serde(flatten)]
    pub record: RecoveryRecord,
    pub version: String,
}

#[derive(Default)]
pub struct RecoveryService {
    dir: Option<PathBuf>,
    limits: Limits,
    /// Serializes every operation that mutates the snapshot directory. The
    /// Tauri store already has an outer mutex, but the service must also be safe
    /// when used directly (tests, future callers) and `list` must not prune a
    /// record while another thread is writing it.
    sync: Mutex<()>,
}

#[derive(Clone, Copy)]
struct Limits {
    records: usize,
    total: u64,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            records: MAX_RECORDS,
            total: MAX_TOTAL,
        }
    }
}
pub type RecoveryStore = Mutex<RecoveryService>;

enum LoadError {
    Io(String),
    Corrupt(String),
}

impl RecoveryService {
    pub fn configure(&mut self, dir: PathBuf) {
        self.dir = Some(dir);
    }

    fn directory(&self) -> Result<PathBuf, String> {
        let dir = self.dir.as_ref().ok_or("恢复存储尚未初始化")?;
        fs::create_dir_all(dir).map_err(|e| format!("创建恢复目录失败: {e}"))?;
        restrict(dir, true);
        Ok(dir.clone())
    }

    fn transaction(&self) -> Result<fs::File, String> {
        let path = self.directory()?.join(".recovery.lock");
        if fs::symlink_metadata(&path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
            return Err("恢复存储锁不是普通文件".into());
        }
        let lock = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(&path).map_err(|e| format!("打开恢复存储锁失败：{e}"))?;
        restrict(&path, false);
        lock.lock().map_err(|e| format!("锁定恢复存储失败：{e}"))?;
        Ok(lock)
    }

    pub fn list(&self) -> Result<RecoveryList, String> {
        // Hold the mutation lock only for pruning and reading records. The
        // summaries below probe the user's original paths, which can be slow
        // (for example a network file) and must not block a snapshot save.
        let (mut entries, warnings) = {
            let _guard = self.lock();
            let _transaction = self.transaction()?;
            let dir = self.directory()?;
            let mut warnings = self.prune_files()?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(&dir).map_err(|e| format!("读取恢复目录失败: {e}"))? {
                let entry = entry.map_err(|e| e.to_string())?;
                if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                    continue;
                }
                let path = entry.path();
                if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                if validate_id(stem).is_err() {
                    continue;
                }
                match read_record(&path, stem, self.limits.records) {
                    Ok((record, _version)) => {
                        let size = entry.metadata().map_err(|e| e.to_string())?.len();
                        entries.push((record, path, size));
                    }
                    Err(LoadError::Corrupt(reason)) => {
                        let quarantined = quarantine(&path, stem);
                        warnings.push(if quarantined {
                            format!("恢复快照 {stem} 损坏，已隔离：{reason}")
                        } else {
                            format!("恢复快照 {stem} 损坏，无法隔离：{reason}")
                        });
                    }
                    Err(LoadError::Io(reason)) => {
                        warnings.push(format!("恢复快照 {stem} 暂时无法读取：{reason}"));
                    }
                }
            }
            (entries, warnings)
        };
        entries.sort_by_key(|(record, _, _)| std::cmp::Reverse(record.updated_at));
        let records = entries
            .iter()
            .map(|(record, _, size)| summary(record, *size))
            .collect();
        Ok(RecoveryList { records, warnings })
    }

    pub fn read(&self, id: &str) -> Result<RecoveryRead, String> {
        validate_id(id)?;
        let _guard = self.lock();
        let _transaction = self.transaction()?;
        let path = self.directory()?.join(format!("{id}.json"));
        match read_record(&path, id, self.limits.records) {
            Ok((record, version)) => Ok(RecoveryRead { record, version }),
            Err(LoadError::Io(reason)) => Err(format!("读取恢复快照失败：{reason}")),
            Err(LoadError::Corrupt(reason)) => {
                let _ = quarantine(&path, id);
                Err(format!("恢复快照无效，已隔离：{reason}"))
            }
        }
    }

    pub fn save(&self, input: RecoveryInput) -> Result<RecoverySaveResult, String> {
        let name = valid_name(&input.name)?;
        let path = input.path.as_deref().map(valid_path).transpose()?;
        let encoding = valid_encoding(&input.encoding)?;
        let eol = valid_eol(&input.eol)?;
        let mode = input.mode.as_deref().map(valid_mode).transpose()?;
        let panes = valid_panes(input.panes)?;
        if input.text.len() > MAX_TEXT {
            return Err(format!(
                "单个恢复快照超过 {} MiB；当前内容未获得崩溃恢复保护",
                MAX_TEXT / (1024 * 1024)
            ));
        }
        let requested_id = match input.id.as_deref() {
            Some(id) => {
                validate_id(id)?;
                Some(id.to_owned())
            }
            None => None,
        };
        let expected_version = match input.expected_version.as_deref() {
            Some(version) => {
                valid_version(version)?;
                Some(version.to_owned())
            }
            None => None,
        };
        let (disk_size, disk_modified_ns) = path
            .as_deref()
            .and_then(disk_stat)
            .map_or((None, None), |(size, modified)| {
                (Some(size), Some(modified))
            });
        let updated_at = now_ms();
        let checksum = checksum(&input.text);
        let mut record = RecoveryRecord {
            schema_version: SCHEMA_VERSION,
            id: requested_id.clone().unwrap_or_default(),
            name,
            path,
            text: input.text,
            encoding,
            bom: input.bom,
            eol,
            mode,
            panes,
            disk_version: input.disk_version.filter(|value| value.len() <= 256),
            disk_size,
            disk_modified_ns,
            char_count: 0,
            updated_at,
            checksum,
        };
        record = with_derived(&record)?;
        // Serialize saves, deletes and pruning. Without this, a list()-driven
        // prune could remove a record between its version read and replacement.
        let _guard = self.lock();
        let _transaction = self.transaction()?;
        let dir = self.directory()?;
        let (target, bytes, warnings) = if let Some(id) = requested_id {
            record.id = id.clone();
            let target = dir.join(format!("{id}.json"));
            let bytes = encode_record(&record)?;
            if bytes.len() as u64 > self.limits.total {
                return Err("恢复快照超过存储预算，未写入；已有快照保持不变".into());
            }
            // Conditional update: use the caller's compare-and-swap version when
            // it has one, otherwise read the actual on-disk version. Both paths
            // are conditional; `write_checked` re-verifies it again immediately
            // before the atomic replacement.
            let expected = match expected_version {
                Some(version) => Some(version),
                None => disk_version(&target).map_err(|error| error.message)?,
            };
            match atomic::write_checked(&target, &bytes, expected.as_deref()) {
                Ok(()) => {
                    let warnings = self.prune_after_write(bytes.len() as u64, &id);
                    (target, bytes, warnings)
                }
                Err(error) if error.code == "conflict" => {
                    // Never replace a snapshot another process changed or
                    // deleted. Keep the current dirty content protected by
                    // writing it under a fresh id instead of silently winning.
                    self.write_new_snapshot(&dir, &mut record)?
                }
                Err(error) => return Err(error.message),
            }
        } else {
            self.write_new_snapshot(&dir, &mut record)?
        };
        restrict(&target, false);
        let version = written_version(&target, &bytes)?;
        let size = fs::metadata(&target)
            .map_err(|e| format!("读取恢复快照大小失败: {e}"))?
            .len();
        // Summary probing of the user's original path can be slow; do it after
        // releasing the snapshot mutation lock.
        drop(_transaction);
        drop(_guard);
        Ok(RecoverySaveResult {
            record: summary(&record, size),
            warnings,
            version,
        })
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        validate_id(id)?;
        let _guard = self.lock();
        let _transaction = self.transaction()?;
        let path = self.directory()?.join(format!("{id}.json"));
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("删除恢复快照失败: {error}")),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ()> {
        // A panic in one save must not brick crash recovery for the session.
        self.sync
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Allocate a brand-new snapshot id. Creation stays an atomic `expected
    /// None` write, so a file appearing concurrently is never overwritten.
    fn write_new_snapshot(
        &self,
        dir: &Path,
        record: &mut RecoveryRecord,
    ) -> Result<(PathBuf, Vec<u8>, Vec<String>), String> {
        for attempt in 0..3 {
            let id = random_id()?;
            record.id = id.clone();
            let target = dir.join(format!("{id}.json"));
            let bytes = encode_record(record)?;
            if bytes.len() as u64 > self.limits.total {
                return Err("恢复快照超过存储预算，未写入；已有快照保持不变".into());
            }
            match atomic::write_checked(&target, &bytes, None) {
                Ok(()) => {
                    let warnings = self.prune_after_write(bytes.len() as u64, &id);
                    return Ok((target, bytes, warnings));
                }
                Err(error) if error.code == "conflict" && attempt < 2 => continue,
                Err(error) => return Err(error.message),
            }
        }
        Err("恢复快照标识冲突，未能写入；当前内容仍保留在编辑器中".into())
    }

    /// Enforce the limits after a successful write. The new record is excluded
    /// from eviction, so a budget prune can never remove the snapshot that was
    /// just made durable. A prune failure is reported as a warning, never as a
    /// failed save, because the new snapshot already exists.
    fn prune_after_write(&self, incoming: u64, keep: &str) -> Vec<String> {
        match self.prune_to_fit(incoming, Some(keep)) {
            Ok(warnings) => warnings,
            Err(error) => vec![format!("恢复快照已写入，但清理超限旧记录失败：{error}")],
        }
    }

    /// Remove the oldest snapshots until `incoming` fits both limits. The file
    /// being replaced/kept is excluded from eviction. If the new record alone
    /// exceeds the space budget nothing is deleted.
    fn prune_to_fit(&self, incoming: u64, keep: Option<&str>) -> Result<Vec<String>, String> {
        if incoming > self.limits.total {
            return Err("恢复快照超过存储预算，未写入；已有快照保持不变".into());
        }
        let dir = self.directory()?;
        let mut others: Vec<(String, PathBuf, u64, u64)> = Vec::new();
        let mut total: u64 = 0;
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().and_then(|ext| ext.to_str()) != Some("json")
                || validate_id(stem).is_err()
            {
                continue;
            }
            if keep == Some(stem) {
                continue;
            }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            total = total.saturating_add(metadata.len());
            others.push((
                stem.to_owned(),
                path,
                metadata.len(),
                file_mtime_ns(&metadata),
            ));
        }
        others.sort_by_key(|(_, _, _, modified)| *modified);
        let mut count = others.len() + 1;
        let mut warnings = Vec::new();
        while count > self.limits.records || total.saturating_add(incoming) > self.limits.total {
            let Some((id, path, size, _)) = others.first().cloned() else {
                return Err(
                    "恢复快照超过数量/空间上限且没有可清理的旧记录，未写入；已有快照保持不变"
                        .into(),
                );
            };
            match fs::remove_file(&path) {
                Ok(()) => {
                    total = total.saturating_sub(size);
                    count -= 1;
                    others.remove(0);
                    warnings.push(format!("恢复快照数量或空间超限，已清理最旧记录 {id}"));
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    total = total.saturating_sub(size);
                    count -= 1;
                    others.remove(0);
                }
                Err(error) => {
                    return Err(format!(
                        "恢复快照超过数量/空间上限，且清理最旧记录失败: {error}"
                    ))
                }
            }
        }
        Ok(warnings)
    }

    /// Enforce count/space limits from metadata only. Startup must not parse
    /// every body merely to decide which old snapshot to remove.
    fn prune_files(&self) -> Result<Vec<String>, String> {
        let dir = self.directory()?;
        let mut entries = Vec::new();
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            if path.extension().and_then(|ext| ext.to_str()) != Some("json")
                || validate_id(stem).is_err()
            {
                continue;
            }
            let metadata = entry.metadata().map_err(|e| e.to_string())?;
            entries.push((
                stem.to_owned(),
                path,
                metadata.len(),
                file_mtime_ns(&metadata),
            ));
        }
        entries.sort_by_key(|(_, _, _, modified)| *modified);
        let mut total: u64 = entries.iter().map(|(_, _, size, _)| *size).sum();
        let mut warnings = Vec::new();
        while entries.len() > self.limits.records || total > self.limits.total {
            let Some((id, path, size, _)) = entries.first().cloned() else {
                break;
            };
            match fs::remove_file(&path) {
                Ok(()) => {
                    total = total.saturating_sub(size);
                    entries.remove(0);
                    warnings.push(format!("恢复快照数量或空间超限，已清理最旧记录 {id}"));
                }
                Err(error) => {
                    return Err(format!(
                        "恢复快照超过数量/空间上限，且清理最旧记录失败: {error}"
                    ))
                }
            }
        }
        Ok(warnings)
    }
}

fn with_derived(record: &RecoveryRecord) -> Result<RecoveryRecord, String> {
    let mut record = record.clone();
    record.char_count = record.text.chars().count();
    record.checksum = checksum(&record.text);
    Ok(record)
}

fn summary(record: &RecoveryRecord, size_bytes: u64) -> RecoverySummary {
    let (disk_exists, disk_changed) = match record.path.as_deref() {
        Some(path) => disk_state(path, record.disk_size, record.disk_modified_ns),
        None => (false, false),
    };
    RecoverySummary {
        id: record.id.clone(),
        name: record.name.clone(),
        path: record.path.clone(),
        updated_at: record.updated_at,
        char_count: record.char_count,
        size_bytes,
        mode: record.mode.clone(),
        panes: record.panes.clone(),
        disk_exists,
        disk_changed,
    }
}

fn disk_state(path: &str, size: Option<u64>, modified: Option<u64>) -> (bool, bool) {
    if remote_path(path) {
        return (false, true);
    }
    match fs::metadata(Path::new(path)) {
        Ok(metadata) if metadata.is_file() => (
            true,
            Some(metadata.len()) != size || modified_ns(&metadata) != modified,
        ),
        Ok(_) => (false, true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (false, true),
        Err(_) => (false, true),
    }
}

fn disk_stat(path: &str) -> Option<(u64, u64)> {
    if remote_path(path) {
        return None;
    }
    let metadata = fs::metadata(Path::new(path)).ok()?;
    if !metadata.is_file() {
        return None;
    }
    Some((metadata.len(), modified_ns(&metadata)?))
}

/// Never make a network/device metadata request from a startup list. A
/// tampered recovery record must not be able to trigger UNC authentication.
/// Rust canonicalizes local Windows paths to the verbatim form `\\?\C:\...`;
/// that prefix is local and must not be confused with a UNC share. Verbatim
/// UNC paths (`\\?\UNC\server\share`) remain remote.
fn remote_path(path: &str) -> bool {
    let path = path
        .strip_prefix(r"\\?\")
        .or_else(|| path.strip_prefix("//?/"))
        .unwrap_or(path);
    if path.starts_with(r"UNC\") || path.starts_with("UNC/") {
        return true;
    }
    // Device namespaces can block or require privileged access; a recovery
    // record must never make startup probe them.
    if path.starts_with(r"GLOBALROOT\")
        || path.starts_with("GLOBALROOT/")
        || path.starts_with(r"PIPE\")
        || path.starts_with("PIPE/")
    {
        return true;
    }
    path.starts_with("\\\\") || path.starts_with("//")
}

fn modified_ns(metadata: &fs::Metadata) -> Option<u64> {
    let duration = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    Some(duration.as_nanos().min(u64::MAX as u128) as u64)
}

fn file_mtime_ns(metadata: &fs::Metadata) -> u64 {
    modified_ns(metadata).unwrap_or(0)
}

fn encode_record(record: &RecoveryRecord) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(record).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FILE {
        return Err("恢复快照编码后超过大小上限，未写入".into());
    }
    Ok(bytes)
}

/// Build the same version string the file service uses for conditional writes.
/// It is derived from the bytes we just wrote plus the target metadata, so a
/// successful save does not need to read the whole snapshot back.
fn written_version(path: &Path, bytes: &[u8]) -> Result<String, String> {
    let modified = fs::metadata(path)
        .map_err(|e| format!("读取恢复快照状态失败: {e}"))?
        .modified()
        .ok();
    Ok(version_of(bytes, modified))
}

fn valid_version(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version.len() > 256
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b':')
    {
        return Err("恢复快照版本无效".into());
    }
    Ok(())
}

fn read_record(
    path: &Path,
    expected_id: &str,
    _max_records: usize,
) -> Result<(RecoveryRecord, String), LoadError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(LoadError::Io("文件不存在".into()))
        }
        Err(error) => return Err(LoadError::Io(error.to_string())),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > MAX_FILE as u64
    {
        return Err(LoadError::Corrupt("大小超限、链接或不是普通文件".into()));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_FILE as u64 + 1).read_to_end(&mut bytes))
        .map_err(|error| LoadError::Io(error.to_string()))?;
    if bytes.len() > MAX_FILE {
        return Err(LoadError::Corrupt("文件超过上限".into()));
    }
    let record: RecoveryRecord = serde_json::from_slice(&bytes)
        .map_err(|error| LoadError::Corrupt(format!("JSON 无效: {error}")))?;
    validate_record(&record, expected_id).map_err(LoadError::Corrupt)?;
    let version = version_of(&bytes, metadata.modified().ok());
    Ok((record, version))
}

fn validate_record(record: &RecoveryRecord, expected_id: &str) -> Result<(), String> {
    if record.schema_version != SCHEMA_VERSION
        || record.id != expected_id
        || validate_id(&record.id).is_err()
    {
        return Err("版本或标识无效".into());
    }
    if record.text.len() > MAX_TEXT || record.checksum != checksum(&record.text) {
        return Err("正文超限或校验失败".into());
    }
    if record.char_count != record.text.chars().count() {
        return Err("字符计数不一致".into());
    }
    valid_name(&record.name)?;
    if let Some(path) = &record.path {
        valid_path(path)?;
    }
    valid_encoding(&record.encoding)?;
    valid_eol(&record.eol)?;
    if let Some(mode) = &record.mode {
        valid_mode(mode)?;
    }
    valid_panes(record.panes.clone())?;
    Ok(())
}

fn checksum(text: &str) -> String {
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn bounded_text<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    let text = String::deserialize(deserializer)?;
    if text.len() > MAX_TEXT {
        return Err(serde::de::Error::custom("恢复正文超过 8 MiB"));
    }
    Ok(text)
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("生成恢复标识失败: {e}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err("恢复标识无效".into())
    }
}

fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > MAX_NAME
        || name
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '/' | '\\'))
    {
        return Err("恢复文档名无效".into());
    }
    Ok(name.to_owned())
}

fn valid_path(path: &str) -> Result<String, String> {
    let target = Path::new(path);
    if path.len() > MAX_PATH
        || path.contains('\0')
        || !target.is_absolute()
        || target.file_name().is_none()
        || target
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("恢复快照中的原文件路径无效".into());
    }
    Ok(path.to_owned())
}

fn valid_encoding(encoding: &str) -> Result<String, String> {
    if ["UTF-8", "UTF-16LE", "UTF-16BE", "GB18030", "windows-1252"].contains(&encoding) {
        Ok(encoding.to_owned())
    } else {
        Err("恢复快照编码无效".into())
    }
}

fn valid_eol(eol: &str) -> Result<String, String> {
    if ["LF", "CRLF", "CR", "Mixed"].contains(&eol) {
        Ok(eol.to_owned())
    } else {
        Err("恢复快照换行类型无效".into())
    }
}

fn valid_mode(mode: &str) -> Result<String, String> {
    if ["live", "source", "split"].contains(&mode) {
        Ok(mode.to_owned())
    } else {
        Err("恢复快照 Markdown 模式无效".into())
    }
}

fn valid_panes(panes: Vec<RecoveryPane>) -> Result<Vec<RecoveryPane>, String> {
    if panes.len() > MAX_PANES {
        return Err("恢复快照分栏数量过多".into());
    }
    let mut seen = std::collections::HashSet::new();
    let mut result = Vec::new();
    for pane in panes {
        if pane.pane.is_empty()
            || pane.pane.len() > 128
            || pane.pane.chars().any(char::is_control)
            || !seen.insert(pane.pane.clone())
        {
            return Err("恢复快照分栏标识无效".into());
        }
        if let Some(mode) = &pane.mode {
            valid_mode(mode)?;
        }
        result.push(pane);
    }
    Ok(result)
}

fn quarantine(path: &Path, id: &str) -> bool {
    let stamp = now_ms();
    let target = path.with_file_name(format!("{id}.corrupt-{stamp}"));
    fs::rename(path, target).is_ok()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

fn restrict(path: &Path, directory: bool) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if directory { 0o700 } else { 0o600 };
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    let _ = (path, directory);
}
