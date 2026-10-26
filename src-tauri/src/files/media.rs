//! Token-only media access. No full-file allocation or text decoding; the
//! version string uses only bounded metadata and first/last-4 KiB samples.
use super::*;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom};

pub const CHUNK_BYTES: usize = 256 * 1024;
const HEADER_BYTES: u64 = 4096;
pub(crate) fn is_media_content(bytes: &[u8]) -> bool {
    signature(&bytes[..bytes.len().min(HEADER_BYTES as usize)]).is_some()
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub byte_length: u64,
    pub mime: String,
    pub format: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

fn raster_dimensions(file: &mut fs::File, header: &[u8], mime: &str) -> Option<(u32, u32)> {
    if mime == "image/x-icon" {
        let count = u16::from_le_bytes(header.get(4..6)?.try_into().ok()?) as usize;
        if count == 0 || count > 256 {
            return None;
        }
        let file_length = file.metadata().ok()?.len();
        let mut size = (0, 0);
        for index in 0..count {
            file.seek(SeekFrom::Start(6 + index as u64 * 16)).ok()?;
            let mut entry = [0; 16];
            file.read_exact(&mut entry).ok()?;
            let length = u32::from_le_bytes(entry[8..12].try_into().ok()?) as u64;
            let offset = u32::from_le_bytes(entry[12..16].try_into().ok()?) as u64;
            if length == 0
                || offset < 6 + count as u64 * 16
                || offset.checked_add(length)? > file_length
            {
                return None;
            }
            let declared = (
                if entry[0] == 0 { 256 } else { entry[0] as u32 },
                if entry[1] == 0 { 256 } else { entry[1] as u32 },
            );
            // Embedded PNG dimensions can differ from the icon directory. Check both before decoding.
            file.seek(SeekFrom::Start(offset)).ok()?;
            let mut content = vec![0; length.min(32) as usize];
            file.read_exact(&mut content).ok()?;
            let actual = if content.starts_with(b"\x89PNG\r\n\x1a\n") {
                images::dimensions(&content)?
            } else if content.len() >= 12 && u32::from_le_bytes(content[..4].try_into().ok()?) >= 40
            {
                (
                    i32::from_le_bytes(content[4..8].try_into().ok()?).unsigned_abs(),
                    i32::from_le_bytes(content[8..12].try_into().ok()?).unsigned_abs() / 2,
                )
            } else {
                declared
            };
            size.0 = size.0.max(actual.0).max(declared.0);
            size.1 = size.1.max(actual.1).max(declared.1);
        }
        return Some(size);
    }
    if mime == "image/bmp" {
        let dib = u32::from_le_bytes(header.get(14..18)?.try_into().ok()?);
        return if dib == 12 {
            Some((
                u16::from_le_bytes(header.get(18..20)?.try_into().ok()?) as u32,
                u16::from_le_bytes(header.get(20..22)?.try_into().ok()?) as u32,
            ))
        } else {
            Some((
                i32::from_le_bytes(header.get(18..22)?.try_into().ok()?).unsigned_abs(),
                i32::from_le_bytes(header.get(22..26)?.try_into().ok()?).unsigned_abs(),
            ))
        };
    }
    if mime == "image/jpeg" {
        // Walk JPEG segments with seeks: a large EXIF/profile must not require a large header allocation.
        file.seek(SeekFrom::Start(2)).ok()?;
        for _ in 0..4096 {
            let mut pair = [0; 2];
            file.read_exact(&mut pair).ok()?;
            if pair[0] != 0xff {
                return None;
            }
            while pair[1] == 0xff {
                file.read_exact(&mut pair[1..]).ok()?;
            }
            let marker = pair[1];
            if marker == 0xda || marker == 0xd9 {
                return None;
            }
            if marker == 1 || (0xd0..=0xd7).contains(&marker) {
                continue;
            }
            file.read_exact(&mut pair).ok()?;
            let length = u16::from_be_bytes(pair) as i64;
            if length < 2 {
                return None;
            }
            if [
                0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
            ]
            .contains(&marker)
            {
                let mut dimensions = [0; 5];
                file.read_exact(&mut dimensions).ok()?;
                return Some((
                    u16::from_be_bytes([dimensions[3], dimensions[4]]) as u32,
                    u16::from_be_bytes([dimensions[1], dimensions[2]]) as u32,
                ));
            }
            file.seek(SeekFrom::Current(length - 2)).ok()?;
        }
        return None;
    }
    images::dimensions(header)
}

fn signature(bytes: &[u8]) -> Option<(FileKind, &'static str, &'static str)> {
    let image = |mime, format| Some((FileKind::Image, mime, format));
    if bytes.starts_with(b"%PDF-") {
        return Some((FileKind::Pdf, "application/pdf", "PDF"));
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return image("image/png", "PNG");
    }
    if bytes.starts_with(b"\xff\xd8\xff") {
        return image("image/jpeg", "JPEG");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return image("image/gif", "GIF");
    }
    if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        return image("image/webp", "WebP");
    }
    if bytes.starts_with(b"BM") {
        return image("image/bmp", "BMP");
    }
    if bytes.starts_with(b"\0\0\x01\0") {
        return image("image/x-icon", "ICO");
    }
    if bytes.starts_with(b"\0\0\x02\0") {
        return image("image/x-icon", "CUR");
    }
    if bytes.get(4..8) == Some(b"ftyp") {
        let length = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?) as usize;
        if length >= 16
            && length <= bytes.len()
            && (bytes.get(8..12) == Some(b"avif")
                || bytes.get(8..12) == Some(b"avis")
                || bytes
                    .get(16..length)?
                    .as_chunks::<4>()
                    .0
                    .iter()
                    .any(|b| b == b"avif" || b == b"avis"))
        {
            return image("image/avif", "AVIF");
        }
    }
    // SVG is ONLY ever used as an <img> blob. Never as markup, an object or an iframe.
    {
        // The bounded header may end inside a UTF-8 character; don't reject an otherwise valid SVG.
        let text = String::from_utf8_lossy(bytes);
        let text = text.trim_start_matches('\u{feff}').trim_start();
        if (text.starts_with("<svg") || text.starts_with("<?xml") || text.starts_with("<!--"))
            && regex::Regex::new(r"(?s)<svg(?:\s|>)")
                .unwrap()
                .is_match(text)
        {
            return image("image/svg+xml", "SVG");
        }
    }
    None
}

