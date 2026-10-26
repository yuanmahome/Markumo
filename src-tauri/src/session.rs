use crate::files::{FileService, Layout};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LaunchKind {
    App,
    File,
    /// A window created by detaching a tab. It owns no session and restores no
    /// workspace index: it only adopts the document handed to it.
    Detached,
}
#[derive(Clone)]
pub struct WindowLaunch {
    pub kind: LaunchKind,
    pub paths: Vec<PathBuf>,
    pub pending: Vec<PathBuf>,
}
#[derive(Default)]
pub struct LaunchRegistry {
    pub windows: HashMap<String, WindowLaunch>,
    /// Insertion order so "the most recent single-file window" is well defined.
    pub order: Vec<String>,
    pub next: u64,
}
impl LaunchRegistry {
    pub fn insert(&mut self, label: String, paths: Vec<PathBuf>) {
        let kind = if paths.is_empty() {
            LaunchKind::App
        } else {
            LaunchKind::File
        };
        self.insert_kind(label, kind, paths)
    }
    /// Registers a window that only adopts a detached document: it never owns
    /// the session and never restores a workspace.
    pub fn insert_detached(&mut self, label: String) {
        self.insert_kind(label, LaunchKind::Detached, Vec::new())
    }
    fn insert_kind(&mut self, label: String, kind: LaunchKind, paths: Vec<PathBuf>) {
        if !self.windows.contains_key(&label) {
            self.order.push(label.clone());
        }
        self.windows.insert(
            label,
            WindowLaunch {
                kind,
                paths,
                pending: Vec::new(),
            },
        );
    }
    pub fn owner(&self) -> Option<String> {
        self.windows
            .iter()
            .find(|(_, w)| w.kind == LaunchKind::App)
            .map(|(label, _)| label.clone())
    }
    pub fn window_for(&self, key: &PathKey) -> Option<String> {
        self.windows
            .iter()
            .find(|(_, window)| {
                window
                    .paths
                    .iter()
                    .chain(window.pending.iter())
                    .any(|path| &PathKey::of(path) == key)
            })
            .map(|(label, _)| label.clone())
    }
    /// Most recently created single-file window, reused for further external
    /// opens instead of spawning one window per double-click.
    pub fn latest_file_window(&self) -> Option<String> {
        self.order
            .iter()
            .rev()
            .find(|label| {
                self.windows
                    .get(*label)
                    .is_some_and(|window| window.kind == LaunchKind::File)
            })
            .cloned()
    }
    /// Newest window of any kind, used when no application window exists.
    pub fn latest_window(&self) -> Option<String> {
        self.order
            .iter()
            .rev()
            .find(|label| self.windows.contains_key(*label))
            .cloned()
    }
    pub fn remove(&mut self, label: &str) {
        self.windows.remove(label);
        self.order.retain(|entry| entry != label);
    }
    pub fn next_label(&mut self, kind: LaunchKind) -> String {
        self.next += 1;
        let prefix = match kind {
            LaunchKind::File => "file",
            LaunchKind::Detached => "detached",
            LaunchKind::App => "app",
        };
        format!("{prefix}-{}", self.next)
    }
}
pub type LaunchStore = Mutex<LaunchRegistry>;

/// Maximum number of concurrent Markumo windows.
pub const MAX_WINDOWS: usize = 16;

/// What the caller must do for one external open request.
#[derive(Debug, Default, PartialEq)]
pub struct RoutePlan {
    /// Windows to bring to the front and let their frontend drain the queue.
    pub deliveries: Vec<String>,
    /// Files that are already open in that window. The frontend selects the
    /// existing tab instead of reloading the file or creating another tab.
    pub activate: Vec<(String, Vec<PathBuf>)>,
    /// A new single-file window to build, with its initial files.
    pub created: Option<(String, Vec<PathBuf>)>,
}

