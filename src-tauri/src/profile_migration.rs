use std::{
    fs,
    io::{self, Write},
    path::Path,
};

const MARKER: &str = ".markumo-profile-migrated-v1";
const PREFERENCES: &[&str] = &[
    "editor-settings.json",
    "files.json",
    "workspaces.json",
    "last-session.json",
];

/// Only the standard application/development profiles have a legacy location.
/// Custom profiles and test instances must never read another profile's data.
pub fn migrate(current: &Path) -> io::Result<()> {
    let legacy_name = match current.file_name().and_then(|name| name.to_str()) {
        Some("com.markumo.app") => "com.lightedit.app",
        Some(".markumo-dev") => ".lightedit-dev",
        _ => return Ok(()),
    };
    if current.join(MARKER).try_exists()? {
        return Ok(());
    }
    let legacy = current.with_file_name(legacy_name);
    match fs::symlink_metadata(&legacy) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => return Ok(()),
        Ok(_) => (),
    }
    fs::create_dir_all(current)?;
    for name in PREFERENCES {
        let destination = current.join(name);
        if destination.try_exists()? {
            continue;
        }
        let source = legacy.join(name);
        let metadata = match fs::symlink_metadata(&source) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            result => result?,
        };
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(io::Error::other(format!(
                "旧偏好不是普通文件：{}",
                source.display()
            )));
        }
        if metadata.len() > 16 * 1024 * 1024 {
            return Err(io::Error::other(format!(
                "旧偏好文件过大，原文件已保留：{}",
                source.display()
            )));
        }
        let mut bytes = fs::read(&source)?;
        if *name == "editor-settings.json" {
            if let Ok(mut value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if value.get("keymapPreset").and_then(|preset| preset.as_str()) == Some("lightedit")
                {
                    value["keymapPreset"] = "markumo".into();
                    bytes = serde_json::to_vec_pretty(&value)?;
                }
            }
        }
        write_new(current, &destination, &bytes)?;
    }
    // Mark only a completed import. Backups stay untouched, and deleting a new
    // preference later must not resurrect stale data from the retired profile.
    write_new(
        current,
        &current.join(MARKER),
        b"Markumo profile migration v1\n",
    )
}

fn write_new(directory: &Path, destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    match temporary.persist_noclobber(destination) {
        Ok(_) => Ok(()),
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.error),
    }
}
