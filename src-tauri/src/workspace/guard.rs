use std::path::{Path, PathBuf};

#[derive(Debug)]
pub enum GuardError {
    AccessDenied(String),
    #[allow(dead_code)]
    SymlinkLoop(String),
    NotFound(String),
}

// 简单的错误类型，无需引入 thiserror crate
impl std::fmt::Display for GuardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AccessDenied(msg) => write!(f, "访问受限: {msg}"),
            Self::SymlinkLoop(msg) => write!(f, "检测到符号链接环路: {msg}"),
            Self::NotFound(msg) => write!(f, "路径不存在: {msg}"),
        }
    }
}

impl std::error::Error for GuardError {}

/// 规范化路径并验证其在允许的根目录内部
pub fn validate_under_root(root: &Path, target: &Path) -> Result<PathBuf, GuardError> {
    if !target.is_absolute()
        || target
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(GuardError::AccessDenied("拒绝相对路径或父目录跳转".into()));
    }
    // Refuse links/reparse points in every existing component, including dangling links.
    let mut ancestor = std::path::PathBuf::new();
    for component in target.components() {
        ancestor.push(component);
        if let Ok(meta) = std::fs::symlink_metadata(&ancestor) {
            let mut link = meta.file_type().is_symlink();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                link |= meta.file_attributes() & 0x400 != 0;
            }
            if link {
                return Err(GuardError::AccessDenied(
                    "暂不允许工作区符号链接或目录联接".into(),
                ));
            }
        }
    }
    // 规范化 root
    let canonical_root = root
        .canonicalize()
        .map_err(|e| GuardError::NotFound(format!("{}: {}", root.display(), e)))?;

    // 如果 target 不存在，获取其父目录做校验
    let canonical_target = if target.exists() {
        target
            .canonicalize()
            .map_err(|e| GuardError::NotFound(format!("{}: {}", target.display(), e)))?
    } else {
        let parent = target
            .parent()
            .ok_or_else(|| GuardError::AccessDenied("无效的目标路径".into()))?;
        if !parent.exists() {
            return Err(GuardError::NotFound(format!(
                "父目录不存在: {}",
                parent.display()
            )));
        }
        let canonical_parent = parent
            .canonicalize()
            .map_err(|e| GuardError::NotFound(format!("{}: {}", parent.display(), e)))?;
        let file_name = target
            .file_name()
            .ok_or_else(|| GuardError::AccessDenied("无效的文件名".into()))?;
        canonical_parent.join(file_name)
    };

    // 检查 target 是否以 root 为前缀
    if !canonical_target.starts_with(&canonical_root) {
        return Err(GuardError::AccessDenied(format!(
            "路径 {} 超出工作区范围 {}",
            canonical_target.display(),
            canonical_root.display()
        )));
    }

    Ok(canonical_target)
}

pub fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return Err("名称必须是单个有效文件名，不能包含路径、备用数据流或通配符".into());
    }
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    if ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    {
        return Err("名称是 Windows 保留设备名".into());
    }
    Ok(())
}

/// 计算相对路径（以正斜杠分隔，保证跨平台统一）
pub fn relative_slash_path(root: &Path, target: &Path) -> String {
    let rel = match target.strip_prefix(root) {
        Ok(p) => p,
        Err(_) => target,
    };
    rel.to_string_lossy().replace('\\', "/")
}
