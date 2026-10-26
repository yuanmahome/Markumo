use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use crate::display::display_path;

use super::{
    guard::{relative_slash_path, validate_name, validate_under_root},
    ignore::IgnoreRuleSet,
};

/// Workspace history only stores ten recents and sixteen roots. A file beyond
/// this bound is corrupt or foreign and must not be read into memory at startup.
const MAX_PREFERENCES_BYTES: u64 = 256 * 1024;
const MAX_RECENT_WORKSPACES: usize = 10;
const MAX_ACTIVE_ROOTS: usize = 16;
const MAX_STORED_PATH_BYTES: usize = 32 * 1024;

pub(super) fn rename_without_overwrite(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        // No REPLACE_EXISTING: an external target creation must fail, never overwrite.
        if unsafe { MoveFileExW(source.as_ptr(), target.as_ptr(), 0) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (source, target);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "此平台尚未接入不覆盖目标的安全重命名/移动；原条目保留",
        ))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceNode {
    pub id: String,
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub is_directory: bool,
    pub is_symlink: bool,
    pub is_readonly: bool,
    pub size: u64,
    pub mtime: Option<u64>,
    pub has_children: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub root_path: String,
    pub name: String,
    pub entries: Vec<WorkspaceNode>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct WorkspacePreferences {
    pub recent_workspaces: Vec<String>,
    pub active_roots: Vec<String>,
}

#[derive(Default)]
pub struct WorkspaceService {
    current_root: Option<PathBuf>,
    additional_roots: Vec<PathBuf>,
    storage_path: Option<PathBuf>,
    preferences: WorkspacePreferences,
    pub show_ignored: bool,
}

impl WorkspaceService {
    pub fn disable_persistence(&mut self) {
        self.storage_path = None;
    }
    pub fn configure(&mut self, storage_path: PathBuf) {
        self.storage_path = Some(storage_path.clone());
        let Ok(metadata) = fs::metadata(&storage_path) else {
            return;
        };
        if !metadata.is_file() || metadata.len() > MAX_PREFERENCES_BYTES {
            return;
        }
        let Ok(file) = fs::File::open(&storage_path) else {
            return;
        };
        let mut bytes = Vec::new();
        if file
            .take(MAX_PREFERENCES_BYTES + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() as u64 > MAX_PREFERENCES_BYTES
        {
            return;
        }
        if let Ok(mut prefs) = serde_json::from_slice::<WorkspacePreferences>(&bytes) {
            // Bound externally edited or corrupt history to the same shape this
            // service writes, so the menu and restore loop stay bounded.
            prefs
                .recent_workspaces
                .retain(|path| path.len() <= MAX_STORED_PATH_BYTES);
            prefs.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);
            prefs
                .active_roots
                .retain(|path| path.len() <= MAX_STORED_PATH_BYTES);
            prefs.active_roots.truncate(MAX_ACTIVE_ROOTS);
            self.preferences = prefs;
        }
    }

    pub fn save_preferences(&self) -> Result<(), String> {
        if let Some(storage) = &self.storage_path {
            use std::io::Write;
            let parent = storage.parent().ok_or("无效历史目录")?;
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            let json = serde_json::to_vec_pretty(&self.preferences).map_err(|e| e.to_string())?;
            let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
            file.write_all(&json).map_err(|e| e.to_string())?;
            file.as_file().sync_all().map_err(|e| e.to_string())?;
            file.persist(storage).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn current_root(&self) -> Option<&Path> {
        self.current_root.as_deref()
    }

    pub fn roots(&self) -> Vec<PathBuf> {
        self.current_root
            .iter()
            .chain(self.additional_roots.iter())
            .cloned()
            .collect()
    }

    fn save_active_roots(&mut self) -> Result<(), String> {
        self.preferences.active_roots = self
            .roots()
            .iter()
            .map(|path| display_path(path))
            .collect();
        self.save_preferences()
    }

    pub fn restore_workspaces(&mut self) -> Result<Vec<WorkspaceInfo>, String> {
        let paths = self.preferences.active_roots.clone();
        let mut infos = Vec::new();
        let mut errors = Vec::new();
        for path in paths.into_iter().take(16) {
            match self.add_workspace(PathBuf::from(path)) {
                Ok(info) => infos.push(info),
                Err(error) => errors.push(error),
            }
        }
        if !errors.is_empty() {
            let warning = format!("部分工作区文件夹无法恢复：{}", errors.join("；"));
            if let Some(first) = infos.first_mut() {
                first.warning = Some(warning);
            } else {
                return Err(warning);
            }
        }
        Ok(infos)
    }

    pub fn root_for_path(&self, path: &Path) -> Result<&Path, String> {
        self.current_root
            .iter()
            .chain(self.additional_roots.iter())
            .find(|root| validate_under_root(root, path).is_ok())
            .map(|root| root.as_path())
            .ok_or_else(|| "目标不在已授权工作区内，或路径包含符号链接".into())
    }

    pub fn add_workspace(&mut self, path: PathBuf) -> Result<WorkspaceInfo, String> {
        validate_under_root(&path, &path).map_err(|e| e.to_string())?;
        let root = path.canonicalize().map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("所选路径不是目录".into());
        }
        if self.current_root.is_none() {
            return self.open_workspace(root);
        }
        let roots = self.roots();
        let added = !roots.contains(&root);
        if added {
            if roots.len() >= 16 {
                return Err("最多可加入 16 个工作区文件夹".into());
            }
            if roots
                .iter()
                .any(|existing| root.starts_with(existing) || existing.starts_with(&root))
            {
                return Err(
                    "该目录与已加入的文件夹重叠；请使用已有目录树访问，避免重复搜索".into(),
                );
            }
            self.additional_roots.push(root.clone());
        }
        let entries = match self.read_directory(&root) {
            Ok(entries) => entries,
            Err(error) => {
                if added {
                    self.additional_roots.retain(|item| item != &root);
                }
                return Err(error);
            }
        };
        let root_path = display_path(&root);
        self.preferences
            .recent_workspaces
            .retain(|item| item != &root_path);
        self.preferences
            .recent_workspaces
            .insert(0, root_path.clone());
        self.preferences.recent_workspaces.truncate(10);
        let warning = self.save_active_roots().err();
        Ok(WorkspaceInfo {
            root_path,
            name: root
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            entries,
            warning,
        })
    }

    pub fn remove_workspace(&mut self, path: &Path) -> Result<(), String> {
        let previous = self.roots();
        if self.current_root.as_deref() == Some(path) {
            self.current_root = if self.additional_roots.is_empty() {
                None
            } else {
                Some(self.additional_roots.remove(0))
            };
        } else if self.additional_roots.iter().any(|root| root == path) {
            self.additional_roots.retain(|root| root != path);
        } else {
            return Err("该文件夹不在当前工作区中".into());
        }
        if let Err(error) = self.save_active_roots() {
            self.current_root = previous.first().cloned();
            self.additional_roots = previous.into_iter().skip(1).collect();
            self.preferences.active_roots = self
                .roots()
                .iter()
                .map(|root| display_path(&root))
                .collect();
            return Err(error);
        }
        Ok(())
    }

    pub fn open_workspace(&mut self, root_path: PathBuf) -> Result<WorkspaceInfo, String> {
        validate_under_root(&root_path, &root_path).map_err(|e| e.to_string())?;
        let canonical_root = root_path
            .canonicalize()
            .map_err(|e| format!("无法访问工作区目录: {e}"))?;

        if !canonical_root.is_dir() {
            return Err("所选路径不是一个有效目录".into());
        }

        let name = canonical_root
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".into());

        let root_str = display_path(&canonical_root);

        let previous_roots = std::mem::take(&mut self.additional_roots);
        let previous_root = self.current_root.replace(canonical_root.clone());
        let entries = match self.read_directory_internal(&canonical_root) {
            Ok(entries) => entries,
            Err(error) => {
                self.current_root = previous_root;
                self.additional_roots = previous_roots;
                return Err(error);
            }
        };
        // 记录最近使用
        self.preferences
            .recent_workspaces
            .retain(|p| p != &root_str);
        self.preferences
            .recent_workspaces
            .insert(0, root_str.clone());
        if self.preferences.recent_workspaces.len() > 10 {
            self.preferences.recent_workspaces.truncate(10);
        }
        let warning = self
            .save_active_roots()
            .err()
            .map(|e| format!("工作区已打开，但最近历史保存失败: {e}"));

        Ok(WorkspaceInfo {
            root_path: root_str,
            name,
            entries,
            warning,
        })
    }

    pub fn read_directory(&self, dir_path: &Path) -> Result<Vec<WorkspaceNode>, String> {
        let root = self.root_for_path(dir_path)?;

        let valid_dir =
            validate_under_root(root, dir_path).map_err(|e| format!("非法目录访问: {e}"))?;

        if !valid_dir.is_dir() {
            return Err("目标不是目录".into());
        }

        self.read_directory_internal(&valid_dir)
    }
    pub fn file_visible(&self, path: &Path) -> bool {
        let Ok(root) = self.root_for_path(path) else {
            return false;
        };
        let Ok(target) = validate_under_root(root, path) else {
            return false;
        };
        if !target.is_file() {
            return false;
        }
        let rules = IgnoreRuleSet::new(root, self.show_ignored);
        !target
            .ancestors()
            .take_while(|entry| *entry != root)
            .any(|entry| rules.is_ignored(entry, entry != target))
    }
    pub fn revealed_path(&self, path: &Path) -> Result<PathBuf, String> {
        let root = self.root_for_path(path)?;
        let target = validate_under_root(root, path).map_err(|error| error.to_string())?;
        if !target.exists() {
            return Err("目标不存在。".into());
        }
        Ok(target)
    }

    fn read_directory_internal(&self, dir: &Path) -> Result<Vec<WorkspaceNode>, String> {
        let root = self.root_for_path(dir)?;

        let ignore_rules = IgnoreRuleSet::new(root, self.show_ignored);
        let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;

        let mut nodes = Vec::new();
        let started = std::time::Instant::now();
        let mut visited = 0usize;

        for entry in entries.flatten() {
            visited += 1;
            if visited > 100_000 || nodes.len() >= 50_000 || started.elapsed().as_secs() >= 5 {
                return Err("目录条目过多或读取超时，已停止加载；请打开更小的目录范围。".into());
            }
            let path = entry.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let rel_path = relative_slash_path(root, &path);

            let file_type = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };

            let is_directory = file_type.is_dir();
            let is_symlink = file_type.is_symlink();
            if is_symlink || ignore_rules.is_ignored(&path, is_directory) {
                continue;
            }

            let metadata = entry.metadata().ok();
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata
                    .as_ref()
                    .is_some_and(|m| m.file_attributes() & 0x400 != 0)
                {
                    continue;
                }
            }
            let size = metadata.as_ref().map(|m| m.len()).unwrap_or(0);
            let is_readonly = metadata
                .as_ref()
                .map(|m| m.permissions().readonly())
                .unwrap_or(false);
            let mtime = metadata
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs());

            let mut has_children = false;
            if is_directory {
                if let Ok(mut sub_entries) = fs::read_dir(&path) {
                    has_children = sub_entries.next().is_some();
                }
            }

            nodes.push(WorkspaceNode {
                id: rel_path.clone(),
                name,
                path: display_path(&path),
                relative_path: rel_path,
                is_directory,
                is_symlink,
                is_readonly,
                size,
                mtime,
                has_children,
            });
        }

        // 排序规则：目录在前，其次按名称不区分大小写升序
        nodes.sort_by(|a, b| {
            if a.is_directory != b.is_directory {
                b.is_directory.cmp(&a.is_directory)
            } else {
                a.name.to_lowercase().cmp(&b.name.to_lowercase())
            }
        });

        Ok(nodes)
    }

    pub fn create_file(&self, parent_dir: &Path, file_name: &str) -> Result<WorkspaceNode, String> {
        validate_name(file_name)?;
        let root = self.root_for_path(parent_dir)?;
        let valid_parent = validate_under_root(root, parent_dir).map_err(|e| e.to_string())?;

        let target_path = valid_parent.join(file_name);
        validate_under_root(root, &target_path).map_err(|e| e.to_string())?;

        if target_path.exists() {
            return Err("同名文件已存在".into());
        }

        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target_path)
            .map_err(|e| format!("创建文件失败: {e}"))?;

        let rel_path = relative_slash_path(root, &target_path);
        Ok(WorkspaceNode {
            id: rel_path.clone(),
            name: file_name.to_string(),
            path: display_path(&target_path),
            relative_path: rel_path,
            is_directory: false,
            is_symlink: false,
            is_readonly: false,
            size: 0,
            mtime: Some(
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            ),
            has_children: false,
        })
    }

    pub fn create_directory(
        &self,
        parent_dir: &Path,
        dir_name: &str,
    ) -> Result<WorkspaceNode, String> {
        validate_name(dir_name)?;
        let root = self.root_for_path(parent_dir)?;
        let valid_parent = validate_under_root(root, parent_dir).map_err(|e| e.to_string())?;

        let target_path = valid_parent.join(dir_name);
        validate_under_root(root, &target_path).map_err(|e| e.to_string())?;

        if target_path.exists() {
            return Err("同名目录已存在".into());
        }

        fs::create_dir(&target_path).map_err(|e| format!("创建目录失败: {e}"))?;

        let rel_path = relative_slash_path(root, &target_path);
        Ok(WorkspaceNode {
            id: rel_path.clone(),
            name: dir_name.to_string(),
            path: display_path(&target_path),
            relative_path: rel_path,
            is_directory: true,
            is_symlink: false,
            is_readonly: false,
            size: 0,
            mtime: Some(
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs(),
            ),
            has_children: false,
        })
    }

    pub fn rename_node(&self, old_path: &Path, new_name: &str) -> Result<(String, String), String> {
        validate_name(new_name)?;
        let root = self.root_for_path(old_path)?;
        let valid_old = validate_under_root(root, old_path).map_err(|e| e.to_string())?;

        if valid_old == *root {
            return Err("禁止重命名工作区根目录".into());
        }

        let parent = valid_old.parent().ok_or("无法获取父目录")?;
        let target_path = parent.join(new_name);
        validate_under_root(root, &target_path).map_err(|e| e.to_string())?;

        if target_path.exists() {
            return Err(format!("目标名称 {} 已存在", new_name));
        }

        rename_without_overwrite(&valid_old, &target_path)
            .map_err(|e| format!("重命名失败: {e}"))?;

        let old_rel = relative_slash_path(root, &valid_old);
        let new_rel = relative_slash_path(root, &target_path);

        Ok((old_rel, new_rel))
    }

    pub fn delete_node(&self, target_path: &Path) -> Result<String, String> {
        let root = self.root_for_path(target_path)?;
        let valid_target = validate_under_root(root, target_path).map_err(|e| e.to_string())?;

        if valid_target == *root {
            return Err("禁止删除工作区根目录".into());
        }

        let rel = relative_slash_path(root, &valid_target);

        if valid_target.is_dir() {
            fs::remove_dir_all(&valid_target).map_err(|e| format!("删除目录失败: {e}"))?;
        } else {
            fs::remove_file(&valid_target).map_err(|e| format!("删除文件失败: {e}"))?;
        }

        Ok(rel)
    }

    pub fn move_node(&self, src_path: &Path, dest_dir: &Path) -> Result<(String, String), String> {
        let root = self.root_for_path(src_path)?;
        if self.root_for_path(dest_dir)? != root {
            return Err("暂不支持跨工作区文件夹移动；请在同一文件夹内选择目标".into());
        }
        let valid_src = validate_under_root(root, src_path).map_err(|e| e.to_string())?;
        let valid_dest_dir = validate_under_root(root, dest_dir).map_err(|e| e.to_string())?;
        if valid_src == *root || valid_dest_dir.starts_with(&valid_src) {
            return Err("禁止移动工作区根目录或将目录移动到其自身内部".into());
        }

        if !valid_dest_dir.is_dir() {
            return Err("目标不是目录".into());
        }

        let file_name = valid_src
            .file_name()
            .ok_or("无效的文件名")?
            .to_string_lossy();
        let target_path = valid_dest_dir.join(file_name.as_ref());

        if target_path.exists() {
            return Err("目标位置已存在同名条目".into());
        }

        rename_without_overwrite(&valid_src, &target_path)
            .map_err(|e| format!("移动条目失败: {e}"))?;

        let old_rel = relative_slash_path(root, &valid_src);
        let new_rel = relative_slash_path(root, &target_path);

        Ok((old_rel, new_rel))
    }

    pub fn recent_workspaces(&self) -> Vec<String> {
        self.preferences.recent_workspaces.clone()
    }
}
