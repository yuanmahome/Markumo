//! Document-scoped raster import and preview. Never expose general file writes.
use crate::display::display_path;
use super::{checked_path, fail, FileError, FileService, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::{
    fs,
    io::{Read, Write},
};

pub const MAX_IMAGE_FILE_BYTES: u64 = 100 * 1024 * 1024;
pub const MAX_CLIPBOARD_BYTES: usize = 50 * 1024 * 1024;
pub const MAX_SAFE_SINGLE_DIM: u32 = 65_535;
pub const MAX_SAFE_PIXELS: u64 = 150_000_000;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub token: String,
    pub name: String,
    pub is_directory: bool,
}

#[cfg(test)]
mod dropped_directory_tests {
    use super::*;

    #[test]
    fn dropped_directories_are_classified_and_open_as_workspace_roots() {
        let temporary = tempfile::tempdir().unwrap();
        // macOS's temporary directory may begin with /var -> /private/var.
        // Use its real path so these ordinary-directory fixtures do not test
        // the separate, intentional workspace symlink rejection policy.
        let root = temporary.path().canonicalize().unwrap();
        let folder = root.join("folder.png");
        let second = root.join("second");
        let file = root.join("note.md");
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(&second).unwrap();
        std::fs::write(&file, "# test").unwrap();
        let mut files = FileService::default();
        files.set_owner("main");
        let inputs = files.image_inputs(vec![folder.clone(), file, second.clone()]);
        assert!(inputs[0].is_directory);
        assert!(!inputs[1].is_directory);
        assert!(serde_json::to_value(&inputs[0]).unwrap()["isDirectory"]
            .as_bool()
            .unwrap());
        let mut workspace = crate::workspace::WorkspaceService::default();
        let info = workspace
            .add_workspace(files.take_dropped_directory(&inputs[0].token).unwrap())
            .unwrap();
        // The workspace root is reported in display form (no `\\?\` prefix), as
        // every UI-facing path is; compare the same spelling.
        assert_eq!(
            PathBuf::from(&info.root_path),
            PathBuf::from(crate::display::display_path(&folder.canonicalize().unwrap()))
        );
        workspace
            .add_workspace(files.take_dropped_directory(&inputs[2].token).unwrap())
            .unwrap();
        assert_eq!(workspace.roots().len(), 2);
        assert!(files.take_dropped_directory(&inputs[0].token).is_err());
        let batch = files.open_image_inputs(&[inputs[1].token.clone()]);
        assert_eq!(batch.files.len(), 1);
        assert!(batch.errors.is_empty());
    }

