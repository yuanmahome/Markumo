use super::{Operation, Purpose, Result, MAX_MEDIA, MAX_MEDIA_FILES, MAX_OUTPUT, MAX_TEXT};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

pub fn pandoc_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let command = Command::new(program);
    #[cfg(windows)]
    let mut command = command;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
}

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

pub trait Runner {
    fn run(&self, command: &mut Command, op: &Operation, work: &Path) -> Result<()>;
}
pub struct NativeRunner;
impl Runner for NativeRunner {
    fn run(&self, command: &mut Command, op: &Operation, work: &Path) -> Result<()> {
        op.check()?;
        let stdout = tempfile::NamedTempFile::new_in(work).map_err(|e| e.to_string())?;
        let stderr = tempfile::NamedTempFile::new_in(work).map_err(|e| e.to_string())?;
        command
            .current_dir(work)
            .stdin(Stdio::null())
            .stdout(stdout.reopen().map_err(|e| e.to_string())?)
            .stderr(stderr.reopen().map_err(|e| e.to_string())?);
        let mut child = command
            .spawn()
            .map_err(|e| format!("启动转换进程失败: {e}"))?;
        let result = (|| loop {
            op.check()?;
            if stdout
                .as_file()
                .metadata()
                .map_err(|e| e.to_string())?
                .len()
                > 1024 * 1024
                || stderr
                    .as_file()
                    .metadata()
                    .map_err(|e| e.to_string())?
                    .len()
                    > 1024 * 1024
                || directory_size(work)? > 128 * 1024 * 1024
            {
                return Err("转换临时输出超过预算".into());
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if status.success() {
                    return op.check();
                }
                let mut detail = String::new();
                stderr
                    .reopen()
                    .map_err(|e| e.to_string())?
                    .take(8192)
                    .read_to_string(&mut detail)
                    .map_err(|e| e.to_string())?;
                if detail.contains("Could not find data file") {
                    return Err(format!("Pandoc 当前构建缺少 sandbox 所需的内嵌数据，请安装 pandoc.org 官方构建。原目标未改动。详情: {detail}"));
                }
                return Err(format!("Pandoc 转换失败 ({status}): {detail}"));
            }
            std::thread::sleep(Duration::from_millis(20));
        })();
        if result.is_err() {
            let _ = child.kill();
            child.wait().map_err(|e| format!("终止转换进程失败: {e}"))?;
        }
        result
    }
}
fn directory_size(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err("转换临时目录出现链接".into());
        }
        total = total.saturating_add(if meta.is_dir() {
            directory_size(&entry.path())?
        } else {
            meta.len()
        });
    }
    Ok(total)
}

fn convert(
    runner: &impl Runner,
    exe: &Path,
    op: &Operation,
    from: &str,
    to: &str,
    input: &Path,
    output: &Path,
) -> Result<()> {
    let mut cmd = pandoc_command(exe);
    // No user filters/defaults, includes, extraction paths, or executable flags.
    cmd.args([
        "--sandbox",
        "--fail-if-warnings",
        "-f",
        from,
        "-t",
        to,
        "--wrap=none",
        "-o",
    ])
    .arg(output)
    .arg(input);
    runner.run(&mut cmd, op, input.parent().ok_or("缺少临时目录")?)
}
fn json_file(path: &Path) -> Result<Value> {
    serde_json::from_slice(&read_bounded(path, MAX_TEXT * 4)?)
        .map_err(|e| format!("无效的 Pandoc 文档树: {e}"))
}
fn write_json(path: &Path, value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_TEXT * 4 {
        return Err("转换文档树超过 64 MiB".into());
    }
    fs::write(path, bytes).map_err(|e| e.to_string())
}
fn images(value: &mut Value, action: &mut impl FnMut(&str) -> Result<String>) -> Result<()> {
    if value.get("t").and_then(Value::as_str) == Some("Image") {
        let source = value
            .pointer("/c/2/0")
            .and_then(Value::as_str)
            .ok_or("无效的图片节点")?;
        let replacement = action(source)?;
        value["c"][2][0] = Value::String(replacement);
    }
    match value {
        Value::Array(values) => {
            for value in values {
                images(value, action)?
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                images(value, action)?
            }
        }
        _ => {}
    }
    Ok(())
}
fn image_mime(bytes: &[u8]) -> Result<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Ok("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Ok("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Ok("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Ok("image/webp")
    } else if bytes.starts_with(b"BM") {
        Ok("image/bmp")
    } else if bytes.starts_with(b"II*\0") || bytes.starts_with(b"MM\0*") {
        Ok("image/tiff")
    } else if std::str::from_utf8(bytes).is_ok_and(|s| s.contains("<svg")) {
        Ok("image/svg+xml")
    } else {
        Err("Word 资源不是支持的图片".into())
    }
}