/// Pure routing decision for external file requests.
///
/// * `owners[i]` is the window that already has `requested[i]` open (from the
///   file service grants), or `None`.
/// * `window_exists` filters out owners whose window has already been destroyed.
///
/// The whole decision happens while the caller holds the launch lock, so two
/// rapid double-clicks of the same file cannot both decide to create a window.
pub fn plan_external_open(
    registry: &mut LaunchRegistry,
    requested: &[PathBuf],
    owners: &[Option<String>],
    window_exists: &dyn Fn(&str) -> bool,
) -> RoutePlan {
    let mut plan = RoutePlan::default();
    let mut unowned: Vec<PathBuf> = Vec::new();
    for (index, path) in requested.iter().enumerate() {
        let key = PathKey::of(path);
        let owner = owners
            .get(index)
            .cloned()
            .flatten()
            .filter(|label| window_exists(label));
        if let Some(label) = owner {
            // Already open there: activate the tab and never reload the file over
            // unsaved edits, and never queue a duplicate tab.
            match plan
                .activate
                .iter_mut()
                .find(|(existing, _)| *existing == label)
            {
                Some((_, list)) => list.push(path.clone()),
                None => plan.activate.push((label.clone(), vec![path.clone()])),
            }
            if !plan.deliveries.contains(&label) {
                plan.deliveries.push(label);
            }
            continue;
        }
        // A file already queued for a window stays with that window.
        match registry.window_for(&key) {
            Some(label) => {
                if !plan.deliveries.contains(&label) {
                    plan.deliveries.push(label);
                }
            }
            None => unowned.push(path.clone()),
        }
    }
    if !unowned.is_empty() {
        if let Some(label) = registry.latest_file_window() {
            // Reuse the existing single-file window instead of spawning another.
            if let Some(window) = registry.windows.get_mut(&label) {
                for path in &unowned {
                    let key = PathKey::of(path);
                    if !window_knows(window, &key) {
                        window.pending.push(path.clone());
                    }
                }
            }
            if !plan.deliveries.contains(&label) {
                plan.deliveries.push(label);
            }
        } else if registry.windows.len() < MAX_WINDOWS {
            // No single-file window: reserve one now, so a concurrent request for
            // the same file joins this window instead of creating a second one.
            let label = registry.next_label(LaunchKind::File);
            registry.insert(label.clone(), unowned.clone());
            plan.created = Some((label, unowned));
        }
    }
    plan
}

fn window_knows(window: &WindowLaunch, key: &PathKey) -> bool {
    window
        .paths
        .iter()
        .chain(window.pending.iter())
        .any(|path| &PathKey::of(path) == key)
}

/// Comparison key for one file. NTFS is case-insensitive, and the shell may hand
/// us either case or a different alias of the same file, so identity is compared
/// on the canonical path with a case-folded key. Never used for I/O.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct PathKey(String);
impl PathKey {
    pub fn of(path: &Path) -> Self {
        // IPC callers may send either the canonical (`\\?\E:\...`) or the display
        // (`E:\...`) spelling of the same file. Collapse both to one key so an
        // ownership/layout lookup never depends on which form was passed in.
        let text = crate::display::display_text(&path.to_string_lossy());
        if cfg!(windows) {
            PathKey(text.to_lowercase())
        } else {
            PathKey(text)
        }
    }
}

/// Canonical, validated, de-duplicated external open requests.
///
/// Every path goes through the same native check as a user-selected file, so
/// aliases collapse to one entry: relative vs absolute, mixed case, `\\?\`
/// verbatim prefixes, junctions and short names all resolve through
/// `canonicalize`. Paths that are not readable regular files are dropped here
/// (the caller reports the failure through the normal open batch).
pub fn normalize_external_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let mut seen: HashSet<PathKey> = HashSet::new();
    let mut unique = Vec::new();
    for path in paths.into_iter().take(100) {
        let Ok(canonical) = crate::files::checked_path(&path, false) else {
            continue;
        };
        if seen.insert(PathKey::of(&canonical)) {
            unique.push(canonical);
        }
    }
    unique
}