    #[test]
    fn dropped_directory_tokens_are_window_scoped_and_revocable() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut files = FileService::default();
        files.set_owner("main");
        let input = files.image_inputs(vec![root.clone()]).remove(0);
        files.set_owner("other");
        assert!(files.take_dropped_directory(&input.token).is_err());
        files.set_owner("main");
        assert!(files.take_dropped_directory("untrusted-token").is_err());
        assert!(files.take_dropped_directory(&input.token).is_ok());
        let input = files.image_inputs(vec![root]).remove(0);
        files.release_image_inputs(std::slice::from_ref(&input.token));
        assert!(files.take_dropped_directory(&input.token).is_err());
    }

    #[test]
    fn dropped_directory_is_revalidated_before_use() {
        let temporary = tempfile::tempdir().unwrap();
        let folder = temporary.path().canonicalize().unwrap().join("changed");
        std::fs::create_dir(&folder).unwrap();
        let mut files = FileService::default();
        let input = files.image_inputs(vec![folder.clone()]).remove(0);
        std::fs::remove_dir(&folder).unwrap();
        std::fs::write(&folder, "now a file").unwrap();
        assert!(files.take_dropped_directory(&input.token).is_err());
        assert!(files.take_dropped_directory(&input.token).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn replacing_a_dropped_directory_with_a_symlink_still_rejects_and_consumes_it() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let folder = root.join("changed");
        let target = root.join("target");
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(&target).unwrap();
        let mut files = FileService::default();
        let input = files.image_inputs(vec![folder.clone()]).remove(0);
        std::fs::remove_dir(&folder).unwrap();
        std::os::unix::fs::symlink(&target, &folder).unwrap();
        assert!(files.take_dropped_directory(&input.token).is_err());
        assert!(files.take_dropped_directory(&input.token).is_err());
    }

    #[test]
    fn hardlinked_images_are_rejected_consistently_with_other_files() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let original = root.join("original.png");
        std::fs::write(&original, b"\x89PNG\r\n\x1a\ntest").unwrap();
        let hardlink = root.join("hardlink.png");
        if std::fs::hard_link(&original, &hardlink).is_err() {
            return;
        }
        let error = read_raster(&hardlink).unwrap_err();
        assert_eq!(error.code, "image_scope");
        // Both directory entries now share one file identity.
        assert!(read_raster(&original).is_err());

        let single = root.join("single.png");
        std::fs::write(&single, b"\x89PNG\r\n\x1a\ntest").unwrap();
        assert!(read_raster(&single).is_ok());
    }

    #[test]
    fn markdown_image_reads_are_window_scoped_and_require_explicit_scope() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let notes = root.join("notes");
        let assets = notes.join("assets");
        std::fs::create_dir_all(&assets).unwrap();
        let document = notes.join("doc.md");
        std::fs::write(&document, "# note\n").unwrap();
        let inside = assets.join("inside.png");
        std::fs::write(&inside, b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00").unwrap();
        let outside_dir = root.join("outside");
        std::fs::create_dir(&outside_dir).unwrap();
        let outside = outside_dir.join("outside.png");
        std::fs::write(&outside, std::fs::read(&inside).unwrap()).unwrap();

        let mut files = FileService::default();
        files.set_owner("window-a");
        let token = files.open_selected(document, None).unwrap().metadata.token;
        assert!(files
            .markdown_image(&token, "assets/inside.png", &[], false)
            .is_ok());

        files.set_owner("window-b");
        assert!(files
            .markdown_image(&token, "assets/inside.png", &[], false)
            .is_err());
        files.set_owner("window-a");
        let absolute = outside.to_string_lossy().into_owned();
        assert!(files.markdown_image(&token, &absolute, &[], false).is_err());
        assert!(files
            .authorize_image_read(&token, &absolute, &outside)
            .is_ok());
        assert!(files.markdown_image(&token, &absolute, &[], false).is_ok());

        files.release(&token);
        assert!(files.image_reads.is_empty());
        assert!(files
            .markdown_image(&token, "assets/inside.png", &[], false)
            .is_err());
    }

    #[test]
    fn oversized_clipboard_image_payload_is_rejected_while_deserializing() {
        use serde::de::value::{Error as ValueError, SeqDeserializer};
        use serde::Deserialize;
        let oversized =
            SeqDeserializer::<_, ValueError>::new(std::iter::repeat_n(0u8, MAX_CLIPBOARD_BYTES + 1));
        assert!(ImageBytes::deserialize(oversized).is_err());

        let valid = SeqDeserializer::<_, ValueError>::new(vec![1u8, 2, 3].into_iter());
        assert_eq!(ImageBytes::deserialize(valid).unwrap().0, vec![1, 2, 3]);
    }

    #[test]
    fn svg_security_sanitization_rejects_scripts_and_external_resources() {
        let clean = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><circle cx=\"50\" cy=\"50\" r=\"40\" fill=\"blue\"/></svg>";
        assert!(is_svg(clean));
        assert!(sanitize_svg(clean).is_ok());
        assert_eq!(svg_dimensions(clean), Some((100, 100)));

        let with_script = b"<svg><script>alert(1)</script><rect/></svg>";
        assert!(sanitize_svg(with_script).is_err());

        let with_onload = b"<svg onload=\"alert(1)\"><circle/></svg>";
        assert!(sanitize_svg(with_onload).is_err());

        let with_js_href = b"<svg><image href=\"javascript:alert(1)\"/></svg>";
        assert!(sanitize_svg(with_js_href).is_err());

        let with_remote = b"<svg><image href=\"https://evil.com/leak.png\"/></svg>";
        assert!(sanitize_svg(with_remote).is_err());

        let with_foreign_obj = b"<svg><foreignObject><div>bad</div></foreignObject></svg>";
        assert!(sanitize_svg(with_foreign_obj).is_err());

        let with_xxe = b"<?xml version=\"1.0\"?><!DOCTYPE svg SYSTEM \"http://evil.com/xxe\"><svg/>";
        assert!(sanitize_svg(with_xxe).is_err());
    }

    #[test]
    fn decompression_bomb_checks_protect_memory_without_refusing_normal_large_images() {
        // Normal 120MP image: 12000 x 10000 with 15MB file size
        assert!(check_decompression_bomb(15 * 1024 * 1024, 12000, 10000).is_ok());

        // Extreme pixel bomb: 200MP
        assert!(check_decompression_bomb(10 * 1024 * 1024, 20000, 10000).is_err());

        // Extreme single dimension > 65535
        assert!(check_decompression_bomb(10 * 1024 * 1024, 70000, 100).is_err());

        // High ratio decompression bomb: 50KB file claiming 10000 x 10000 (400MB uncompressed)
        assert!(check_decompression_bomb(50 * 1024, 10000, 10000).is_err());
    }

    #[test]
    fn preview_dimensions_adapts_for_large_and_long_images() {
        // Normal image: 1920 x 1080 -> No downsample needed
        assert_eq!(target_preview_dimensions(1920, 1080, 500 * 1024), None);

        // 6000 x 4000 camera photo -> Downsample to width 2048
        let d = target_preview_dimensions(6000, 4000, 8 * 1024 * 1024);
        assert!(d.is_some());
        let (tw, th) = d.unwrap();
        assert_eq!(tw, 2048);
        assert_eq!(th, 1365);

        // Long screenshot: 800 x 10000 (8MP) -> Keep full width 800 so text is crisp!
        assert_eq!(target_preview_dimensions(800, 10000, 2 * 1024 * 1024), None);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageImport {
    pub token: String,
    pub source_token: Option<String>,
    pub bytes: Option<ImageBytes>,
    pub name: String,
    // None means retain original. Clipboard pixels always need a destination.
    pub directory: Option<String>,
}

/// Clipboard pixels arrive as a JSON number array. Apply the image budget while
/// the array is being read so an oversized or malicious IPC payload cannot
/// allocate more than the viewer's 50 MiB encoded-image budget first.
pub struct ImageBytes(Vec<u8>);

impl<'de> Deserialize<'de> for ImageBytes {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ImageBytesVisitor;
        impl<'de> serde::de::Visitor<'de> for ImageBytesVisitor {
            type Value = ImageBytes;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(formatter, "图片字节数组（最多 50 MiB）")
            }
            fn visit_seq<A>(self, mut sequence: A) -> std::result::Result<ImageBytes, A::Error>
            where
                A: serde::de::SeqAccess<'de>,
            {
                let mut bytes =
                    Vec::with_capacity(sequence.size_hint().unwrap_or(0).min(MAX_CLIPBOARD_BYTES));
                while let Some(byte) = sequence.next_element::<u8>()? {
                    if bytes.len() >= MAX_CLIPBOARD_BYTES {
                        return Err(serde::de::Error::custom("图片超过 50 MiB 上限"));
                    }
                    bytes.push(byte);
                }
                Ok(ImageBytes(bytes))
            }
        }
        deserializer.deserialize_seq(ImageBytesVisitor)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub path: String,
    pub name: String,
}

