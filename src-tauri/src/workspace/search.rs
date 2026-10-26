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
    fs::File,
    io::Read,
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
    if cfg!(windows) { left.eq_ignore_ascii_case(&right) } else { left == right }
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchBuffer {
    pub path: String,
    pub text: String,
    #[serde(default)]
    pub encoding: Option<String>,
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
}

impl TraversalBudget {
    fn new() -> Self {
        Self {
            started: Instant::now(),
            count: 0,
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
            Err(_) => continue,
        };
        let entries = match std::fs::read_dir(valid) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
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
            if kind.is_symlink() || rules.is_ignored(&path, kind.is_dir()) {
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
        mut on_batch: F,
    ) -> Result<usize, String>
    where
        F: FnMut(Vec<SearchMatch>),
    {
        if !query.query.is_empty() {
            super::replace::validate_query(query)?;
        }
        let max = query.max_results.unwrap_or(1000).clamp(1, 1000);
        let mut total = 0;
        let mut budget = TraversalBudget::new();
        for root in roots {
            if total >= max || token.load(Ordering::Relaxed) {
                break;
            }
            if budget.started.elapsed() > Duration::from_secs(10) {
                return Err("工作区搜索达到时间限制；请缩小范围".into());
            }
            let mut current = query.clone();
            current.max_results = Some(max - total);
            Self::execute_search_budget(
                root,
                &current,
                token.clone(),
                &mut budget,
                |mut batch| {
                    total += batch.len();
                    if roots.len() > 1 {
                        for item in &mut batch {
                            item.relative_path = format!(
                                "{}/{}",
                                root.file_name().unwrap_or_default().to_string_lossy(),
                                item.relative_path
                            );
                        }
                    }
                    on_batch(batch);
                },
            )?;
        }
        Ok(total)
    }

    fn execute_search_budget<F>(
        root: &Path,
        query: &SearchQuery,
        token: Arc<AtomicBool>,
        budget: &mut TraversalBudget,
        mut on_batch: F,
    ) -> Result<usize, String>
    where
        F: FnMut(Vec<SearchMatch>),
    {
        let canonical = validate_under_root(root, root).map_err(|e| e.to_string())?;
        let root = canonical.as_path();
        if query.query.is_empty() {
            return Ok(0);
        }
        let max_results = query.max_results.unwrap_or(1000).clamp(1, 1000);
        let regex = compile_query(query)?;
        let scope = query
            .directory
            .as_ref()
            .filter(|s| !s.is_empty())
            .map(|s| {
                Path::new(s)
                    .canonicalize()
                    .map_err(|e| format!("搜索目录不可用：{e}"))
            })
            .transpose()?;
        let mut total = 0;
        let mut batch = Vec::with_capacity(32);
        walk_files_budget(
            root,
            scope.as_deref(),
            query.include_ignored,
            &token,
            budget,
            |path| {
                if scope.as_ref().is_some_and(|scope| !path.starts_with(scope)) {
                    return true;
                }
                Self::search_file(
                    path,
                    root,
                    &regex,
                    query,
                    &token,
                    &mut total,
                    max_results,
                    &mut batch,
                    &mut on_batch,
                );
                total < max_results && !token.load(Ordering::Relaxed)
            },
        )?;
        if !token.load(Ordering::Relaxed) && !batch.is_empty() {
            on_batch(batch);
        }
        Ok(total)
    }
    #[allow(clippy::too_many_arguments)]
    fn search_file(
        path: &Path,
        root: &Path,
        regex: &Regex,
        query: &SearchQuery,
        token: &AtomicBool,
        total: &mut usize,
        max: usize,
        batch: &mut Vec<SearchMatch>,
        on_batch: &mut impl FnMut(Vec<SearchMatch>),
    ) {
        let file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return,
        };
        if !file.metadata().is_ok_and(|m| m.len() <= 10 * 1024 * 1024) {
            return;
        }
        let mut bytes = Vec::new();
        if file
            .take(10 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .is_err()
            || bytes.len() > 10 * 1024 * 1024
        {
            return;
        }
        // Buffer paths come from the UI (display spelling) while this walk yields
        // canonical paths: compare one normalised form so an open document's
        // unsaved text is always the one searched.
        let buffer = query
            .buffers
            .iter()
            .find(|buffer| same_file(&buffer.path, path));
        let text = match buffer {
            Some(buffer) => buffer.text.clone(),
            None => match crate::files::decode_search_text(&bytes) {
                Ok(text) => text,
                Err(_) => return,
            },
        };
        // Match CodeMirror's normalized LF line positions, including CR-only files.
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let relative = relative_slash_path(root, path);
        for (index, line) in normalized.split('\n').enumerate() {
            if token.load(Ordering::Relaxed) {
                return;
            }
            for matched in regex.find_iter(line) {
                if token.load(Ordering::Relaxed) || *total >= max {
                    return;
                }
                *total += 1;
                batch.push(SearchMatch {
                    search_id: query.search_id.clone(),
                    path: display_path(path),
                    relative_path: relative.clone(),
                    line_number: index + 1,
                    column_number: line[..matched.start()].encode_utf16().count() + 1,
                    match_length: matched.as_str().encode_utf16().count(),
                    line_text: line.chars().take(1024).collect(),
                });
                if batch.len() == 32 && !token.load(Ordering::Relaxed) {
                    on_batch(std::mem::take(batch));
                }
            }
        }
    }
}
