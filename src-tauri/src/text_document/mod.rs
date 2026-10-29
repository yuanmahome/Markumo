//! Experimental disk-backed text engine (feature `segmented-prototype`).
//!
//! No production command is registered. UTF-8/BOM only at this stage: unsupported
//! encodings fail explicitly, and save creates a new file without overwriting.
//! The stable path retains its encoding, identity, history and conflict behavior.
mod line_index;
mod pieces;
mod search;
pub use line_index::Position;
use pieces::{Span, Store, Tree};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub const WINDOW_BYTES: usize = 256 * 1024;
pub const IO_BYTES: usize = 64 * 1024;
pub const EDIT_BYTES: usize = 1024 * 1024;
const CHECKPOINT_BYTES: u64 = 8 * 1024 * 1024;
fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}
fn cancelled(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Relaxed) {
        // write_all/BufWriter retry Interrupted. Cancellation is permanent,
        // unlike a transient OS signal, and must propagate without retry.
        Err(io::Error::other("任务已取消，未提交"))
    } else {
        Ok(())
    }
}
#[derive(Debug, Serialize, Deserialize)]
struct Checkpoint {
    schema: u32,
    source: PathBuf,
    source_hash: String,
    bom: bool,
    revision: u64,
    roots: Vec<Vec<Span>>,
    head: usize,
    base_hash: String,
    added_hash: String,
    added_len: u64,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    pub revision: u64,
    pub start_byte: u64,
    pub end_byte: u64,
    pub text: String,
}
#[derive(Debug)]
pub struct Edit<'a> {
    pub from: u64,
    pub to: u64,
    pub insert: &'a str,
}
#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub count: u64,
    pub matches: Vec<(u64, u64)>,
}