pub fn export_docx(
    op: &Operation,
    markdown: &str,
    exe: &Path,
    runner: &impl Runner,
    mut local: impl FnMut(&str) -> Result<Vec<u8>>,
) -> Result<()> {
    op.verify(0)?;
    if markdown.len() > MAX_TEXT {
        return Err("Markdown 超过 16 MiB".into());
    }
    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = work.path().join("input.md");
    let ast = work.path().join("document.json");
    let output = work.path().join("result.docx");
    fs::write(&input, markdown).map_err(|e| e.to_string())?;
    convert(runner, exe, op, "gfm", "json", &input, &ast)?;
    let mut tree = json_file(&ast)?;
    let mut count = 0;
    let mut total = 0u64;
    images(&mut tree, &mut |source| {
        op.check()?;
        count += 1;
        if count > MAX_MEDIA_FILES {
            return Err("Word 图片超过 256 张".into());
        }
        let bytes = if let Some(data) = source.strip_prefix("data:") {
            let (kind, encoded) = data.split_once(',').ok_or("无效的内嵌图片")?;
            if !kind.starts_with("image/")
                || !kind.ends_with(";base64")
                || encoded.len() > 6 * 1024 * 1024
            {
                return Err("内嵌图片格式或大小无效".into());
            }
            STANDARD.decode(encoded).map_err(|e| e.to_string())?
        } else if source.starts_with("https://") || source.starts_with("http://") {
            super::remote::fetch_remote_image(op, source)?
        } else {
            local(source)?
        };
        if bytes.len() as u64 > MAX_MEDIA {
            return Err("Word 单张图片超过 64 MiB 上限".into());
        }
        total += bytes.len() as u64;
        if total > MAX_MEDIA {
            return Err("Word 图片总量超过 64 MiB".into());
        }
        Ok(format!(
            "data:{};base64,{}",
            image_mime(&bytes)?,
            STANDARD.encode(&bytes)
        ))
    })?;
    write_json(&ast, &tree)?;
    convert(runner, exe, op, "json", "docx", &ast, &output)?;
    let bytes = read_bounded(&output, MAX_OUTPUT)?;
    validate_docx(&bytes)?;
    op.commit(0, &bytes)
}

/// Validate archive member names before any converter sees an untrusted DOCX.
/// We never ask Pandoc to extract to the filesystem; only native bounded copies
/// of members below word/media are written into an owned staging directory.
pub fn safe_member(name: &str) -> Result<PathBuf> {
    if name.is_empty() || name.contains(['\\', ':', '\0']) {
        return Err("DOCX 资源路径无效".into());
    }
    let path = Path::new(name);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
        || path.is_absolute()
    {
        return Err("DOCX 资源路径越界".into());
    }
    for part in path.components() {
        crate::workspace::guard::validate_name(&part.as_os_str().to_string_lossy())?;
    }
    Ok(path.into())
}
pub fn validate_docx(bytes: &[u8]) -> Result<()> {
    docx_media(bytes, false).map(|_| ())
}
fn docx_media(bytes: &[u8], collect: bool) -> Result<HashMap<String, Vec<u8>>> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("无效 DOCX 压缩包: {e}"))?;
    if zip.len() > 4096 {
        return Err("DOCX 包含过多条目".into());
    }
    let mut media = HashMap::new();
    let mut names = HashSet::new();
    let mut total = 0u64;
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(|e| e.to_string())?;
        safe_member(file.name().trim_end_matches('/'))?;
        if file.is_symlink() {
            return Err("DOCX 不允许符号链接资源".into());
        }
        if !names.insert(file.name().to_owned()) {
            return Err("DOCX 存在重复资源".into());
        }
        total = total.checked_add(file.size()).ok_or("DOCX 体积溢出")?;
        if file.size() > MAX_OUTPUT as u64 || total > MAX_MEDIA {
            return Err("DOCX 解压总量超过 64 MiB 或单文件超过 16 MiB".into());
        }
        let retain = collect && file.name().starts_with("word/media/") && !file.is_dir();
        if retain {
            if media.len() >= MAX_MEDIA_FILES {
                return Err("DOCX 媒体超过 256 个".into());
            }
            let name = file.name().strip_prefix("word/").unwrap().to_owned();
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_OUTPUT as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() > MAX_OUTPUT || bytes.len() as u64 != file.size() {
                return Err("DOCX 媒体过大或解压长度不符".into());
            }
            media.insert(name, bytes);
        } else if !file.is_dir() {
            let declared = file.size();
            let actual = std::io::copy(
                &mut (&mut file).take(MAX_OUTPUT as u64 + 1),
                &mut std::io::sink(),
            )
            .map_err(|e| e.to_string())?;
            if actual > MAX_OUTPUT as u64 || actual != declared {
                return Err("DOCX 解压长度超过限制或不符".into());
            }
        }
    }
    if !names.contains("[Content_Types].xml") || !names.contains("word/document.xml") {
        return Err("DOCX 缺少必要结构".into());
    }
    Ok(media)
}