fn version(file: &mut fs::File, meta: &fs::Metadata) -> Result<String> {
    let modified = system_time_nanos(meta.modified());
    let created = system_time_nanos(meta.created());
    let changed = changed_time(file, meta)?;
    Ok(format!(
        "media-{}-{modified}-{created}-{changed}-{}-{}",
        meta.len(),
        identity(file, meta)?,
        content_fingerprint(file, meta.len())?
    ))
}

fn system_time_nanos(time: std::io::Result<std::time::SystemTime>) -> u128 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|t| t.as_nanos())
        .unwrap_or(0)
}

/// Native identity of the opened handle. A different file at the same path must
/// invalidate a viewer even when length and modification time were reproduced.
/// Routing (`FileService::file_identity`) and media previews share the Windows
/// volume+index helper; the media string additionally carries change evidence.
fn identity(file: &fs::File, meta: &fs::Metadata) -> Result<String> {
    #[cfg(windows)]
    {
        let _ = meta;
        Ok(match super::file_identity_from_handle(file) {
            Some(identity) => format!("{:x}:{:x}", identity.volume, identity.index),
            None => "identity-unavailable".into(),
        })
    }
    #[cfg(unix)]
    {
        let _ = file;
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{:x}:{:x}", meta.dev(), meta.ino()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (file, meta);
        Ok("identity-unavailable".into())
    }
}