/// A session owns two disk stores and a sequence of structurally shared AVL
/// roots. Saving/reading never constructs a complete String. Closing drops file
/// handles, retaining the explicit durable checkpoint; discard removes assets.
pub struct Session {
    directory: PathBuf,
    source: PathBuf,
    source_hash: String,
    bom: bool,
    base: File,
    added: File,
    roots: Vec<Tree>,
    head: usize,
    revision: u64,
    index: Option<line_index::Index>,
}
impl Session {
    pub fn open(source: &Path, workspace: &Path, cancel: &AtomicBool) -> io::Result<Self> {
        let source = fs::canonicalize(source)?;
        let mut input = File::open(&source)?;
        let before = input.metadata()?;
        if !before.is_file() {
            return Err(invalid("只支持普通文件"));
        }
        fs::create_dir_all(workspace)?;
        let directory = tempfile::Builder::new()
            .prefix("segmented-")
            .tempdir_in(workspace)?;
        let mut base = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(directory.path().join("base"))?;
        let added = OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(directory.path().join("added"))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0; IO_BYTES];
        let mut carry = Vec::new();
        let mut copied = 0u64;
        let mut bom = false;
        loop {
            cancelled(cancel)?;
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
            let skip = if copied == 0 && buffer[..n].starts_with(b"\xef\xbb\xbf") {
                bom = true;
                3
            } else {
                0
            };
            carry.extend_from_slice(&buffer[skip..n]);
            match std::str::from_utf8(&carry) {
                Ok(text) => {
                    if text.contains('\0') {
                        return Err(invalid("原型不支持 NUL/二进制"));
                    }
                    carry.clear();
                }
                Err(e) if e.error_len().is_none() => {
                    let at = e.valid_up_to();
                    if carry[..at].contains(&0) {
                        return Err(invalid("原型不支持 NUL/二进制"));
                    }
                    carry.drain(..at);
                }
                Err(_) => return Err(invalid("分段原型仅支持严格 UTF-8/BOM；请使用稳定编码路径")),
            }
            base.write_all(&buffer[skip..n])?;
            copied += n as u64;
        }
        if !carry.is_empty() {
            return Err(invalid("文件以不完整 UTF-8 字符结尾"));
        }
        let after = input.metadata()?;
        let source_hash = format!("{:x}", hasher.finalize());
        if before.len() != after.len()
            || before.modified()? != after.modified()?
            || file_hash(&source, cancel)? != source_hash
        {
            return Err(invalid("读取期间源文件改变，未建立会话"));
        }
        base.sync_all()?;
        let root = pieces::leaf(Span {
            store: Store::Base,
            offset: 0,
            len: base.metadata()?.len(),
        });
        let directory = directory.keep();
        Ok(Self {
            directory,
            source,
            source_hash,
            bom,
            base,
            added,
            roots: vec![root],
            head: 0,
            revision: 0,
            index: None,
        })
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn byte_length(&self) -> u64 {
        pieces::len(self.tree())
    }
    pub fn can_undo(&self) -> bool {
        self.head > 0
    }
    pub fn can_redo(&self) -> bool {
        self.head + 1 < self.roots.len()
    }
    fn tree(&self) -> &Tree {
        &self.roots[self.head]
    }
    fn check_revision(&self, revision: u64) -> io::Result<()> {
        if revision != self.revision {
            Err(invalid("revision 冲突，未修改文档"))
        } else {
            Ok(())
        }
    }
    pub fn external_changed(&self, cancel: &AtomicBool) -> io::Result<bool> {
        match file_hash(&self.source, cancel) {
            Ok(hash) => Ok(hash != self.source_hash),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(true),
            Err(e) => Err(e),
        }
    }
    fn read_tree(
        &mut self,
        tree: &Tree,
        from: u64,
        to: u64,
        output: &mut dyn Write,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        let mut buffer = vec![0; IO_BYTES];
        pieces::visit(tree, from, to, &mut |span| {
            let input = match span.store {
                Store::Base => &mut self.base,
                Store::Added => &mut self.added,
            };
            input.seek(SeekFrom::Start(span.offset))?;
            let mut remaining = span.len;
            while remaining > 0 {
                cancelled(cancel)?;
                let count = buffer.len().min(remaining as usize);
                input.read_exact(&mut buffer[..count])?;
                output.write_all(&buffer[..count])?;
                remaining -= count as u64;
            }
            Ok(())
        })
    }
    fn bytes(&mut self, from: u64, to: u64) -> io::Result<Vec<u8>> {
        if from > to || to > self.byte_length() || to - from > WINDOW_BYTES as u64 + 8 {
            return Err(invalid("读取超出窗口预算或文档边界"));
        }
        let tree = self.tree().clone();
        let mut out = Vec::with_capacity((to - from) as usize);
        self.read_tree(&tree, from, to, &mut out, &AtomicBool::new(false))?;
        Ok(out)
    }
    fn boundary(&mut self, at: u64) -> io::Result<bool> {
        Ok(at == self.byte_length() || self.bytes(at, at + 1)?[0] & 0xc0 != 0x80)
    }
    /// At most 256 KiB, rounded inward to UTF-8 scalar boundaries. No per-UTF16
    /// number[] is sent: the client maps only its bounded window.
    pub fn window(&mut self, revision: u64, start: u64, budget: usize) -> io::Result<Window> {
        self.check_revision(revision)?;
        if start > self.byte_length() || budget == 0 || budget > WINDOW_BYTES {
            return Err(invalid("无效窗口或超过 256 KiB 预算"));
        }
        let mut from = start;
        while from < self.byte_length() && !self.boundary(from)? {
            from += 1;
        }
        if from > 0 && from < self.byte_length() && self.bytes(from - 1, from + 1)? == b"\r\n" {
            from += 1;
        }
        let mut to = (start + budget as u64).min(self.byte_length()).max(from);
        while to > from && !self.boundary(to)? {
            to -= 1;
        }
        if to > from && to < self.byte_length() && self.bytes(to - 1, to + 1)? == b"\r\n" {
            to -= 1;
        }
        let text =
            String::from_utf8(self.bytes(from, to)?).map_err(|_| invalid("存储 UTF-8 损坏"))?;
        Ok(Window {
            revision,
            start_byte: from,
            end_byte: to,
            text,
        })
    }
    /// Edits use coordinates from one base revision, sorted and non-overlapping.
    /// Validation precedes append/commit. Failed I/O can leave unreachable tail
    /// bytes in Added, but never advances the canonical root or drops history.
    pub fn edit(&mut self, revision: u64, edits: &[Edit<'_>]) -> io::Result<u64> {
        self.check_revision(revision)?;
        let mut previous = 0;
        let mut inserted = 0usize;
        for e in edits {
            inserted = inserted
                .checked_add(e.insert.len())
                .ok_or_else(|| invalid("插入预算溢出"))?;
            if e.from < previous
                || e.from > e.to
                || e.to > self.byte_length()
                || inserted > EDIT_BYTES
                || e.insert.contains('\0')
                || !self.boundary(e.from)?
                || !self.boundary(e.to)?
            {
                return Err(invalid("编辑范围、UTF-8 边界或 1 MiB 插入预算无效"));
            }
            previous = e.to;
        }
        if edits.is_empty() {
            return Ok(self.revision);
        }
        let mut root = self.tree().clone();
        for e in edits.iter().rev() {
            let offset = self.added.seek(SeekFrom::End(0))?;
            self.added.write_all(e.insert.as_bytes())?;
            root = pieces::replace(
                &root,
                e.from,
                e.to,
                pieces::leaf(Span {
                    store: Store::Added,
                    offset,
                    len: e.insert.len() as u64,
                }),
            );
        }
        self.roots.truncate(self.head + 1); // only redo branches after a new edit
        self.roots.push(root);
        self.head += 1;
        self.revision += 1;
        self.index = None;
        Ok(self.revision)
    }
    pub fn undo(&mut self, revision: u64) -> io::Result<u64> {
        self.check_revision(revision)?;
        if self.can_undo() {
            self.head -= 1;
            self.revision += 1;
            self.index = None;
        }
        Ok(self.revision)
    }
    pub fn redo(&mut self, revision: u64) -> io::Result<u64> {
        self.check_revision(revision)?;
        if self.can_redo() {
            self.head += 1;
            self.revision += 1;
            self.index = None;
        }
        Ok(self.revision)
    }
    /// Literal, case-sensitive UTF-8 search. The result page is capped at 1024;
    /// the count scans the entire immutable revision with a bounded KMP state.
    pub fn search(
        &mut self,
        revision: u64,
        query: &str,
        start: u64,
        limit: usize,
        cancel: &AtomicBool,
    ) -> io::Result<SearchResult> {
        self.check_revision(revision)?;
        let mut matcher = search::Matcher::new(query, start, limit)?;
        let tree = self.tree().clone();
        self.read_tree(&tree, 0, pieces::len(&tree), &mut matcher, cancel)?;
        Ok(matcher.result())
    }
    /// Full-file replacement streams into a temporary file, then into Added.
    /// One root commits the result and Undo shares the old root. This trades
    /// disk I/O for bounded task memory without collecting all match offsets.
    pub fn replace_all(
        &mut self,
        revision: u64,
        query: &str,
        replacement: &str,
        cancel: &AtomicBool,
    ) -> io::Result<u64> {
        self.check_revision(revision)?;
        if replacement.len() > EDIT_BYTES || replacement.contains('\0') {
            return Err(invalid("替换文本超预算或含 NUL"));
        }
        let mut output = tempfile::NamedTempFile::new_in(&self.directory)?;
        let count = {
            let max = self
                .byte_length()
                .saturating_add(512 * 1024 * 1024)
                .min(self.byte_length().saturating_mul(8).max(1024 * 1024));
            let writer = io::BufWriter::with_capacity(
                IO_BYTES,
                TaskWriter {
                    writer: output.as_file_mut(),
                    written: 0,
                    max,
                    cancel,
                },
            );
            let mut replacer = search::Replacer::new(query, replacement, writer)?;
            let tree = self.tree().clone();
            self.read_tree(&tree, 0, pieces::len(&tree), &mut replacer, cancel)?;
            replacer.finish()?
        };
        if count == 0 {
            return Ok(self.revision);
        }
        cancelled(cancel)?;
        let length = output.as_file().metadata()?.len();
        output.as_file_mut().seek(SeekFrom::Start(0))?;
        let offset = self.added.seek(SeekFrom::End(0))?;
        let mut buffer = vec![0; IO_BYTES];
        loop {
            cancelled(cancel)?;
            let n = output.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            self.added.write_all(&buffer[..n])?;
        }
        cancelled(cancel)?;
        self.roots.truncate(self.head + 1);
        self.roots.push(pieces::leaf(Span {
            store: Store::Added,
            offset,
            len: length,
        }));
        self.head += 1;
        self.revision += 1;
        self.index = None;
        Ok(self.revision)
    }
    fn ensure_index(&mut self, cancel: &AtomicBool) -> io::Result<()> {
        if self.index.is_none() {
            let tree = self.tree().clone();
            let mut scanner = line_index::Scanner::new(pieces::len(&tree));
            self.read_tree(&tree, 0, pieces::len(&tree), &mut scanner, cancel)?;
            self.index = Some(scanner.finish()?);
        }
        Ok(())
    }
    pub fn position(
        &mut self,
        revision: u64,
        byte: u64,
        cancel: &AtomicBool,
    ) -> io::Result<Position> {
        self.check_revision(revision)?;
        if byte > self.byte_length() || !self.boundary(byte)? {
            return Err(invalid("无效 UTF-8 字节位置"));
        }
        self.ensure_index(cancel)?;
        let at = *self
            .index
            .as_ref()
            .unwrap()
            .points
            .iter()
            .rev()
            .find(|p| p.byte <= byte)
            .unwrap();
        let tree = self.tree().clone();
        let mut scanner = line_index::Scanner::at(at);
        self.read_tree(&tree, at.byte, byte, &mut scanner, cancel)?;
        Ok(scanner.finish()?.end)
    }
    pub fn line_start(&mut self, revision: u64, line: u64, cancel: &AtomicBool) -> io::Result<u64> {
        self.check_revision(revision)?;
        if line == 0 {
            return Err(invalid("行号从 1 开始"));
        }
        self.ensure_index(cancel)?;
        let index = self.index.as_ref().unwrap();
        if line > index.end.line {
            return Err(invalid("行号超出文档"));
        }
        if line == 1 {
            return Ok(0);
        }
        let at = *index
            .points
            .iter()
            .rev()
            .find(|p| p.line < line)
            .unwrap_or(&index.points[0]);
        let tree = self.tree().clone();
        let mut finder = line_index::LineFinder::new(at, line);
        match self.read_tree(&tree, at.byte, pieces::len(&tree), &mut finder, cancel) {
            Err(e) if e.kind() == io::ErrorKind::WouldBlock && finder.found.is_some() => {}
            other => other?,
        }
        finder
            .found
            .or_else(|| (finder.at.line == line).then_some(finder.at.byte))
            .ok_or_else(|| invalid("无法定位该行"))
    }
    /// Prototype Save Copy: never overwrites an existing file (including the
    /// source). Original-path identity-preserving save is a separate gate.
    pub fn save_copy(
        &mut self,
        target: &Path,
        revision: u64,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        self.check_revision(revision)?;
        let mut output = tempfile::NamedTempFile::new_in(
            target.parent().ok_or_else(|| invalid("缺少保存目录"))?,
        )?;
        if self.bom {
            output.write_all(b"\xef\xbb\xbf")?;
        }
        let tree = self.tree().clone();
        self.read_tree(&tree, 0, pieces::len(&tree), output.as_file_mut(), cancel)?;
        output.as_file().sync_all()?;
        cancelled(cancel)?;
        output.persist_noclobber(target).map_err(|e| e.error)?;
        Ok(())
    }
    /// A durable checkpoint contains every undo/redo root and the store hashes.
    /// It is streaming JSON with an explicit metadata budget, never full text.
    pub fn checkpoint(&mut self, cancel: &AtomicBool) -> io::Result<()> {
        cancelled(cancel)?;
        self.added.sync_all()?;
        let mut entries = self.roots.len() as u64;
        if entries > CHECKPOINT_BYTES / 128 {
            return Err(invalid("checkpoint 历史根预算不足，当前历史未裁剪"));
        }
        for root in &self.roots {
            pieces::visit(root, 0, pieces::len(root), &mut |_| {
                cancelled(cancel)?;
                entries += 1;
                if entries > CHECKPOINT_BYTES / 128 {
                    return Err(invalid("checkpoint 片段预算不足，当前历史未裁剪"));
                }
                Ok(())
            })?;
        }
        let state = Checkpoint {
            schema: 1,
            source: self.source.clone(),
            source_hash: self.source_hash.clone(),
            bom: self.bom,
            revision: self.revision,
            roots: self.roots.iter().map(pieces::spans).collect(),
            head: self.head,
            base_hash: file_hash(&self.directory.join("base"), cancel)?,
            added_hash: file_hash(&self.directory.join("added"), cancel)?,
            added_len: self.added.metadata()?.len(),
        };
        let mut file = tempfile::NamedTempFile::new_in(&self.directory)?;
        serde_json::to_writer(
            &mut LimitedWriter {
                writer: file.as_file_mut(),
                left: CHECKPOINT_BYTES,
            },
            &state,
        )?;
        file.as_file().sync_all()?;
        cancelled(cancel)?;
        file.persist(self.directory.join("checkpoint.json"))
            .map_err(|e| e.error)?;
        Ok(())
    }
    pub fn checkpoint_at(&mut self, revision: u64, cancel: &AtomicBool) -> io::Result<()> {
        self.check_revision(revision)?;
        self.checkpoint(cancel)
    }
    pub fn restore(directory: &Path, cancel: &AtomicBool) -> io::Result<Self> {
        let directory = fs::canonicalize(directory)?;
        for name in ["base", "added", "checkpoint.json"] {
            if fs::symlink_metadata(directory.join(name))?
                .file_type()
                .is_symlink()
            {
                return Err(invalid("拒绝会话资产链接"));
            }
        }
        let mut input = File::open(directory.join("checkpoint.json"))?;
        if input.metadata()?.len() > CHECKPOINT_BYTES {
            return Err(invalid("恢复元数据超预算"));
        }
        let mut text = String::new();
        input.read_to_string(&mut text)?;
        let state: Checkpoint = serde_json::from_str(&text)?;
        if state.schema != 1 || state.roots.is_empty() || state.head >= state.roots.len() {
            return Err(invalid("恢复版本或历史索引无效"));
        }
        let base = File::open(directory.join("base"))?;
        let added = OpenOptions::new()
            .read(true)
            .write(true)
            .open(directory.join("added"))?;
        if added.metadata()?.len() < state.added_len
            || file_hash(&directory.join("base"), cancel)? != state.base_hash
            || hash_prefix(&directory.join("added"), state.added_len, cancel)? != state.added_hash
        {
            return Err(invalid("恢复资产与 checkpoint 不匹配，保留资产供人工恢复"));
        }
        let base_len = base.metadata()?.len();
        let add_len = state.added_len;
        for spans in &state.roots {
            let mut total = 0u64;
            for s in spans {
                total = total
                    .checked_add(s.len)
                    .ok_or_else(|| invalid("长度溢出"))?;
                if s.offset.checked_add(s.len).is_none_or(|end| {
                    end > if s.store == Store::Base {
                        base_len
                    } else {
                        add_len
                    }
                }) {
                    return Err(invalid("恢复片段超出存储边界"));
                }
            }
        }
        Ok(Self {
            directory,
            source: state.source,
            source_hash: state.source_hash,
            bom: state.bom,
            base,
            added,
            roots: state.roots.iter().map(|s| pieces::from_spans(s)).collect(),
            head: state.head,
            revision: state.revision,
            index: None,
        })
    }
    /// Explicit discard only. Remove known owned assets, never recursively delete
    /// a supplied recovery directory or follow an arbitrary path from JSON.
    pub fn discard(self) -> io::Result<()> {
        let Self {
            directory,
            base,
            added,
            ..
        } = self;
        drop(base);
        drop(added);
        for name in ["base", "added", "checkpoint.json"] {
            match fs::remove_file(directory.join(name)) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
        }
        fs::remove_dir(directory)
    }
}
struct LimitedWriter<'a> {
    writer: &'a mut File,
    left: u64,
}
struct TaskWriter<'a> {
    writer: &'a mut File,
    written: u64,
    max: u64,
    cancel: &'a AtomicBool,
}
impl Write for TaskWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        cancelled(self.cancel)?;
        if self.written.saturating_add(bytes.len() as u64) > self.max {
            return Err(invalid("替换输出超出原型增长预算，原文未改变"));
        }
        let n = self.writer.write(bytes)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        cancelled(self.cancel)?;
        self.writer.flush()
    }
}
impl Write for LimitedWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() as u64 > self.left {
            return Err(invalid("checkpoint 超出 8 MiB 元数据预算；当前编辑仍保留"));
        }
        let n = self.writer.write(bytes)?;
        self.left -= n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}
fn file_hash(path: &Path, cancel: &AtomicBool) -> io::Result<String> {
    hash_prefix(path, u64::MAX, cancel)
}
fn hash_prefix(path: &Path, length: u64, cancel: &AtomicBool) -> io::Result<String> {
    let mut file = File::open(path)?.take(length);
    let mut buffer = vec![0; IO_BYTES];
    let mut hash = Sha256::new();
    loop {
        cancelled(cancel)?;
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
#[cfg(test)]
mod tests;
