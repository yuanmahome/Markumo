use super::{
    guard::{relative_slash_path, validate_under_root},
    ignore::IgnoreRuleSet,
};
use crate::display::display_path;
use crate::display::display_text;

use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

/// True when a path string from the UI and a canonical path name the same file.
///
/// Windows resolves the same file to `E:\dir\a.md`, `\\?\E:\dir\a.md` and any
/// letter case; all of them must identify one open buffer.
pub fn same_file(candidate: &str, canonical: &Path) -> bool {
    if Path::new(candidate) == canonical {
        return true;
    }
    let left = display_text(candidate).replace('/', "\\");
    let right = display_text(&canonical.to_string_lossy()).replace('/', "\\");
    if cfg!(windows) {
        left.eq_ignore_ascii_case(&right)
    } else {
        left == right
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchMatch {
    pub search_id: String,
    pub path: String,
    pub relative_path: String,
    pub line_number: usize,
    pub column_number: usize,
    pub line_text: String,
    pub match_length: usize,
    pub id: String,
    pub document_id: Option<String>,
    pub version: String,
    pub snippet_column: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchQuery {
    pub search_id: String,
    pub query: String,
    pub is_case_sensitive: bool,
    pub is_whole_word: bool,
    pub is_regex: bool,
    pub max_results: Option<usize>,
    #[serde(default)]
    pub include_ignored: bool,
    #[serde(default)]
    pub directory: Option<String>,
    #[serde(default)]
    pub buffers: Vec<SearchBuffer>,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub include_globs: Vec<String>,
    #[serde(default)]
    pub exclude_globs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchBuffer {
    pub path: String,
    pub text: String,
    #[serde(default)]
    pub encoding: Option<String>,
    #[serde(default)]
    pub document_id: Option<String>,
    #[serde(default)]
    pub relative_path: Option<String>,
    #[serde(default)]
    pub read_only: bool,
}

pub fn is_text_path(path: &Path) -> bool {
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ![
        "pdf", "png", "apng", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "svg", "svgz",
        "avif", "bmp", "dib", "ico", "cur", "tif", "tiff", "heic", "heif", "jxl", "psd", "tga",
        "mp3", "mp4", "m4a", "aac", "flac", "wav", "ogg", "webm", "mov", "avi", "class",
    ]
    .contains(&extension.as_str())
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct SearchSummary {
    pub total: usize,
    pub canceled: bool,
    pub limited: bool,
    pub skipped: usize,
    pub reason: Option<String>,
}

pub struct FileFilters {
    include: Vec<(globset::GlobMatcher, bool)>,
    exclude: Vec<(globset::GlobMatcher, bool)>,
}
impl FileFilters {
    pub fn new(query: &SearchQuery) -> Result<Self, String> {
        fn compile(patterns: &[String]) -> Result<Vec<(globset::GlobMatcher, bool)>, String> {
            if patterns.len() > 64 {
                return Err("文件过滤最多允许 64 条规则".into());
            }
            patterns
                .iter()
                .map(|pattern| {
                    if pattern.len() > 1024 {
                        return Err("文件过滤规则过长".into());
                    }
                    let pattern = pattern.replace('\\', "/");
                    let matcher = globset::GlobBuilder::new(&pattern)
                        .literal_separator(true)
                        .case_insensitive(cfg!(windows))
                        .build()
                        .map_err(|e| format!("Glob 规则无效：{e}"))?
                        .compile_matcher();
                    Ok((matcher, pattern.contains('/')))
                })
                .collect()
        }
        Ok(Self {
            include: compile(&query.include_globs)?,
            exclude: compile(&query.exclude_globs)?,
        })
    }
    pub fn allows(&self, relative: &str, directory: bool) -> bool {
        let relative = relative.replace('\\', "/");
        let name = relative.rsplit('/').next().unwrap_or(&relative);
        let matches = |(matcher, full): &(globset::GlobMatcher, bool)| {
            matcher.is_match(if *full { relative.as_str() } else { name })
                || directory && *full && matcher.is_match(format!("{relative}/"))
        };
        !self.exclude.iter().any(matches)
            && (directory || self.include.is_empty() || self.include.iter().any(matches))
    }
}

pub fn validate_scope(roots: &[std::path::PathBuf], query: &SearchQuery) -> Result<(), String> {
    if !["", "workspace", "directory", "opened"].contains(&query.scope.as_str()) {
        return Err("未知搜索范围".into());
    }
    if query.scope == "opened" {
        return Ok(());
    }
    if roots.is_empty() {
        return Err("当前未打开工作区；可选择已打开文件范围".into());
    }
    if query.scope == "directory" && query.directory.as_ref().is_none_or(|s| s.is_empty()) {
        return Err("请选择搜索目录".into());
    }
    if let Some(directory) = query.directory.as_ref().filter(|s| !s.is_empty()) {
        if !roots
            .iter()
            .any(|root| validate_under_root(root, Path::new(directory)).is_ok_and(|p| p.is_dir()))
        {
            return Err("搜索目录无效或不在已授权工作区内".into());
        }
    }
    Ok(())
}

pub fn compile_query(query: &SearchQuery) -> Result<Regex, String> {
    let mut pattern = if query.is_regex {
        query.query.clone()
    } else {
        regex::escape(&query.query)
    };
    if query.is_whole_word {
        pattern = format!(r"\b(?:{})\b", pattern);
    }
    RegexBuilder::new(&pattern)
        .case_insensitive(!query.is_case_sensitive)
        .size_limit(1024 * 1024)
        .dfa_size_limit(2 * 1024 * 1024)
        .build()
        .map_err(|e| format!("正则表达式无效: {e}"))
}

pub fn in_directory(path: &Path, query: &SearchQuery) -> bool {
    query
        .directory
        .as_ref()
        .filter(|s| !s.is_empty())
        .is_none_or(|directory| {
            Path::new(directory)
                .canonicalize()
                .is_ok_and(|scope| path.starts_with(scope))
        })
}
#[derive(Default, Clone)]
pub struct SearchManager {
    tokens: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    pub previews: Arc<Mutex<super::preview::PreviewCache>>,
}
impl SearchManager {
    /// The token map is a best-effort cancellation registry; recovering a
    /// poisoned guard is safe and keeps cancellation available after a panic in
    /// an unrelated search task. Mutable document stores still surface poisoning
    /// to their callers instead of guessing at recovered state.
    fn token_map(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
        self.tokens
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn create_token(&self, search_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        let mut map = self.token_map();
        if let Some(old) = map.insert(search_id.to_string(), Arc::clone(&flag)) {
            old.store(true, Ordering::Relaxed);
        }
        flag
    }
    pub fn cancel(&self, search_id: &str) {
        if let Some(flag) = self.token_map().remove(search_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    /// All pending preview reads for one dialog share a lifetime token. A
    /// close cancels them together, independently of IPC arrival order.
    pub fn shared_token(&self, owner: &str) -> Arc<AtomicBool> {
        self.token_map()
            .entry(owner.to_owned())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }
    pub fn cleanup(&self, search_id: &str, token: &Arc<AtomicBool>) {
        let mut map = self.token_map();
        if map
            .get(search_id)
            .is_some_and(|stored| Arc::ptr_eq(stored, token))
        {
            map.remove(search_id);
        }
    }
}

// Enumeration is requested by search/Quick Open only, never by initial tree loading.
struct TraversalBudget {
    started: Instant,
    count: usize,
    skipped: usize,
}

impl TraversalBudget {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            count: 0,
            skipped: 0,
        }
    }

    fn exhausted(&self) -> bool {
        self.count > 100_000 || self.started.elapsed() > Duration::from_secs(10)
    }
}

fn walk_files_budget(
    root: &Path,
    scope: Option<&Path>,
    include_ignored: bool,
    token: &AtomicBool,
    budget: &mut TraversalBudget,
    filters: Option<&FileFilters>,
    mut visit: impl FnMut(&Path) -> bool,
) -> Result<(), String> {
    let canonical = validate_under_root(root, root).map_err(|e| e.to_string())?;
    let root = canonical.as_path();
    let rules = IgnoreRuleSet::new(root, include_ignored);
    let mut directories = vec![root.to_path_buf()];
    while let Some(dir) = directories.pop() {
        if token.load(Ordering::Relaxed) {
            return Ok(());
        }
        let valid = match validate_under_root(root, &dir) {
            Ok(p) => p,
            Err(_) => {
                budget.skipped += 1;
                continue;
            }
        };
        let entries = match std::fs::read_dir(valid) {
            Ok(e) => e,
            Err(_) => {
                budget.skipped += 1;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    budget.skipped += 1;
                    continue;
                }
            };
            if token.load(Ordering::Relaxed) {
                return Ok(());
            }
            budget.count += 1;
            if budget.exhausted() {
                return Err("检索达到 10 秒/10 万条目限制；请缩小工作区或启用忽略规则".into());
            }
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            #[cfg(not(windows))]
            let _ = metadata;
            // Paths are direct entries of an already validated directory. Never follow links.
            if kind.is_symlink()
                || rules.is_ignored(&path, kind.is_dir())
                || filters.is_some_and(|filters| {
                    !filters.allows(&relative_slash_path(root, &path), kind.is_dir())
                })
            {
                continue;
            }
            if kind.is_dir() {
                if scope.is_none_or(|scope| path.starts_with(scope) || scope.starts_with(&path)) {
                    directories.push(path);
                }
            } else if kind.is_file() && !visit(&path) {
                return Ok(());
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
pub struct QuickFile {
    pub name: String,
    pub path: String,
    pub relative_path: String,
}
pub fn find_files_roots(
    roots: &[std::path::PathBuf],
    query: &str,
    include_ignored: bool,
    limit: usize,
) -> Result<Vec<QuickFile>, String> {
    let mut budget = TraversalBudget::new();
    let mut files = Vec::new();
    for root in roots {
        let remaining = limit.saturating_sub(files.len());
        if remaining == 0 || budget.exhausted() {
            break;
        }
        let prefix = if roots.len() > 1 {
            format!(
                "{}/",
                root.file_name().unwrap_or_default().to_string_lossy()
            )
        } else {
            String::new()
        };
        files.extend(find_files_budget(
            root,
            query,
            include_ignored,
            &mut budget,
            &prefix,
            remaining,
        )?);
        if files.len() >= limit {
            break;
        }
    }
    files.truncate(limit);
    Ok(files)
}

fn find_files_budget(
    root: &Path,
    query: &str,
    include_ignored: bool,
    budget: &mut TraversalBudget,
    prefix: &str,
    limit: usize,
) -> Result<Vec<QuickFile>, String> {
    let canonical = validate_under_root(root, root).map_err(|e| e.to_string())?;
    let root = canonical.as_path();
    let query = query.to_lowercase();
    let mut results = Vec::new();
    let walked = walk_files_budget(
        root,
        None,
        include_ignored,
        &AtomicBool::new(false),
        budget,
        None,
        |path| {
            let relative = format!("{prefix}{}", relative_slash_path(root, path));
            let lower = relative.to_lowercase();
            let mut chars = lower.chars();
            if query
                .chars()
                .all(|wanted| chars.by_ref().any(|c| c == wanted))
            {
                results.push(QuickFile {
                    name: path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                    path: display_path(path),
                    relative_path: relative,
                });
            }
            results.len() < limit
        },
    );
    // A bounded Quick Open index is still useful. Full-text search continues to
    // report budget errors, while indexing keeps the files already enumerated.
    if !budget.exhausted() {
        walked?;
    }
    Ok(results)
}

pub struct WorkspaceSearcher;
impl WorkspaceSearcher {
    pub fn execute_search_roots<F>(
        roots: &[std::path::PathBuf],
        query: &SearchQuery,
        token: Arc<AtomicBool>,
        on_batch: F,
    ) -> Result<usize, String>
    where
        F: FnMut(Vec<SearchMatch>),
    {
        Self::execute_search_detailed(roots, query, token, on_batch).map(|summary| summary.total)
    }
    pub fn execute_search_detailed<F>(
        roots: &[std::path::PathBuf],
        query: &SearchQuery,
        token: Arc<AtomicBool>,
        mut on_batch: F,
    ) -> Result<SearchSummary, String>
    where
        F: FnMut(Vec<SearchMatch>),
    {
        let mut summary = SearchSummary::default();
        if query.query.is_empty() {
            return Ok(summary);
        }
        super::replace::validate_query(query)?;
        validate_scope(roots, query)?;
        let filters = FileFilters::new(query)?;
        let regex = compile_query(query)?;
        let max = query.max_results.unwrap_or(1000).clamp(1, 1000);
        let mut budget = TraversalBudget::new();
        let mut batch = Vec::with_capacity(32);
        if query.scope == "opened" {
            for buffer in &query.buffers {
                if token.load(Ordering::Relaxed) || summary.total >= max || summary.limited {
                    break;
                }
                if !filters.allows(
                    buffer.relative_path.as_deref().unwrap_or(&buffer.path),
                    false,
                ) {
                    continue;
                }
                let version = crate::files::version_of(buffer.text.as_bytes(), None);
                Self::search_text(
                    &buffer.text,
                    &buffer.path,
                    buffer.relative_path.as_deref().unwrap_or(&buffer.path),
                    buffer.document_id.clone(),
                    &version,
                    &regex,
                    query,
                    &token,
                    budget.started,
                    max,
                    &mut summary,
                    &mut batch,
                    &mut on_batch,
                );
            }
        } else {
            let scope = query
                .directory
                .as_ref()
                .filter(|s| !s.is_empty())
                .map(|s| Path::new(s).canonicalize().map_err(|e| e.to_string()))
                .transpose()?;
            let mut seen = std::collections::HashSet::new();
            for root in roots {
                if summary.total >= max || token.load(Ordering::Relaxed) || summary.limited {
                    break;
                }
                let prefix = if roots.len() > 1 {
                    let name = root.file_name().unwrap_or_default();
                    let label = if roots
                        .iter()
                        .any(|other| other != root && other.file_name() == root.file_name())
                    {
                        display_path(root)
                    } else {
                        name.to_string_lossy().into_owned()
                    };
                    format!("{label}/")
                } else {
                    String::new()
                };
                let started = budget.started;
                let walked = walk_files_budget(
                    root,
                    scope.as_deref(),
                    query.include_ignored,
                    &token,
                    &mut budget,
                    Some(&filters),
                    |path| {
                        if scope.as_ref().is_some_and(|scope| !path.starts_with(scope)) {
                            return true;
                        }
                        let relative = relative_slash_path(root, path);
                        if !filters.allows(&relative, false) || !seen.insert(path.to_path_buf()) {
                            return true;
                        }
                        if !is_text_path(path) {
                            return true;
                        }
                        if !std::fs::metadata(path).is_ok_and(|m| m.len() <= 10 * 1024 * 1024) {
                            summary.skipped += 1;
                            return true;
                        }
                        let buffer = query.buffers.iter().find(|b| same_file(&b.path, path));
                        let (text, version) = if let Some(buffer) = buffer {
                            (
                                buffer.text.clone(),
                                crate::files::version_of(buffer.text.as_bytes(), None),
                            )
                        } else {
                            match crate::files::read_disk(path) {
                                Ok((bytes, version, _)) => {
                                    if crate::files::media::is_media_content(&bytes) {
                                        summary.skipped += 1;
                                        return true;
                                    }
                                    match crate::files::codec::decode_with_path(
                                        &bytes,
                                        None,
                                        Some(path),
                                    ) {
                                        Ok((text, _, _)) => (text, version),
                                        Err(_) => {
                                            summary.skipped += 1;
                                            return true;
                                        }
                                    }
                                }
                                Err(_) => {
                                    summary.skipped += 1;
                                    return true;
                                }
                            }
                        };
                        Self::search_text(
                            &text,
                            &display_path(path),
                            &format!("{prefix}{relative}"),
                            buffer.and_then(|b| b.document_id.clone()),
                            &version,
                            &regex,
                            query,
                            &token,
                            started,
                            max,
                            &mut summary,
                            &mut batch,
                            &mut on_batch,
                        );
                        summary.total < max && !token.load(Ordering::Relaxed) && !summary.limited
                    },
                );
                if let Err(error) = walked {
                    summary.limited = true;
                    summary.reason = Some(error);
                    break;
                }
            }
        }
        if !batch.is_empty() {
            on_batch(batch);
        }
        summary.skipped += budget.skipped;
        summary.canceled = token.load(Ordering::Relaxed);
        if summary.total >= max {
            summary.limited = true;
            summary.reason = Some(format!("达到 {max} 处结果上限；请缩小范围"));
        }
        Ok(summary)
    }
    #[allow(clippy::too_many_arguments)]
    fn search_text(
        text: &str,
        path: &str,
        relative: &str,
        document_id: Option<String>,
        version: &str,
        regex: &Regex,
        query: &SearchQuery,
        token: &AtomicBool,
        started: Instant,
        max: usize,
        summary: &mut SearchSummary,
        batch: &mut Vec<SearchMatch>,
        on_batch: &mut impl FnMut(Vec<SearchMatch>),
    ) {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        for (index, line) in normalized.split('\n').enumerate() {
            if token.load(Ordering::Relaxed) {
                return;
            }
            if started.elapsed() > Duration::from_secs(10) {
                summary.limited = true;
                summary.reason = Some("达到 10 秒搜索预算；请缩小范围".into());
                return;
            }
            let mut previous = 0;
            let mut units = 0;
            for matched in regex.find_iter(line) {
                if token.load(Ordering::Relaxed) || summary.total >= max {
                    return;
                }
                if started.elapsed() > Duration::from_secs(10) {
                    summary.limited = true;
                    summary.reason = Some("达到 10 秒搜索预算；请缩小范围".into());
                    return;
                }
                units += line[previous..matched.start()].encode_utf16().count();
                let column = units + 1;
                units += matched.as_str().encode_utf16().count();
                previous = matched.end();
                // A bounded snippet centred on the hit, even on a very long line.
                let start = line[..matched.start()]
                    .char_indices()
                    .rev()
                    .nth(100)
                    .map(|(i, _)| i)
                    .unwrap_or(0);
                let snippet: String = line[start..].chars().take(500).collect();
                batch.push(SearchMatch {
                    search_id: query.search_id.clone(),
                    path: path.into(),
                    relative_path: relative.into(),
                    line_number: index + 1,
                    column_number: column,
                    line_text: snippet,
                    match_length: matched.as_str().encode_utf16().count(),
                    id: format!(
                        "{}:{}:{}:{}:{}",
                        query.search_id,
                        document_id.as_deref().unwrap_or(path),
                        index + 1,
                        column,
                        matched.len()
                    ),
                    document_id: document_id.clone(),
                    version: version.into(),
                    snippet_column: line[start..matched.start()].encode_utf16().count(),
                });
                summary.total += 1;
                if batch.len() >= 32 {
                    on_batch(std::mem::take(batch));
                }
            }
        }
    }
}
