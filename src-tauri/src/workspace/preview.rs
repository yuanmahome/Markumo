//! Requested-source preview only: at most two recently selected files / 16 MiB.
//! IPC returns a bounded window, never an editor document or rendered Markdown.
use super::{
    guard::{relative_slash_path, validate_under_root},
    search::{compile_query, FileFilters, SearchQuery},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    time::SystemTime,
};

#[derive(Debug, Deserialize)]
pub struct PreviewRequest {
    pub path: String,
    pub version: String,
    pub line: usize,
    pub column: usize,
    pub length: usize,
    pub query: SearchQuery,
}
#[derive(Debug, Serialize)]
pub struct PreviewHit {
    pub from: usize,
    pub to: usize,
}
#[derive(Debug, Serialize)]
pub struct SourcePreview {
    pub path: String,
    pub version: String,
    pub text: String,
    pub start_line: usize,
    pub selection_from: usize,
    pub selection_to: usize,
    pub hits: Vec<PreviewHit>,
    pub truncated: bool,
}
struct Entry {
    owner: String,
    path: PathBuf,
    version: String,
    text: String,
    len: u64,
    modified: Option<SystemTime>,
}
#[derive(Default)]
pub struct PreviewCache {
    entries: VecDeque<Entry>,
}
impl PreviewCache {
    pub fn clear(&mut self, owner: &str) {
        self.entries.retain(|entry| entry.owner != owner);
    }
    pub fn read(
        &mut self,
        owner: &str,
        roots: &[PathBuf],
        request: &PreviewRequest,
    ) -> Result<SourcePreview, String> {
        super::replace::validate_query(&request.query)?;
        super::search::validate_scope(roots, &request.query)?;
        let root = roots
            .iter()
            .find(|root| validate_under_root(root, Path::new(&request.path)).is_ok())
            .ok_or("预览路径不在授权工作区内")?;
        let path =
            validate_under_root(root, Path::new(&request.path)).map_err(|e| e.to_string())?;
        if !super::search::in_directory(&path, &request.query)
            || !FileFilters::new(&request.query)?.allows(&relative_slash_path(root, &path), false)
        {
            return Err("预览文件不在当前搜索范围内".into());
        }
        let metadata = std::fs::metadata(&path).map_err(|e| format!("预览文件不可用：{e}"))?;
        if metadata.len() > super::replace::MAX_FILE as u64 {
            return Err("文件超过 10 MiB 预览预算".into());
        }
        let position = self.entries.iter().position(|entry| {
            entry.owner == owner
                && entry.path == path
                && entry.len == metadata.len()
                && entry.modified == metadata.modified().ok()
        });
        let entry = if let Some(position) = position {
            self.entries.remove(position).unwrap()
        } else {
            let (bytes, version, _) =
                crate::files::read_disk(&path).map_err(|e| format!("读取预览失败：{e}"))?;
            if crate::files::media::is_media_content(&bytes) {
                return Err("不能预览二进制或媒体内容".into());
            }
            let text = crate::files::codec::decode_with_path(&bytes, None, Some(&path))
                .map_err(|e| format!("文件无法解码：{e}"))?
                .0
                .replace("\r\n", "\n")
                .replace('\r', "\n");
            Entry {
                owner: owner.into(),
                path: path.clone(),
                version,
                text,
                len: metadata.len(),
                modified: metadata.modified().ok(),
            }
        };
        if entry.version != request.version {
            return Err("文件已被外部修改，搜索预览已过期，请重新搜索".into());
        }
        let result = window(&entry.text, request);
        self.entries.push_front(entry);
        while self.entries.len() > 2
            || self.entries.iter().map(|e| e.text.len()).sum::<usize>() > 16 * 1024 * 1024
        {
            self.entries.pop_back();
        }
        result
    }
}
fn byte_at_utf16(text: &str, offset: usize) -> Option<usize> {
    let mut count = 0;
    for (byte, ch) in text.char_indices() {
        if count == offset {
            return Some(byte);
        }
        count += ch.len_utf16();
        if count > offset {
            return None;
        }
    }
    (count == offset).then_some(text.len())
}
pub fn window(text: &str, request: &PreviewRequest) -> Result<SourcePreview, String> {
    if request.line == 0 {
        return Err("搜索行号已过期".into());
    }
    let mut before = VecDeque::with_capacity(20);
    let mut offset = 0;
    let mut target = None;
    let mut from = 0;
    let mut to = text.len();
    for (index, line) in text.split('\n').enumerate() {
        let number = index + 1;
        if number < request.line {
            before.push_back(offset);
            if before.len() > 20 {
                before.pop_front();
            }
        }
        if number == request.line {
            from = before.front().copied().unwrap_or(offset);
            target = Some((offset, offset + line.len()));
        }
        if number >= request.line.saturating_add(21) {
            to = offset + line.len();
            break;
        }
        offset += line.len() + 1;
    }
    let (line_start, line_end) = target.ok_or("搜索行号已过期")?;
    let local = byte_at_utf16(
        &text[line_start..line_end],
        request.column.saturating_sub(1),
    )
    .ok_or("搜索列号已过期")?;
    let anchor = line_start + local;
    let regex = compile_query(&request.query)?;
    if !regex
        .find_iter(&text[line_start..line_end])
        .any(|m| m.start() == local && m.as_str().encode_utf16().count() == request.length)
    {
        return Err("当前位置与搜索命中不一致，请重新搜索".into());
    }
    let mut truncated = false;
    if to - from > 256 * 1024 {
        truncated = true;
        from = anchor.saturating_sub(64 * 1024);
        while !text.is_char_boundary(from) {
            from += 1;
        }
        to = (from + 256 * 1024).min(text.len());
        while !text.is_char_boundary(to) {
            to -= 1;
        }
    }
    let snippet = &text[from..to];
    let mut hits = Vec::new();
    let mut previous = from;
    let mut units = 0;
    let mut line_start = text[..from].rfind('\n').map_or(0, |index| index + 1);
    for line in text[line_start..].split('\n') {
        if line_start > to {
            break;
        }
        for matched in regex.find_iter(line) {
            if hits.len() >= 1000 {
                break;
            }
            let begin = line_start + matched.start();
            let finish = line_start + matched.end();
            if begin >= from && finish <= to {
                units += text[previous..begin].encode_utf16().count();
                let length = matched.as_str().encode_utf16().count();
                hits.push(PreviewHit {
                    from: units,
                    to: units + length,
                });
                units += length;
                previous = finish;
            }
        }
        line_start += line.len() + 1;
    }
    let selection_from = text[from..anchor].encode_utf16().count();
    Ok(SourcePreview {
        path: request.path.clone(),
        version: request.version.clone(),
        text: snippet.into(),
        start_line: text[..from].bytes().filter(|b| *b == b'\n').count() + 1,
        selection_from,
        selection_to: (selection_from + request.length).min(snippet.encode_utf16().count()),
        hits,
        truncated,
    })
}
