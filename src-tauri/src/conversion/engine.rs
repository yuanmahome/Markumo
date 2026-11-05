use super::{Operation, Purpose, Result, MAX_OUTPUT, MAX_TEXT};
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};

pub fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path).map_err(|e| format!("打开转换文件失败: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(format!(
            "转换文件超过 {} MiB 或不是普通文件",
            limit / (1024 * 1024)
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("转换文件读取期间超过上限".into());
    }
    Ok(bytes)
}

pub fn validate_docx(bytes: &[u8]) -> Result<()> {
    let mut package = super::docx::read_package(bytes)?;
    package.main_part(&|| Ok(()))?;
    Ok(())
}

pub fn commit_import(
    op: &Operation,
    document: super::docx::ast::NativeDocument,
) -> Result<super::ImportSummary> {
    op.verify(0)?;
    op.verify(1)?;
    if op.path(0) == op.path(1) {
        return Err("导入来源和目标不能相同".into());
    }
    if !op
        .path(1)
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|s| matches!(s.to_ascii_lowercase().as_str(), "md" | "markdown"))
    {
        return Err("导入目标必须为 .md 或 .markdown".into());
    }
    let stem = op
        .path(1)
        .file_stem()
        .ok_or("无效 Markdown 文件名")?
        .to_string_lossy();
    let base_name = format!("{stem}.assets");
    crate::workspace::guard::validate_name(&base_name)?;
    let batch = format!("import-{}", super::random_id()?);
    let markdown = super::docx::markdown::serialize(&document, &format!("{base_name}/{batch}"))?;
    let parent = op.path(1).parent().ok_or("缺少目标目录")?;
    let mut assets = AssetBatch::new(
        parent,
        &parent.join(&base_name),
        &batch,
        !document.assets.is_empty(),
    )?;
    if let Some(directory) = assets.directory.as_ref() {
        for (name, bytes) in &document.assets {
            op.check()?;
            crate::workspace::guard::validate_name(name)?;
            let path = directory.path().join(name);
            crate::workspace::guard::validate_under_root(parent, &path)
                .map_err(|e| e.to_string())?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            std::io::copy(&mut bytes.as_slice(), &mut file).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
    }
    op.verify(0)?;
    op.commit(1, markdown.as_bytes())?;
    assets.keep();
    Ok(super::ImportSummary {
        path: op.path(1).to_string_lossy().into_owned(),
        warnings: document.warnings,
        stats: document.stats,
    })
}
struct AssetBatch {
    directory: Option<tempfile::TempDir>,
    created_base: Option<PathBuf>,
}
impl AssetBatch {
    fn new(parent: &Path, base: &Path, batch: &str, needed: bool) -> Result<Self> {
        let mut result = Self {
            directory: None,
            created_base: None,
        };
        if !needed {
            return Ok(result);
        }
        if !base.exists() {
            fs::create_dir(base).map_err(|e| e.to_string())?;
            result.created_base = Some(base.into());
        }
        crate::workspace::guard::validate_under_root(parent, base).map_err(|e| e.to_string())?;
        result.directory = Some(
            tempfile::Builder::new()
                .prefix(batch)
                .rand_bytes(0)
                .tempdir_in(base)
                .map_err(|e| e.to_string())?,
        );
        Ok(result)
    }
    fn keep(&mut self) {
        if let Some(d) = self.directory.take() {
            let _ = d.keep();
        }
        self.created_base = None;
    }
}
impl Drop for AssetBatch {
    fn drop(&mut self) {
        if let Some(d) = self.directory.take() {
            if let Err(error) = d.close() {
                eprintln!("导入失败后的媒体清理失败（保留孤立资源，旧 Markdown 未改动）: {error}");
            }
        }
        if let Some(base) = &self.created_base {
            let _ = fs::remove_dir(base);
        }
    }
}

pub fn save_binary(op: &Operation, bytes: &[u8]) -> Result<()> {
    match op.leases[0].purpose {
        Purpose::Html => {
            if bytes.is_empty() || std::str::from_utf8(bytes).is_err() {
                return Err("HTML 输出为空或不是 UTF-8".into());
            }
        }
        Purpose::Png => {
            if !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
                || crate::files::images::dimensions(bytes).is_none()
            {
                return Err("PNG 输出格式无效".into());
            }
        }
        Purpose::Docx => {
            validate_docx(bytes)?;
        }
        _ => return Err("二进制导出只允许 HTML/PNG/DOCX 授权".into()),
    }
    op.commit(0, bytes)
}
pub fn read_html(op: &Operation) -> Result<String> {
    op.verify(0)?;
    let bytes = read_bounded(op.path(0), MAX_TEXT)?;
    op.verify(0)?;
    String::from_utf8(bytes)
        .map(|s| s.trim_start_matches('\u{feff}').to_owned())
        .map_err(|e| format!("HTML 必须为 UTF-8: {e}"))
}
pub fn validate_pdf(bytes: &[u8]) -> Result<()> {
    if bytes.len() < 16
        || !bytes.starts_with(b"%PDF-")
        || !bytes[bytes.len().saturating_sub(1024)..]
            .windows(5)
            .any(|x| x == b"%%EOF")
    {
        return Err("打印未生成完整有效的 PDF".into());
    }
    Ok(())
}
/// Used by the native renderer. Every return drops renderer
/// resources before final validation or submission of a partial PDF.
pub fn export_pdf(op: &Operation, render: impl FnOnce(&Path) -> Result<()>) -> Result<()> {
    op.verify(0)?;
    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
    let output = work.path().join("result.pdf");
    render(&output)?;
    op.check()?;
    let bytes = read_bounded(&output, MAX_OUTPUT)?;
    validate_pdf(&bytes)?;
    op.commit(0, &bytes)
}
#[cfg(windows)]
pub struct Cleanup<F: FnOnce()>(Option<F>);
#[cfg(windows)]
impl<F: FnOnce()> Cleanup<F> {
    pub fn new(f: F) -> Self {
        Self(Some(f))
    }
}
#[cfg(windows)]
impl<F: FnOnce()> Drop for Cleanup<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

#[cfg(windows)]
pub fn print_html(html: &str) -> Result<String> {
    if html.len() > MAX_TEXT {
        return Err("打印 HTML 超过 16 MiB".into());
    }
    // First policy applies before any untrusted element; later policies cannot
    // relax it. Keep CSS/fonts/HTTPS images and the existing WebView2 layout.
    Ok(format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; script-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'\">{html}"))
}