pub fn argument_paths(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<PathBuf> {
    let mut literal = false;
    args.into_iter()
        .skip(1)
        .filter_map(|arg| {
            if arg == "--" && !literal {
                literal = true;
                return None;
            }
            if !literal && arg.starts_with('-') {
                return None;
            }
            let path = PathBuf::from(arg);
            Some(if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            })
        })
        .take(100)
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTab {
    pub path: String,
    pub encoding: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LastSession {
    pub schema_version: u8,
    pub kind: String,
    pub roots: Vec<String>,
    pub tabs: Vec<SessionTab>,
    pub active_path: Option<String>,
    pub layout: Layout,
    #[serde(default)]
    pub editor_layout: Option<serde_json::Value>,
}
impl LastSession {
    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1
            || !["single", "workspace"].contains(&self.kind.as_str())
            || self.tabs.len() > 100
            || self.roots.len() > 16
            || !(190..=420).contains(&self.layout.sidebar_width)
            || !["single", "workspace"].contains(&self.layout.mode.as_str())
        {
            return Err("会话版本或布局参数无效".into());
        }
        if self.kind == "single" && !self.roots.is_empty() {
            return Err("单文件会话不能包含工作区根目录".into());
        }
        for path in self
            .roots
            .iter()
            .chain(self.tabs.iter().map(|tab| &tab.path))
        {
            let p = Path::new(path);
            if path.len() > 16384
                || !p.is_absolute()
                || p.components()
                    .any(|c| matches!(c, std::path::Component::ParentDir))
            {
                return Err("会话包含无效路径".into());
            }
        }
        if self.tabs.iter().any(|t| {
            ![
                "UTF-8",
                "UTF-16LE",
                "UTF-16BE",
                "GB18030",
                "windows-1252",
                "Hex",
                "ClassInfo",
                "Media",
            ]
            .contains(&t.encoding.as_str())
        }) {
            return Err("会话编码无效".into());
        }
        let mut unique = std::collections::HashSet::new();
        if self.tabs.iter().any(|t| !unique.insert(&t.path))
            || self
                .active_path
                .as_ref()
                .is_some_and(|p| !unique.contains(p))
        {
            return Err("会话标签或活动标签无效".into());
        }
        if let Some(editor) = &self.editor_layout {
            // Layout ids are stored in display form, so the comparison set uses
            // the same spelling as the tab paths written to the session file.
            let display: std::collections::HashSet<String> = unique
                .iter()
                .map(|path| crate::display::display_text(path))
                .collect();
            validate_editor_layout(editor, &display)?;
        }
        Ok(())
    }
}
fn validate_editor_layout(
    layout: &serde_json::Value,
    paths: &std::collections::HashSet<String>,
) -> Result<(), String> {
    fn node(
        raw: &serde_json::Value,
        paths: &std::collections::HashSet<String>,
        ids: &mut std::collections::HashSet<String>,
        depth: usize,
    ) -> Result<(), String> {
        if depth > 8 || ids.len() >= 63 {
            return Err("分栏布局超出限制".into());
        }
        let id = raw["id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .ok_or("分栏标识无效")?;
        if !ids.insert(id.into()) {
            return Err("分栏标识重复".into());
        }
        let allowed = match raw["type"].as_str() {
            Some("split") => {
                if ![Some("horizontal"), Some("vertical")].contains(&raw["orientation"].as_str())
                    || raw["ratio"]
                        .as_f64()
                        .is_none_or(|ratio| !(0.05..=0.95).contains(&ratio))
                {
                    return Err("分栏比例无效".into());
                }
                node(&raw["first"], paths, ids, depth + 1)?;
                node(&raw["second"], paths, ids, depth + 1)?;
                vec!["type", "id", "orientation", "ratio", "first", "second"]
            }
            Some("leaf") => {
                let tabs = raw["tabs"]
                    .as_array()
                    .filter(|tabs| tabs.len() <= 100)
                    .ok_or("分栏标签无效")?;
                for tab in tabs {
                    if tab["documentId"]
                        .as_str()
                        .is_none_or(|path| !paths.contains(path))
                        || !tab["pinned"].is_boolean()
                        || tab.as_object().is_none_or(|obj| {
                            obj.keys()
                                .any(|key| !["documentId", "pinned"].contains(&key.as_str()))
                        })
                    {
                        return Err("分栏文件无效".into());
                    }
                }
                if !raw["activeId"].is_null()
                    && !tabs.iter().any(|tab| tab["documentId"] == raw["activeId"])
                {
                    return Err("分栏活动标签无效".into());
                }
                vec!["type", "id", "tabs", "activeId"]
            }
            _ => return Err("分栏类型无效".into()),
        };
        if raw
            .as_object()
            .is_none_or(|object| object.keys().any(|key| !allowed.contains(&key.as_str())))
        {
            return Err("分栏字段无效".into());
        }
        Ok(())
    }
    if serde_json::to_vec(layout).map_err(|e| e.to_string())?.len() > 128 * 1024 {
        return Err("分栏布局过大".into());
    }
    let mut ids = std::collections::HashSet::new();
    node(&layout["root"], paths, &mut ids, 0)?;
    if layout["activePane"]
        .as_str()
        .is_none_or(|pane| !ids.contains(pane))
        || (!layout["maximizedPane"].is_null()
            && layout["maximizedPane"]
                .as_str()
                .is_none_or(|pane| !ids.contains(pane)))
    {
        return Err("活动分栏无效".into());
    }
    if layout.as_object().is_none_or(|object| {
        object
            .keys()
            .any(|key| !["root", "activePane", "maximizedPane", "modes"].contains(&key.as_str()))
    }) {
        return Err("分栏元数据字段无效".into());
    }
    if let Some(modes) = layout.get("modes") {
        for (pane, values) in modes.as_object().ok_or("编辑模式无效")? {
            if !ids.contains(pane) {
                return Err("编辑模式分栏无效".into());
            }
            for (path, mode) in values.as_object().ok_or("编辑模式无效")? {
                if !paths.iter().any(|p| p.as_str() == path)
                    || ![Some("live"), Some("source"), Some("split")].contains(&mode.as_str())
                {
                    return Err("编辑模式无效".into());
                }
            }
        }
    }
    Ok(())
}
#[derive(Default)]
pub struct SessionService {
    path: Option<PathBuf>,
}
impl SessionService {
    pub fn configure(&mut self, path: PathBuf) {
        self.path = Some(path)
    }
    pub fn load(&self) -> Result<Option<LastSession>, String> {
        let path = self.path.as_ref().ok_or("会话存储尚未初始化")?;
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e.to_string()),
        };
        let mut bytes = Vec::new();
        file.take(512 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 512 * 1024 {
            return Err(self.preserve_unreadable(path, "会话文件过大，已跳过恢复"));
        }
        let session: LastSession = match serde_json::from_slice(&bytes) {
            Ok(session) => session,
            Err(error) => {
                return Err(
                    self.preserve_unreadable(path, &format!("上次会话损坏，已跳过恢复：{error}"))
                )
            }
        };
        if let Err(error) = session.validate() {
            return Err(
                self.preserve_unreadable(path, &format!("上次会话无效，已跳过恢复：{error}"))
            );
        }
        Ok(Some(session))
    }
    /// Keep an unreadable session beside the live file. Recovery then writes a
    /// clean session without destroying the only copy of the user's history.
    fn preserve_unreadable(&self, path: &Path, reason: &str) -> String {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|time| time.as_nanos())
            .unwrap_or(0);
        let backup = path.with_file_name(format!("last-session.corrupt-{stamp}.json"));
        match std::fs::rename(path, &backup) {
            Ok(()) => format!("{reason}；原会话已保留在 {}", backup.display()),
            Err(error) => {
                format!("{reason}；原会话备份失败（{error}），请勿继续编辑前先手动备份。")
            }
        }
    }
    pub fn save(&self, session: &LastSession) -> Result<(), String> {
        session.validate()?;
        let path = self.path.as_ref().ok_or("会话存储尚未初始化")?;
        let parent = path.parent().ok_or("无效会话目录")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec_pretty(session).map_err(|e| e.to_string())?;
        if bytes.len() > 512 * 1024 {
            return Err("会话过大，旧会话仍保留".into());
        }
        let version = crate::files::disk_version(path).map_err(|e| e.message)?;
        let canonical = crate::files::checked_path(path, true).map_err(|e| e.message)?;
        crate::files::atomic::write_checked(&canonical, &bytes, version.as_deref())
            .map_err(|e| e.message)
    }
}
pub type SessionStore = Mutex<SessionService>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTabInput {
    pub token: String,
    pub encoding: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionInput {
    pub kind: String,
    pub tabs: Vec<SessionTabInput>,
    pub active_token: Option<String>,
    pub layout: Layout,
    #[serde(default)]
    pub editor_layout: Option<serde_json::Value>,
}
pub fn capture(
    input: SessionInput,
    files: &FileService,
    roots: Vec<PathBuf>,
) -> Result<LastSession, String> {
    if input.tabs.len() > 100 {
        return Err("会话最多记录100个标签".into());
    }
    let tabs = input
        .tabs
        .into_iter()
        .map(|tab| {
            Ok(SessionTab {
                path: files
                    .session_path(&tab.token)
                    .map_err(|e| e.message)?
                    .to_string_lossy()
                    .into_owned(),
                encoding: tab.encoding,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let active_path = input
        .active_token
        .map(|token| {
            files
                .session_path(&token)
                .map(|p| p.to_string_lossy().into_owned())
                .map_err(|e| e.message)
        })
        .transpose()?;
    let session = LastSession {
        schema_version: 1,
        kind: input.kind.clone(),
        roots: if input.kind == "workspace" {
            roots
                .into_iter()
                .map(|p| p.to_string_lossy().into_owned())
                .collect()
        } else {
            Vec::new()
        },
        tabs,
        active_path,
        layout: input.layout,
        editor_layout: input
            .editor_layout
            .map(|mut layout| -> Result<serde_json::Value, String> {
                fn map_node(
                    node: &mut serde_json::Value,
                    files: &FileService,
                    depth: usize,
                ) -> Result<(), String> {
                    if depth > 8 {
                        return Err("分栏布局过深".into());
                    }
                    if node["id"].as_str().is_none_or(|id| id.len() > 128) {
                        return Err("分栏标识无效".into());
                    }
                    match node["type"].as_str() {
                        Some("split") => {
                            map_node(&mut node["first"], files, depth + 1)?;
                            map_node(&mut node["second"], files, depth + 1)?;
                        }
                        Some("leaf") => {
                            let tabs = node["tabs"].as_array_mut().ok_or("分栏标签无效")?;
                            if tabs.len() > 100 {
                                return Err("分栏标签过多".into());
                            }
                            for tab in tabs {
                                let token = tab["documentId"].as_str().ok_or("分栏文件无效")?;
                                let path = files.session_path(token).map_err(|e| e.message)?;
                                tab["documentId"] = crate::display::display_path(&path).into();
                            }
                            if let Some(token) = node["activeId"].as_str() {
                                let path = files.session_path(token).map_err(|e| e.message)?;
                                node["activeId"] = crate::display::display_path(&path).into();
                            }
                        }
                        _ => return Err("分栏类型无效".into()),
                    }
                    Ok(())
                }
                if serde_json::to_vec(&layout)
                    .map_err(|e| e.to_string())?
                    .len()
                    > 128 * 1024
                {
                    return Err("分栏布局过大".into());
                }
                map_node(&mut layout["root"], files, 0)?;
                if let Some(modes) = layout.get_mut("modes") {
                    for values in modes.as_object_mut().ok_or("编辑模式无效")?.values_mut() {
                        let entries = values.as_object().ok_or("编辑模式无效")?.clone();
                        let mut mapped = serde_json::Map::new();
                        for (token, mode) in entries {
                            mapped.insert(
                                crate::display::display_path(
                                    &files.session_path(&token).map_err(|e| e.message)?,
                                ),
                                mode,
                            );
                        }
                        *values = serde_json::Value::Object(mapped);
                    }
                }
                Ok(layout)
            })
            .transpose()?,
    };
    session.validate()?;
    Ok(session)
}
