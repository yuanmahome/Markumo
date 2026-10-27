//! Workspace replace uses the searcher's Rust regex and line boundaries. No JS regex runs.
use super::{
    guard::validate_under_root,
    ignore::IgnoreRuleSet,
    search::{compile_query, in_directory, SearchQuery},
    WorkspaceSearcher,
};
use crate::files::{atomic, codec, read_disk};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

pub const MAX_FILE: usize = 10 * 1024 * 1024;
pub const MAX_PREVIEW: usize = 32 * 1024 * 1024;
pub const MAX_MATCHES: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceEdit {
    pub from: usize, // UTF-16 offsets for DocumentManager
    pub to: usize,
    pub line: usize,
    pub column: usize,
    pub before: String,
    pub insert: String,
    pub context: String,
    #[serde(skip)]
    start: usize,
    #[serde(skip)]
    end: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplaceFile {
    pub path: String,
    pub version: String,
    pub buffer: bool,
    pub edits: Vec<ReplaceEdit>,
    pub document_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct ReplacePreview {
    pub files: Vec<ReplaceFile>,
    pub skipped: Vec<String>,
    pub limited: bool,
    pub canceled: bool,
}

#[derive(Debug, Deserialize)]
pub struct ReplaceApply {
    pub query: SearchQuery,
    pub replacement: String,
    pub path: String,
    pub version: String,
    pub selected: Vec<usize>,
}

pub fn validate_query(query: &SearchQuery) -> Result<(), String> {
    if query.query.is_empty() || query.query.len() > 16 * 1024 {
        return Err("请输入不超过 16 KiB 的搜索表达式".into());
    }
    if query.buffers.len() > MAX_MATCHES
        || query.buffers.iter().any(|b| b.text.len() > MAX_FILE)
        || query.buffers.iter().map(|b| b.text.len()).sum::<usize>() > MAX_PREVIEW
    {
        return Err("编辑缓冲区超过 10 MiB/文件、32 MiB/批次预算；请缩小范围".into());
    }
    Ok(())
}

// Replacement never inherits the tree's 'show ignored' override.
pub fn allowed_path(
    roots: &[PathBuf],
    path: &Path,
    query: &SearchQuery,
) -> Result<PathBuf, String> {
    // The UI works with display paths (`E:\...`) while authorized roots are
    // canonical (`\\?\E:\...`). Compare canonical forms, exactly as the workspace
    // guard does, so authorization never depends on which spelling was sent.
    let canonical = path
        .canonicalize()
        .map_err(|_| "文件不在授权工作区".to_string())?;
    let root = roots
        .iter()
        .filter(|root| canonical.starts_with(root))
        .max_by_key(|root| root.components().count())
        .ok_or("文件不在授权工作区")?;
    // Validate the supplied spelling before following links. Canonicalization
    // above selects the root, but erases the evidence of a symlink/reparse point.
    let valid = validate_under_root(root, path).map_err(|e| e.to_string())?;
    if query.scope == "opened" {
        return Err("已打开文件范围禁止直接写入磁盘".into());
    }
    if !in_directory(&valid, query)
        || IgnoreRuleSet::new(root, false).is_ignored(&valid, false)
        || !super::search::FileFilters::new(query)?
            .allows(&super::guard::relative_slash_path(root, &valid), false)
    {
        return Err("文件在搜索范围之外或被忽略".into());
    }
    let ext = valid
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if [
        "pdf", "png", "apng", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "svg", "svgz",
        "avif", "bmp", "dib", "ico", "cur", "tif", "tiff", "heic", "heif", "jxl", "psd", "tga",
        "mp3", "mp4", "m4a", "aac", "flac", "wav", "ogg", "webm", "mov", "avi", "class",
    ]
    .contains(&ext.as_str())
    {
        return Err("跳过不可编辑媒体或二进制文件".into());
    }
    if !std::fs::metadata(&valid).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE as u64) {
        return Err("不是允许大小的普通文件".into());
    }
    Ok(valid)
}

/// Preserve the exact separators outside matches, including mixed CRLF/LF/CR.
/// Rust captures::expand: $0, $1, ${1}, $name, ${name}, $$; missing groups => empty.
pub fn edits(
    text: &str,
    query: &SearchQuery,
    replacement: &str,
    limit: usize,
    token: &AtomicBool,
) -> Result<Vec<ReplaceEdit>, String> {
    if text.len() > MAX_FILE || replacement.len() > 16 * 1024 {
        return Err("替换超出文件或替换文本预算".into());
    }
    let regex = compile_query(query)?;
    let mut edits = Vec::new();
    let mut start = 0;
    let mut utf16 = 0;
    let mut line_number = 1;
    let started = Instant::now();
    let default_eol = codec::eol(text);
    loop {
        if token.load(Ordering::Relaxed) {
            return Err("预览已取消".into());
        }
        if started.elapsed() > Duration::from_secs(10) {
            return Err("替换达到时间预算，请缩小范围".into());
        }
        let rest = &text[start..];
        let len = rest.find(['\r', '\n']).unwrap_or(rest.len());
        let line = &rest[..len];
        let separator = if rest[len..].starts_with("\r\n") {
            "\r\n"
        } else if rest[len..].starts_with('\r') {
            "\r"
        } else if default_eol == "CRLF" {
            "\r\n"
        } else if default_eol == "CR" {
            "\r"
        } else {
            "\n"
        };
        for captures in regex.captures_iter(line) {
            if edits.len() >= limit {
                return Ok(edits);
            }
            if token.load(Ordering::Relaxed) || started.elapsed() > Duration::from_secs(10) {
                return Err("替换已取消或达到时间预算".into());
            }
            let matched = captures.get(0).unwrap();
            let mut insert = String::new();
            if query.is_regex {
                // expand() accepts a String, not a bounded writer. Bound its
                // allocation before calling it (conservative for unused groups).
                let largest_capture = captures
                    .iter()
                    .flatten()
                    .map(|m| m.len())
                    .max()
                    .unwrap_or(0);
                let references = replacement.bytes().filter(|b| *b == b'$').count();
                if largest_capture
                    .saturating_mul(references)
                    .saturating_add(replacement.len())
                    > MAX_FILE
                {
                    return Err("捕获组展开上界超过 10 MiB 预算".into());
                }
                captures.expand(replacement, &mut insert);
            } else {
                insert.push_str(replacement);
            }
            insert = insert
                .replace("\r\n", "\n")
                .replace('\r', "\n")
                .replace('\n', separator);
            if insert.len() > MAX_FILE {
                return Err("捕获组展开超出预算".into());
            }
            let column = line[..matched.start()].encode_utf16().count();
            let before = matched.as_str().to_string();
            edits.push(ReplaceEdit {
                from: utf16 + column,
                to: utf16 + column + before.encode_utf16().count(),
                line: line_number,
                column: column + 1,
                before,
                insert,
                context: line
                    .chars()
                    .skip(line[..matched.start()].chars().count().saturating_sub(80))
                    .take(180)
                    .collect(),
                start: start + matched.start(),
                end: start + matched.end(),
            });
            if edits
                .iter()
                .map(|e| e.before.len() + e.insert.len() + e.context.len())
                .sum::<usize>()
                > MAX_PREVIEW
            {
                return Err("预览内容超过 32 MiB 预算".into());
            }
        }
        if len == rest.len() {
            break;
        }
        let separator = if rest[len..].starts_with("\r\n") {
            2
        } else {
            1
        };
        utf16 += rest[..len + separator].encode_utf16().count();
        start += len + separator;
        line_number += 1;
    }
    Ok(edits)
}

fn preview_single_file(
    roots: &[PathBuf],
    target_str: &str,
    query: &SearchQuery,
    replacement: &str,
    hit_limit: usize,
    token: &AtomicBool,
    size: &mut usize,
) -> Result<Option<ReplaceFile>, String> {
    let path = allowed_path(roots, Path::new(target_str), query)?;
    let (bytes, version, read_only) = read_disk(&path).map_err(|e| e.to_string())?;
    if crate::files::media::is_media_content(&bytes) {
        return Err("跳过媒体内容（与扩展名无关）".into());
    }
    if read_only {
        return Err("文件没有写入权限".into());
    }
    // The buffer path arrives from the UI, which uses display paths, while this
    // function holds the canonical path. One shared comparison accepts either
    // spelling so the open document's text is always the authoritative one.
    let buffer = query.buffers.iter().find(|b| {
        super::search::same_file(&b.path, &path) || Path::new(&b.path) == Path::new(target_str)
    });
    if buffer.is_some_and(|buffer| buffer.read_only) {
        return Err("打开的文档为只读".into());
    }
    let (disk, encoding, bom) = codec::decode_with_path(
        &bytes,
        buffer.and_then(|b| b.encoding.as_deref()),
        Some(&path),
    )
    .map_err(|e| e.to_string())?;
    // Reject ambiguous/non-bijective legacy decoding before offering a replacement.
    if codec::encode(&disk, &encoding, bom).map_err(|e| e.to_string())? != bytes {
        return Err("源文件编码无法无损往返".into());
    }
    let text = buffer.map(|b| b.text.as_str()).unwrap_or(&disk);
    let changes = edits(text, query, replacement, hit_limit, token)?;
    *size += text.len()
        + changes
            .iter()
            .map(|e| e.before.len() + e.insert.len() + e.context.len())
            .sum::<usize>();
    if *size > MAX_PREVIEW {
        return Err("预览超过 32 MiB 预算，请缩小目录范围".into());
    }
    if changes.is_empty() {
        return Ok(None);
    }
    Ok(Some(ReplaceFile {
        path: target_str.to_string(),
        version,
        buffer: buffer.is_some(),
        edits: changes,
        document_id: buffer.and_then(|b| b.document_id.clone()),
    }))
}

pub fn preview(
    roots: &[PathBuf],
    query: &SearchQuery,
    replacement: &str,
    targets: &[String],
    token: Arc<AtomicBool>,
) -> Result<ReplacePreview, String> {
    validate_query(query)?;
    let started = Instant::now();
    if replacement.len() > 16 * 1024 || targets.len() > MAX_MATCHES {
        return Err("替换请求超出预算".into());
    }
    let max_results = query
        .max_results
        .unwrap_or(MAX_MATCHES)
        .clamp(1, MAX_MATCHES);
    super::search::validate_scope(roots, query)?;
    let filters = super::search::FileFilters::new(query)?;
    if query.scope == "opened" {
        let mut files = Vec::new();
        let mut total = 0;
        let mut size = 0;
        let mut limited = false;
        let mut skipped = Vec::new();
        for buffer in &query.buffers {
            if token.load(Ordering::Relaxed) {
                break;
            }
            if !filters.allows(
                buffer.relative_path.as_deref().unwrap_or(&buffer.path),
                false,
            ) || !targets.is_empty() && !targets.contains(&buffer.path)
            {
                continue;
            }
            if buffer.read_only {
                skipped.push(format!("{}：只读缓冲区", buffer.path));
                continue;
            }
            if total >= max_results || started.elapsed() > Duration::from_secs(10) {
                limited = true;
                break;
            }
            let changes = edits(
                &buffer.text,
                query,
                replacement,
                max_results - total,
                &token,
            )?;
            total += changes.len();
            size += changes
                .iter()
                .map(|c| c.before.len() + c.insert.len() + c.context.len())
                .sum::<usize>();
            if size > MAX_PREVIEW {
                limited = true;
                break;
            }
            if !changes.is_empty() {
                files.push(ReplaceFile {
                    path: buffer.path.clone(),
                    version: crate::files::version_of(buffer.text.as_bytes(), None),
                    buffer: true,
                    edits: changes,
                    document_id: buffer.document_id.clone(),
                });
            }
        }
        return Ok(ReplacePreview {
            files,
            skipped,
            limited: limited || total >= max_results,
            canceled: token.load(Ordering::Relaxed),
        });
    }

    if !targets.is_empty() {
        let mut files = Vec::new();
        let mut skipped = Vec::new();
        let mut size = 0;
        let mut total_matches = 0;
        let mut limited = false;
        let mut seen = HashSet::new();

        for target in targets {
            if token.load(Ordering::Relaxed) {
                break;
            }
            if started.elapsed() > Duration::from_secs(10) || size > MAX_PREVIEW {
                limited = true;
                skipped.push("预览达到 10 秒/32 MiB 预算，剩余文件未处理；请缩小目录范围".into());
                break;
            }
            if !seen.insert(target.clone()) {
                continue;
            }
            let remaining = max_results.saturating_sub(total_matches);
            if remaining == 0 {
                limited = true;
                break;
            }
            let file = match preview_single_file(
                roots,
                target,
                query,
                replacement,
                remaining,
                &token,
                &mut size,
            ) {
                Ok(file) => file,
                Err(error) => {
                    skipped.push(format!("{target}：{error}"));
                    continue;
                }
            };
            if let Some(file) = file {
                if file.edits.len() >= remaining {
                    limited = true;
                }
                total_matches += file.edits.len();
                files.push(file);
            }
        }

        return Ok(ReplacePreview {
            files,
            skipped,
            limited,
            canceled: token.load(Ordering::Relaxed),
        });
    }

    let mut hits = Vec::new();
    let searched =
        WorkspaceSearcher::execute_search_detailed(roots, query, token.clone(), |batch| {
            hits.extend(batch)
        })?;
    let mut limited = searched.limited;
    let mut seen = HashSet::new();
    let mut hit_counts = HashMap::new();
    for hit in &hits {
        *hit_counts.entry(hit.path.clone()).or_insert(0usize) += 1;
    }
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    if searched.skipped > 0 {
        skipped.push(format!(
            "搜索阶段跳过 {} 个不可读取、二进制或超预算条目",
            searched.skipped
        ));
    }
    if let Some(reason) = searched.reason {
        skipped.push(reason);
    }
    let mut size = 0;
    for hit in hits {
        if token.load(Ordering::Relaxed) {
            break;
        }
        if started.elapsed() > Duration::from_secs(10) || size > MAX_PREVIEW {
            limited = true;
            skipped.push("预览达到 10 秒/32 MiB 预算，剩余文件未处理；请缩小目录范围".into());
            break;
        }
        if !seen.insert(hit.path.clone()) {
            continue;
        }
        let count = files
            .iter()
            .map(|f: &ReplaceFile| f.edits.len())
            .sum::<usize>();
        let remaining = max_results
            .saturating_sub(count)
            .min(hit_counts.get(&hit.path).copied().unwrap_or(0));
        match preview_single_file(
            roots,
            &hit.path,
            query,
            replacement,
            remaining,
            &token,
            &mut size,
        ) {
            Ok(Some(file)) => files.push(file),
            Ok(None) => {}
            Err(error) => skipped.push(format!("{}：{error}", hit.path)),
        }
    }
    Ok(ReplacePreview {
        files,
        skipped,
        limited,
        canceled: token.load(Ordering::Relaxed),
    })
}

pub fn apply(roots: &[PathBuf], request: &ReplaceApply) -> Result<usize, String> {
    validate_query(&request.query)?;
    if request.selected.is_empty() || request.selected.len() > MAX_MATCHES {
        return Err("未选择匹配项或超出预算".into());
    }
    if !request.query.buffers.is_empty() {
        return Err("已打开文件必须通过编辑器事务修改".into());
    }
    let path = allowed_path(roots, Path::new(&request.path), &request.query)?;
    let (bytes, version, read_only) = read_disk(&path).map_err(|e| e.to_string())?;
    if crate::files::media::is_media_content(&bytes) {
        return Err("跳过媒体内容（与扩展名无关）".into());
    }
    if version != request.version {
        return Err("文件版本已变化；请重新生成预览，未写入过期偏移量".into());
    }
    if read_only {
        return Err("文件没有写入权限".into());
    }
    let (text, encoding, bom) =
        codec::decode_with_path(&bytes, None, Some(&path)).map_err(|e| e.to_string())?;
    if codec::encode(&text, &encoding, bom).map_err(|e| e.to_string())? != bytes {
        return Err("源文件编码无法无损往返".into());
    }
    // Always recompute captures and byte boundaries from the freshly checked file.
    let changes = edits(
        &text,
        &request.query,
        &request.replacement,
        MAX_MATCHES,
        &AtomicBool::new(false),
    )?;
    let selected: HashSet<_> = request.selected.iter().copied().collect();
    if selected.len() != request.selected.len() || selected.iter().any(|i| *i >= changes.len()) {
        return Err("选择项无效，请重新预览".into());
    }
    let mut output = String::new();
    let mut cursor = 0;
    for (_, change) in changes
        .iter()
        .enumerate()
        .filter(|(index, _)| selected.contains(index))
    {
        output.push_str(&text[cursor..change.start]);
        output.push_str(&change.insert);
        cursor = change.end;
        if output.len() > MAX_FILE {
            return Err("替换输出超过 10 MiB 预算".into());
        }
    }
    output.push_str(&text[cursor..]);
    let encoded = codec::encode(&output, &encoding, bom).map_err(|e| e.to_string())?;
    if encoded.len() > MAX_FILE {
        return Err("编码后文件超过 10 MiB 预算".into());
    }
    if encoded == bytes {
        return Ok(selected.len());
    }
    allowed_path(roots, &path, &request.query)?;
    atomic::write_checked_preserving_identity(&path, &encoded, Some(&version))
        .map_err(|e| e.to_string())?;
    Ok(selected.len())
}

pub fn apply_closed(
    roots: &[PathBuf],
    request: &ReplaceApply,
    files: &crate::files::FileService,
) -> Result<usize, String> {
    let path = allowed_path(roots, Path::new(&request.path), &request.query)?;
    if files.has_grants_under(&path) {
        return Err("文件已经在编辑器窗口中打开；请重新预览并通过文档事务替换".into());
    }
    apply(roots, request)
}