pub fn is_svg(bytes: &[u8]) -> bool {
    let s = match std::str::from_utf8(bytes) {
        Ok(s) => s.trim_start_matches('\u{feff}').trim_start(),
        Err(_) => return false,
    };
    (s.starts_with("<svg")
        || s.starts_with("<?xml")
        || s.starts_with("<!--")
        || s.starts_with("<!DOCTYPE"))
        && s.contains("<svg")
}

pub fn sanitize_svg(bytes: &[u8]) -> Result<()> {
    let s = std::str::from_utf8(bytes)
        .map_err(|_| FileError::new("image_format", "SVG 文件不是有效的 UTF-8 编码。"))?;
    let lower = s.to_ascii_lowercase();

    if lower.contains("<script") || lower.contains("</script>") {
        return fail("image_format", "SVG 包含未受信任的脚本，已被阻止显示以保证安全。");
    }
    if lower.contains("<foreignobject")
        || lower.contains("<iframe")
        || lower.contains("<embed")
        || lower.contains("<object")
        || lower.contains("<applet")
    {
        return fail("image_format", "SVG 包含危险内嵌对象，已被阻止显示以保证安全。");
    }
    if lower.contains("<!entity")
        || (lower.contains("<!doctype") && (lower.contains("system") || lower.contains("public")))
    {
        return fail("image_format", "SVG 包含外部实体声明，已被阻止显示以保证安全。");
    }
    if lower.contains("@import") {
        return fail("image_format", "SVG 包含外部样式表引用，已被阻止显示以保证安全。");
    }
    if let Ok(re_handler) = regex::Regex::new(r#"(?i)\bon[a-z]{2,}\s*="#) {
        if re_handler.is_match(&lower) {
            return fail("image_format", "SVG 包含未受信任的事件处理器，已被阻止显示以保证安全。");
        }
    }
    if let Ok(re_js) = regex::Regex::new(r#"(?i)(?:href|src|xlink:href)\s*=\s*['"]\s*(?:javascript|data|vbscript):"#) {
        if re_js.is_match(&lower) {
            return fail("image_format", "SVG 包含危险协议链接，已被阻止显示以保证安全。");
        }
    }
    if let Ok(re_ext) = regex::Regex::new(r#"(?i)(?:href|src|xlink:href)\s*=\s*['"]\s*(?:https?:|//)"#) {
        if re_ext.is_match(&lower) {
            return fail("image_format", "SVG 包含不可信外部网络资源引用，已被阻止显示以保证安全。");
        }
    }

    Ok(())
}