/// Extra native change timestamp: Unix ctime, Windows ChangeTime. ctime cannot
/// be set by ordinary user code, so it distinguishes a replacement from an
/// in-place write even when length and mtime were deliberately reproduced.
fn changed_time(file: &fs::File, meta: &fs::Metadata) -> Result<String> {
    #[cfg(windows)]
    {
        let _ = meta;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };
        let mut info: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
        let ok = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as _,
                FileBasicInfo,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if ok == 0 {
            // A readable preview must not fail only because an optional change
            // timestamp is unavailable; identity and the content sample remain.
            Ok("change-unavailable".into())
        } else {
            Ok(format!("{:x}", info.ChangeTime as u64))
        }
    }
    #[cfg(unix)]
    {
        let _ = file;
        use std::os::unix::fs::MetadataExt;
        Ok(format!("{}-{}", meta.ctime(), meta.ctime_nsec()))
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = (file, meta);
        Ok("change-unavailable".into())
    }
}

/// Bounded content sample: first and last 4 KiB. It catches inode/timestamp
/// reuse that metadata alone cannot distinguish, without reading a whole file
/// or re-hashing it for every 256 KiB chunk.
const VERSION_SAMPLE_BYTES: usize = 4096;

fn content_fingerprint(file: &mut fs::File, len: u64) -> Result<String> {
    // `seek_read` on Windows advances the shared file cursor (observed), so the
    // original position must be restored before the caller resumes reading.
    let position = file.stream_position().map_err(FileError::io)?;
    let result = (|| -> Result<String> {
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; VERSION_SAMPLE_BYTES];
        let prefix_len = len.min(VERSION_SAMPLE_BYTES as u64) as usize;
        read_sample(file, &mut buffer[..prefix_len], 0)?;
        hasher.update(b"head");
        hasher.update((prefix_len as u64).to_le_bytes());
        hasher.update(&buffer[..prefix_len]);

        if len > VERSION_SAMPLE_BYTES as u64 {
            let suffix_len =
                (len - VERSION_SAMPLE_BYTES as u64).min(VERSION_SAMPLE_BYTES as u64) as usize;
            let offset = len - suffix_len as u64;
            read_sample(file, &mut buffer[..suffix_len], offset)?;
            hasher.update(b"tail");
            hasher.update(offset.to_le_bytes());
            hasher.update(&buffer[..suffix_len]);
        }
        Ok(format!("{:x}", hasher.finalize()))
    })();
    file.seek(SeekFrom::Start(position))
        .map_err(FileError::io)?;
    result
}

fn read_sample(file: &mut fs::File, buffer: &mut [u8], offset: u64) -> Result<()> {
    let read = read_at(file, buffer, offset).map_err(FileError::io)?;
    if read != buffer.len() {
        return fail("conflict", "媒体文件在计算版本时发生变化，请重新加载。");
    }
    Ok(())
}

#[cfg(unix)]
fn read_at(file: &fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(buffer, offset)
}

#[cfg(windows)]
fn read_at(file: &mut fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(buffer, offset)
}

#[cfg(not(any(windows, unix)))]
fn read_at(file: &mut fs::File, buffer: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    let mut clone = file.try_clone()?;
    clone.seek(SeekFrom::Start(offset))?;
    clone.read(buffer)
}

fn open(path: &Path) -> Result<fs::File> {
    let file = open_plain_read(path)?;
    let meta = file.metadata().map_err(FileError::io)?;
    if !meta.is_file() {
        return fail("path", "仅允许读取普通媒体文件。");
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(FileError::io(std::io::Error::last_os_error()));
        }
        if info.nNumberOfLinks > 1 {
            return fail("path", "暂不支持硬链接媒体文件。");
        }
    }
    Ok(file)
}