pub fn import_docx(op: &Operation, exe: &Path, runner: &impl Runner) -> Result<String> {
    op.verify(0)?;
    op.verify(1)?;
    if op.path(0) == op.path(1) {
        return Err("Word 来源和 Markdown 目标不能相同".into());
    }
    let source = read_bounded(op.path(0), MAX_OUTPUT)?;
    op.verify(0)?;
    let media = docx_media(&source, true)?;
    let work = tempfile::tempdir().map_err(|e| e.to_string())?;
    let input = work.path().join("input.docx");
    let ast = work.path().join("document.json");
    let output = work.path().join("result.md");
    fs::write(&input, &source).map_err(|e| e.to_string())?;
    convert(runner, exe, op, "docx", "json", &input, &ast)?;
    let mut tree = json_file(&ast)?;
    let stem = op
        .path(1)
        .file_stem()
        .ok_or("无效 Markdown 文件名")?
        .to_string_lossy();
    let base_name = format!("{stem}.assets");
    crate::workspace::guard::validate_name(&base_name)?;
    let batch = format!("import-{}", super::random_id()?);
    let mut used = HashSet::new();
    images(&mut tree, &mut |source| {
        if source.starts_with("https://") || source.starts_with("http://") {
            return Ok(source.into());
        }
        safe_member(source)?;
        if !media.contains_key(source) {
            return Err("DOCX 图片引用不在已验证的内嵌媒体中".into());
        }
        used.insert(source.to_owned());
        Ok(format!("{base_name}/{batch}/{source}"))
    })?;
    write_json(&ast, &tree)?;
    convert(runner, exe, op, "json", "gfm", &ast, &output)?;
    let markdown =
        String::from_utf8(read_bounded(&output, MAX_OUTPUT)?).map_err(|e| e.to_string())?;
    op.verify(0)?;
    op.verify(1)?;
    // Only this import's new directory is ever removed on failure. Existing
    // asset trees are not overwritten or renamed. Markdown is committed last.
    let parent = op.path(1).parent().ok_or("缺少目标目录")?;
    let base = parent.join(&base_name);
    let mut assets = AssetBatch::new(parent, &base, &batch, !used.is_empty())?;
    if let Some(directory) = assets.directory.as_ref() {
        for name in used {
            op.check()?;
            let relative = safe_member(&name)?;
            let target = directory.path().join(relative);
            fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(|e| e.to_string())?;
            let bytes = media.get(&name).ok_or("内嵌媒体丢失")?;
            #[cfg(test)]
            if super::tests::copy_fault() {
                return Err("injected media copy failure".into());
            }
            std::io::copy(&mut bytes.as_slice(), &mut file)
                .map_err(|e| format!("复制媒体失败: {e}"))?;
            file.sync_all().map_err(|e| format!("同步媒体失败: {e}"))?;
        }
        crate::workspace::guard::validate_under_root(parent, directory.path())
            .map_err(|e| e.to_string())?;
    }
    op.commit(1, markdown.as_bytes())?;
    assets.keep();
    Ok(markdown)
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
            if !bytes.starts_with(b"PK\x03\x04") {
                return Err("DOCX 输出格式无效，未检测到标准 PKZip 签名".into());
            }
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
/// Used by the native renderer and fault tests. Every return drops renderer
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
#[cfg(any(test, windows))]
pub struct Cleanup<F: FnOnce()>(Option<F>);
#[cfg(any(test, windows))]
impl<F: FnOnce()> Cleanup<F> {
    pub fn new(f: F) -> Self {
        Self(Some(f))
    }
}
#[cfg(any(test, windows))]
impl<F: FnOnce()> Drop for Cleanup<F> {
    fn drop(&mut self) {
        if let Some(f) = self.0.take() {
            f();
        }
    }
}

#[cfg(any(test, windows))]
pub fn print_html(html: &str) -> Result<String> {
    if html.len() > MAX_TEXT {
        return Err("打印 HTML 超过 16 MiB".into());
    }
    // First policy applies before any untrusted element; later policies cannot
    // relax it. Keep CSS/fonts/HTTPS images and the existing WebView2 layout.
    Ok(format!("<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline' data: https: http:; img-src data: https: http:; font-src data: https: http:; script-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'\">{html}"))
}