pub fn svg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let s = std::str::from_utf8(bytes).ok()?;
    let svg_tag_start = s.find("<svg")?;
    let svg_tag_end = s[svg_tag_start..].find('>')? + svg_tag_start;
    let tag = &s[svg_tag_start..svg_tag_end];

    if let Ok(re_viewbox) = regex::Regex::new(r#"(?i)viewBox\s*=\s*["']\s*([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)[\s,]+([\d.-]+)\s*["']"#) {
        if let Some(caps) = re_viewbox.captures(tag) {
            if let (Ok(w), Ok(h)) = (caps[3].parse::<f64>(), caps[4].parse::<f64>()) {
                if w > 0.0 && h > 0.0 {
                    return Some((w.round() as u32, h.round() as u32));
                }
            }
        }
    }
    let re_w = regex::Regex::new(r#"(?i)\bwidth\s*=\s*["']\s*([\d.]+)"#).ok();
    let re_h = regex::Regex::new(r#"(?i)\bheight\s*=\s*["']\s*([\d.]+)"#).ok();
    if let (Some(re_w), Some(re_h)) = (re_w, re_h) {
        if let (Some(w_cap), Some(h_cap)) = (re_w.captures(tag), re_h.captures(tag)) {
            if let (Ok(w), Ok(h)) = (w_cap[1].parse::<f64>(), h_cap[1].parse::<f64>()) {
                if w > 0.0 && h > 0.0 {
                    return Some((w.round() as u32, h.round() as u32));
                }
            }
        }
    }
    Some((800, 600))
}

pub fn check_decompression_bomb(file_size: u64, width: u32, height: u32) -> Result<()> {
    if width == 0 || height == 0 {
        return fail("image_format", "图片尺寸无效（宽或高为 0）。");
    }
    if width > MAX_SAFE_SINGLE_DIM || height > MAX_SAFE_SINGLE_DIM {
        return fail(
            "image_size",
            "图片单边尺寸超出安全上限（最大 65535 像素）。",
        );
    }
    let pixels = (width as u64) * (height as u64);
    if pixels > MAX_SAFE_PIXELS {
        return fail(
            "image_size",
            "图片总像素超出安全上限（最大 1.5 亿像素），可能为解压炸弹。",
        );
    }
    let uncompressed_bytes = pixels.saturating_mul(4);
    if uncompressed_bytes > 30 * 1024 * 1024 && file_size < 100 * 1024 {
        let ratio = uncompressed_bytes / file_size.max(1);
        if ratio > 1500 {
            return fail(
                "image_size",
                "图片压缩比异常，可能为解压炸弹，已阻止加载以保护内存。",
            );
        }
    }
    Ok(())
}

pub fn target_preview_dimensions(w: u32, h: u32, byte_len: usize) -> Option<(u32, u32)> {
    let pixels = (w as u64) * (h as u64);
    if w <= 2048 && h <= 4096 && pixels <= 8_000_000 && byte_len <= 4 * 1024 * 1024 {
        return None;
    }
    let scale_w = if w > 2048 { 2048.0 / w as f64 } else { 1.0 };
    let scale_h = if h > 16384 { 16384.0 / h as f64 } else { 1.0 };
    let scale_pixels = if pixels > 8_000_000 {
        (8_000_000.0 / pixels as f64).sqrt()
    } else {
        1.0
    };
    let scale = scale_w.min(scale_h).min(scale_pixels);
    if scale >= 0.95 && byte_len <= 4 * 1024 * 1024 {
        return None;
    }
    let tw = ((w as f64 * scale).round() as u32).max(1);
    let th = ((h as f64 * scale).round() as u32).max(1);
    Some((tw, th))
}

pub fn downsample_image(bytes: &[u8], target_w: u32, target_h: u32, is_png: bool) -> Result<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| FileError::new("image_format", &format!("图片解码失败: {e}")))?;
    let thumb = img.thumbnail(target_w, target_h);
    let mut out = Vec::new();
    let mut cursor = std::io::Cursor::new(&mut out);
    if is_png && img.color().has_alpha() {
        thumb.write_to(&mut cursor, image::ImageFormat::Png)
            .map_err(|e| FileError::new("image_format", &format!("生成预览失败: {e}")))?;
    } else {
        thumb.write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| FileError::new("image_format", &format!("生成预览失败: {e}")))?;
    }
    Ok(out)
}

fn image_type(bytes: &[u8]) -> Result<&'static str> {
    let kind = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "jpg"
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        "gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "webp"
    } else if is_svg(bytes) {
        "svg"
    } else {
        return fail(
            "image_format",
            "仅支持 PNG、JPEG、GIF、WebP、SVG 图片。",
        );
    };
    if kind == "svg" {
        sanitize_svg(bytes)?;
        return Ok(kind);
    }
    let (w, h) = dimensions(bytes)
        .ok_or_else(|| FileError::new("image_format", "图片头损坏或格式不受支持。"))?;
    check_decompression_bomb(bytes.len() as u64, w, h)?;
    Ok(kind)
}

fn guard(root: &Path, path: &Path) -> Result<PathBuf> {
    crate::workspace::guard::validate_under_root(root, path)
        .map_err(|e| FileError::new("image_scope", &e.to_string()))
}

// Keep directories from being renamed/replaced with reparse points during IO on Windows.
fn lock_directory(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(3).custom_flags(0x02000000 | 0x00200000);
    }
    options.open(path).map_err(FileError::io)
}