pub(super) fn inspect(path: &Path) -> Result<Option<(FileKind, MediaMetadata, String)>> {
    let mut file = open(path)?;
    let meta = file.metadata().map_err(FileError::io)?;
    let initial_version = version(&mut file, &meta)?;
    let mut header = Vec::new();
    (&mut file)
        .take(HEADER_BYTES)
        .read_to_end(&mut header)
        .map_err(FileError::io)?;
    if let Some((kind, mime, format)) = signature(&header) {
        // JS/PDF.js offsets must be exact integers. Large images also have a frontend decode budget.
        if meta.len() > 2 * 1024 * 1024 * 1024 {
            return fail("size", "媒体文件超过 2 GiB 查看预算，请使用专用程序。");
        }
        let dimensions = if mime == "image/avif" {
            // AVIF's spatial property normally lives in its bounded metadata prefix.
            // Missing metadata is left to the native decoder, just as for dimensionless SVG.
            header.windows(16).find(|b| &b[..4] == b"ispe").map(|b| {
                (
                    u32::from_be_bytes(b[8..12].try_into().unwrap()),
                    u32::from_be_bytes(b[12..16].try_into().unwrap()),
                )
            })
        } else if kind == FileKind::Image && mime != "image/svg+xml" {
            Some(raster_dimensions(&mut file, &header, mime).ok_or_else(|| {
                FileError::new(
                    "image_header",
                    "图片尺寸信息损坏或无法安全识别，请使用系统图片程序。",
                )
            })?)
        } else {
            None
        };
        let final_meta = file.metadata().map_err(FileError::io)?;
        if version(&mut file, &final_meta)? != initial_version {
            return fail("conflict", "读取媒体元数据期间文件发生变化，请重试。");
        }
        Ok(Some((
            kind,
            MediaMetadata {
                byte_length: meta.len(),
                mime: mime.into(),
                format: format.into(),
                width: dimensions.map(|d| d.0),
                height: dimensions.map(|d| d.1),
            },
            initial_version,
        )))
    } else {
        let ext = path
            .extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase();
        if [
            "png", "apng", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "webp", "bmp", "dib",
            "svg", "pdf", "tif", "tiff", "heic", "heif", "avif", "ico", "cur", "svgz", "jxl",
            "psd", "tga",
        ]
        .contains(&ext.as_str())
        {
            return fail("media_type", "文件内容与支持的图片/PDF 格式不符，文件可能损坏或格式尚不支持。可显式选择 Hex 查看字节。");
        }
        Ok(None)
    }
}

impl FileService {
    pub fn media_metadata(&self, token: &str) -> Result<(MediaMetadata, String)> {
        let path = self.validate(token, false)?;
        let (_, meta, version) = inspect(&path)?
            .ok_or_else(|| FileError::new("media_type", "文件已不再是支持的媒体格式。"))?;
        Ok((meta, version))
    }
    pub fn read_media_chunk(
        &self,
        token: &str,
        expected: &str,
        offset: u64,
        length: usize,
    ) -> Result<Vec<u8>> {
        if length == 0 || length > CHUNK_BYTES {
            return fail("range", "媒体读取块必须为 1–256 KiB。");
        }
        let path = self.validate(token, false)?;
        let (meta, actual) = self.media_metadata(token)?;
        if actual != expected {
            return fail("conflict", "文件已被外部修改，请重新加载查看器。");
        }
        if offset > meta.byte_length || length as u64 > meta.byte_length - offset {
            return fail("range", "媒体读取范围越界。");
        }
        let mut file = open(&path)?;
        let opened_meta = file.metadata().map_err(FileError::io)?;
        if version(&mut file, &opened_meta)? != expected {
            return fail("conflict", "文件读取期间发生修改，请重新加载。");
        }
        file.seek(SeekFrom::Start(offset)).map_err(FileError::io)?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(FileError::io)?;
        let final_meta = file.metadata().map_err(FileError::io)?;
        if self.validate(token, false)? != path || version(&mut file, &final_meta)? != expected {
            return fail("conflict", "文件读取期间发生修改，请重新加载。");
        }
        Ok(bytes)
    }
    pub fn media_path(&self, token: &str) -> Result<PathBuf> {
        self.media_metadata(token)?;
        self.validate(token, false)
    }
}