fn directory_locks(path: &Path) -> Result<Vec<fs::File>> {
    let mut locks = Vec::new();
    for ancestor in path.ancestors().collect::<Vec<_>>().into_iter().rev() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        guard(ancestor, ancestor)?;
        locks.push(lock_directory(ancestor)?);
        guard(ancestor, ancestor)?;
    }
    Ok(locks)
}

fn read_raster(path: &Path) -> Result<Vec<u8>> {
    #[cfg(unix)]
    let mut file = {
        use rustix::fs::{openat, Mode, OFlags};
        let parent = open_unix_directory(path.parent().unwrap(), None)?;
        fs::File::from(
            openat(
                &parent,
                path.file_name().unwrap(),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map_err(|e| FileError::io(e.into()))?,
        )
    };
    #[cfg(not(unix))]
    let mut file = {
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1).custom_flags(0x00200000);
        }
        options.open(path).map_err(FileError::io)?
    };
    let metadata = file.metadata().map_err(FileError::io)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        if metadata.file_attributes() & 0x400 != 0 {
            return fail("image_scope", "图片不能是符号链接或重解析点。");
        }
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(FileError::io(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks > 1 {
            return fail(
                "image_scope",
                "暂不支持硬链接图片，请复制为独立文件后使用。",
            );
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() > 1 {
            return fail(
                "image_scope",
                "暂不支持硬链接图片，请复制为独立文件后使用。",
            );
        }
    }
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_FILE_BYTES {
        return fail("image_size", "图片必须为不超过 100 MiB 的普通文件。");
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_IMAGE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(FileError::io)?;
    if bytes.len() as u64 > MAX_IMAGE_FILE_BYTES
        || file.metadata().map_err(FileError::io)?.modified().ok() != metadata.modified().ok()
    {
        return fail("image_size", "图片超出 100 MiB 上限或读取期间发生变化。");
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_unix_directory(dir: &Path, create_under: Option<&Path>) -> Result<fs::File> {
    use rustix::fs::{mkdirat, openat, Mode, OFlags};
    let options = OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC;
    let mut fd = fs::File::open("/").map_err(FileError::io)?;
    let mut cursor = PathBuf::from("/");
    for component in dir.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        cursor.push(part);
        if create_under.is_some_and(|root| cursor.starts_with(root) && cursor != root) {
            match mkdirat(&fd, part, Mode::from_raw_mode(0o755)) {
                Ok(()) => {}
                Err(e) if e == rustix::io::Errno::EXIST => {}
                Err(e) => return Err(FileError::io(e.into())),
            }
        }
        fd = fs::File::from(
            openat(&fd, part, options, Mode::empty()).map_err(|e| FileError::io(e.into()))?,
        );
    }
    Ok(fd)
}

// Unix traversal and creation are relative to held FDs, never re-follow a path.
#[cfg(unix)]
fn write_unix_image(dir: &Path, root: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    use rustix::fs::{openat, unlinkat, AtFlags, Mode, OFlags};
    let fd = open_unix_directory(dir, Some(root))?;
    let path = Path::new(name);
    let stem = path.file_stem().unwrap().to_string_lossy();
    let ext = path.extension().unwrap().to_string_lossy();
    for index in 0..10000 {
        let candidate = if index == 0 {
            name.into()
        } else {
            format!("{stem}-{index}.{ext}")
        };
        let opened = openat(
            &fd,
            candidate.as_str(),
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o644),
        );
        let mut file = match opened {
            Ok(f) => fs::File::from(f),
            Err(e) if e == rustix::io::Errno::EXIST => continue,
            Err(e) => return Err(FileError::io(e.into())),
        };
        if let Err(error) = file
            .write_all(bytes)
            .and_then(|_| file.sync_all())
            .and_then(|_| fd.sync_all())
        {
            let _ = unlinkat(&fd, candidate.as_str(), AtFlags::empty());
            return Err(FileError::io(error));
        }
        // A concurrent directory rename can make the lexical reference stale, but
        // cannot redirect the write through a symlink. Refuse a stale reference.
        if guard(root, &dir.join(&candidate)).is_err() {
            let _ = unlinkat(&fd, candidate.as_str(), AtFlags::empty());
            return fail("image_scope", "写入期间目录发生变化。");
        }
        return Ok(dir.join(candidate));
    }
    fail("image_name", "同名图片过多，请更换名称。")
}

impl FileService {
    fn image_document(&self, token: &str) -> Result<PathBuf> {
        let document = self.validate(token, false)?;
        if !document
            .extension()
            .is_some_and(|s| s.eq_ignore_ascii_case("md") || s.eq_ignore_ascii_case("markdown"))
        {
            return fail("image_scope", "图片导入需要已保存的 Markdown 文件授权。");
        }
        guard(document.parent().unwrap(), &document)?;
        Ok(document)
    }

    pub fn image_inputs(&mut self, paths: Vec<PathBuf>) -> Vec<ImageInput> {
        // Bound retained native-drop capabilities even if no frontend is listening.
        self.image_inputs
            .retain(|_, (owner, _)| owner != &self.current_owner);
        paths
            .into_iter()
            .take(100)
            .map(|path| {
                let is_directory =
                    std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.is_dir());
                self.next_token += 1;
                let token = format!("image-input-{}", self.next_token);
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned();
                self.image_inputs
                    .insert(token.clone(), (self.current_owner.clone(), path));
                ImageInput {
                    token,
                    name,
                    is_directory,
                }
            })
            .collect()
    }
    pub fn release_image_inputs(&mut self, tokens: &[String]) {
        for token in tokens {
            if self
                .image_inputs
                .get(token)
                .is_some_and(|(o, _)| o == &self.current_owner)
            {
                self.image_inputs.remove(token);
            }
        }
    }
    pub fn open_image_inputs(&mut self, tokens: &[String]) -> super::OpenBatch {
        let paths = tokens
            .iter()
            .filter_map(|t| {
                self.image_inputs
                    .get(t)
                    .filter(|(o, _)| o == &self.current_owner)
                    .map(|(_, p)| p.clone())
            })
            .collect();
        self.release_image_inputs(tokens);
        self.open_batch(paths, None)
    }

    /// Consume only a native capability belonging to this window. Validate again
    /// at use time: the dropped path may have disappeared or become a link.
    pub fn take_dropped_directory(&mut self, token: &str) -> Result<PathBuf> {
        let path = self
            .image_inputs
            .get(token)
            .filter(|(owner, _)| owner == &self.current_owner)
            .map(|(_, path)| path.clone())
            .ok_or_else(|| FileError::new("scope", "拖入目录授权已失效，请重新拖入。"))?;
        self.image_inputs.remove(token);
        crate::workspace::guard::validate_under_root(&path, &path)
            .map_err(|error| FileError::new("path", &error.to_string()))?;
        if !std::fs::metadata(&path).map_err(FileError::io)?.is_dir() {
            return fail("path", "拖入的路径不是目录。");
        }
        Ok(path)
    }

    pub fn image_directory(&self, token: &str, relative: &str) -> Result<PathBuf> {
        let document = self.image_document(token)?;
        if relative.is_empty()
            || relative.len() > 1024
            || relative.contains([':', '\0', '\r', '\n'])
            || relative.starts_with(['/', '\\'])
        {
            return fail("image_scope", "图片目录必须是相对于 Markdown 的目录。");
        }
        let stem = document.file_stem().unwrap().to_string_lossy();
        let relative = relative.replace("${filename}", &stem).replace('\\', "/");
        let mut target = document.parent().unwrap().to_path_buf();
        for part in Path::new(&relative).components() {
            match part {
                Component::Normal(name) => {
                    crate::workspace::guard::validate_name(&name.to_string_lossy())
                        .map_err(|e| FileError::new("image_scope", &e))?;
                    target.push(name);
                }
                Component::CurDir => {}
                Component::ParentDir => {
                    if !target.pop() {
                        return fail("image_scope", "图片目录超出文件系统范围。");
                    }
                }
                _ => return fail("image_scope", "图片目录无效。"),
            }
        }
        Ok(target)
    }
    pub fn authorize_image_directory(
        &mut self,
        token: &str,
        relative: &str,
        selected: &Path,
    ) -> Result<()> {
        let target = self.image_directory(token, relative)?;
        let _locks = directory_locks(selected)?;
        if fs::canonicalize(selected).map_err(FileError::io)? != target {
            return fail(
                "image_scope",
                "请选择提示中的图片目标目录，未授予其他目录写权限。",
            );
        }
        self.image_directories
            .insert(token.into(), (self.current_owner.clone(), target));
        Ok(())
    }

    pub(crate) fn resolve_image(&self, token: &str, source: &str) -> Result<PathBuf> {
        let document = self.image_document(token)?;
        if source.is_empty() || source.contains(['\0', '\r', '\n']) || source.len() > 4096 {
            return fail("image_scope", "图片路径无效。");
        }
        let source = source.replace('\\', "/");
        let mut target = document.parent().unwrap().to_path_buf();
        if Path::new(&source).is_absolute() {
            target = PathBuf::from(&source);
        } else {
            for component in Path::new(&source).components() {
                match component {
                    Component::Normal(name) => target.push(name),
                    Component::CurDir => {}
                    Component::ParentDir => {
                        if !target.pop() {
                            return fail("image_scope", "图片路径超出文件系统范围。");
                        }
                    }
                    _ => return fail("image_scope", "图片路径无效。"),
                }
            }
        }
        let canonical = checked_path(&target, false)?;
        guard(canonical.parent().unwrap(), &target)?;
        Ok(canonical)
    }

    pub fn authorize_image_read(
        &mut self,
        token: &str,
        source: &str,
        selected: &Path,
    ) -> Result<()> {
        let expected = self.resolve_image(token, source)?;
        let selected = checked_path(selected, false)?;
        if expected != selected {
            return fail(
                "image_scope",
                "请选择 Markdown 引用的同一图片；未授权其他路径。",
            );
        }
        guard(selected.parent().unwrap(), &selected)?;
        let paths = self.image_reads.entry(token.into()).or_default();
        if paths.len() >= 1024 {
            return fail("image_scope", "本会话图片授权超过上限，请重开文档。");
        }
        if !paths.contains(&selected) {
            paths.push(selected);
        }
        Ok(())
    }

    pub fn import_image(&mut self, input: ImageImport) -> Result<ImportedImage> {
        let document = self.image_document(&input.token)?;
        if input.source_token.is_some() == input.bytes.is_some() {
            return fail("image_input", "请选择一个图片来源。");
        }
        let (bytes, original, name) = if let Some(source) = input.source_token {
            let path = self
                .image_inputs
                .get(&source)
                .filter(|(o, _)| o == &self.current_owner)
                .map(|(_, p)| p.clone())
                .ok_or_else(|| FileError::new("image_scope", "图片来源未获本窗口授权。"))?;
            let canonical = checked_path(&path, false)?;
            let _locks = directory_locks(path.parent().unwrap())?;
            let bytes = read_raster(&path)?;
            if checked_path(&path, false)? != canonical {
                return fail("image_scope", "图片来源在读取期间发生变化。");
            }
            (
                bytes,
                Some(canonical),
                path.file_name().unwrap().to_string_lossy().into_owned(),
            )
        } else {
            (input.bytes.unwrap().0, None, input.name)
        };
        let kind = image_type(&bytes)?;
        crate::workspace::guard::validate_name(&name)
            .map_err(|e| FileError::new("image_name", &e))?;
        let extension = Path::new(&name)
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if extension != kind && !(kind == "jpg" && extension == "jpeg") {
            return fail("image_format", "图片扩展名与实际类型不一致。");
        }
        let target = if let Some(relative) = input.directory {
            let dir = self.image_directory(&input.token, &relative)?;
            let parent = document.parent().unwrap();
            let root = if dir.starts_with(parent) {
                parent.to_path_buf()
            } else {
                if !self
                    .image_directories
                    .get(&input.token)
                    .is_some_and(|(o, p)| o == &self.current_owner && p == &dir)
                {
                    return fail(
                        "image_directory_permission",
                        &format!(
                            "目标目录 {} 位于文档目录之外，请明确选择该目录授权。",
                            dir.display()
                        ),
                    );
                }
                dir.clone()
            };
            #[cfg(unix)]
            let saved = write_unix_image(&dir, &root, &name, &bytes)?;
            #[cfg(not(unix))]
            let saved = {
                let mut locks = directory_locks(&root)?;
                let mut cursor = root.clone();
                for component in dir
                    .strip_prefix(&root)
                    .map_err(|_| FileError::new("image_scope", "目录授权不匹配"))?
                    .components()
                {
                    cursor.push(component);
                    guard(&root, &cursor)?;
                    match fs::create_dir(&cursor) {
                        Ok(()) => {}
                        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(FileError::io(e)),
                    }
                    guard(&root, &cursor)?;
                    locks.push(lock_directory(&cursor)?);
                    guard(&root, &cursor)?;
                }
                guard(&root, &dir)?;
                let mut temp = tempfile::NamedTempFile::new_in(&dir).map_err(FileError::io)?;
                temp.write_all(&bytes).map_err(FileError::io)?;
                temp.as_file().sync_all().map_err(FileError::io)?;
                let stem = Path::new(&name).file_stem().unwrap().to_string_lossy();
                let mut saved = None;
                for index in 0..10000 {
                    let candidate = dir.join(if index == 0 {
                        name.clone()
                    } else {
                        format!("{stem}-{index}.{extension}")
                    });
                    // Existing files, symlinks and dangling symlinks are collisions, never overwrite.
                    if fs::symlink_metadata(&candidate).is_ok() {
                        continue;
                    }
                    guard(&root, &candidate)?;
                    match temp.persist_noclobber(&candidate) {
                        Ok(_) => {
                            saved = Some(candidate);
                            break;
                        }
                        Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                            temp = e.file;
                        }
                        Err(e) => return Err(FileError::io(e.error)),
                    }
                }
                saved.ok_or_else(|| FileError::new("image_name", "同名图片过多，请更换名称。"))?
            };
            saved
        } else {
            original.ok_or_else(|| {
                FileError::new("image_input", "截图没有原始文件，请选择复制目录。")
            })?
        };
        let reads = self.image_reads.entry(input.token).or_default();
        if !reads.contains(&target) {
            if reads.len() >= 1024 {
                reads.remove(0);
            }
            reads.push(target.clone());
        }
        Ok(ImportedImage {
            path: display_path(&target),
            name: target.file_name().unwrap().to_string_lossy().into_owned(),
        })
    }
}
pub fn dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") && bytes.get(12..16) == Some(b"IHDR") {
        return Some((
            u32::from_be_bytes(bytes.get(16..20)?.try_into().ok()?),
            u32::from_be_bytes(bytes.get(20..24)?.try_into().ok()?),
        ));
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some((
            u16::from_le_bytes(bytes.get(6..8)?.try_into().ok()?) as u32,
            u16::from_le_bytes(bytes.get(8..10)?.try_into().ok()?) as u32,
        ));
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        let data = bytes.get(20..)?;
        return match bytes.get(12..16)? {
            b"VP8X" => Some((
                1 + u32::from_le_bytes([*data.get(4)?, *data.get(5)?, *data.get(6)?, 0]),
                1 + u32::from_le_bytes([*data.get(7)?, *data.get(8)?, *data.get(9)?, 0]),
            )),
            b"VP8L" if data.first() == Some(&0x2f) => {
                let bits = u32::from_le_bytes(data.get(1..5)?.try_into().ok()?);
                Some((1 + (bits & 0x3fff), 1 + ((bits >> 14) & 0x3fff)))
            }
            b"VP8 " if data.get(3..6) == Some(&[0x9d, 0x01, 0x2a]) => Some((
                (u16::from_le_bytes(data.get(6..8)?.try_into().ok()?) & 0x3fff) as u32,
                (u16::from_le_bytes(data.get(8..10)?.try_into().ok()?) & 0x3fff) as u32,
            )),
            _ => None,
        };
    }
    if bytes.starts_with(&[0xff, 0xd8]) {
        let mut offset = 2;
        while offset < bytes.len() {
            if *bytes.get(offset)? != 0xff {
                return None;
            }
            while bytes.get(offset) == Some(&0xff) {
                offset += 1;
            }
            let marker = *bytes.get(offset)?;
            offset += 1;
            if marker == 0xda || marker == 0xd9 {
                return None;
            }
            if marker == 1 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            let length =
                u16::from_be_bytes(bytes.get(offset..offset + 2)?.try_into().ok()?) as usize;
            if length < 2 || offset.checked_add(length)? > bytes.len() {
                return None;
            }
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
                && length >= 7
            {
                return Some((
                    u16::from_be_bytes(bytes.get(offset + 5..offset + 7)?.try_into().ok()?) as u32,
                    u16::from_be_bytes(bytes.get(offset + 3..offset + 5)?.try_into().ok()?) as u32,
                ));
            }
            offset += length;
        }
    }
    if is_svg(bytes) {
        return svg_dimensions(bytes);
    }
    None
}

impl FileService {
    pub fn markdown_image(
        &self,
        token: &str,
        relative: &str,
        roots: &[PathBuf],
        full: bool,
    ) -> Result<Vec<u8>> {
        let document = self.image_document(token)?;
        let canonical = self.resolve_image(token, relative)?;
        let target = canonical.clone();
        let _locks = directory_locks(canonical.parent().unwrap())?;
        // A chosen document grants its attachment descendants, not arbitrary external reads.
        let authorized = guard(document.parent().unwrap(), &target).is_ok()
            || self
                .image_reads
                .get(token)
                .is_some_and(|paths| paths.contains(&canonical))
            || self
                .image_directories
                .get(token)
                .is_some_and(|(o, dir)| o == &self.current_owner && guard(dir, &target).is_ok())
            || roots
                .iter()
                .any(|root| crate::workspace::guard::validate_under_root(root, &target).is_ok())
            || self
                .grants
                .values()
                .any(|grant| grant.owner == self.current_owner && grant.canonical == canonical);
        if !authorized {
            return fail(
                "image_scope",
                "文档目录外的图片需要单独授权，或将图片目录加入工作区。",
            );
        }
        let metadata = std::fs::metadata(&canonical).map_err(FileError::io)?;
        if metadata.len() > MAX_IMAGE_FILE_BYTES {
            return fail("image_size", "图片超过 100 MiB，已保留可编辑路径。");
        }
        let bytes = read_raster(&canonical)?;
        if checked_path(&target, false)? != canonical {
            return fail("image_scope", "读取期间图片路径发生变化，请重试。");
        }
        let kind = image_type(&bytes)?;
        if kind == "svg" || kind == "gif" || kind == "webp" || full {
            return Ok(bytes);
        }
        let (width, height) = dimensions(&bytes).unwrap_or((0, 0));
        if let Some((tw, th)) = target_preview_dimensions(width, height, bytes.len()) {
            match downsample_image(&bytes, tw, th, kind == "png") {
                Ok(thumb) => Ok(thumb),
                Err(_) => Ok(bytes),
            }
        } else {
            Ok(bytes)
        }
    }
}
