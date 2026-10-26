use crate::conversion::{
    self, BinaryBytes, ConversionStore, InputText, NativeRunner, Purpose, Selection,
};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PandocStatus {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPrintOptions {
    pub paper_size: Option<String>,
    pub orientation: Option<String>,
    pub margins: Option<String>,
    pub print_background: Option<bool>,
}

fn pandoc_version(program: &Path) -> Option<String> {
    use std::io::Read;
    let output = tempfile::NamedTempFile::new().ok()?;
    let mut child = conversion::pandoc_command(program)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(output.reopen().ok()?)
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut text = String::new();
                output
                    .reopen()
                    .ok()?
                    .take(4096)
                    .read_to_string(&mut text)
                    .ok()?;
                return text
                    .lines()
                    .next()?
                    .split_whitespace()
                    .nth(1)
                    .map(str::to_owned);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}
pub fn find_pandoc_path() -> Option<PathBuf> {
    let mut candidates = vec![PathBuf::from("pandoc")];
    #[cfg(windows)]
    for key in [
        "ProgramFiles",
        "ProgramFiles(x86)",
        "LOCALAPPDATA",
        "APPDATA",
    ] {
        if let Ok(path) = std::env::var(key) {
            candidates.push(PathBuf::from(path).join("Pandoc/pandoc.exe"));
        }
    }
    #[cfg(not(windows))]
    let _ = &mut candidates;
    candidates.into_iter().find(|p| pandoc_version(p).is_some())
}
#[tauri::command]
pub async fn detect_pandoc() -> Result<PandocStatus, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let path = find_pandoc_path();
        PandocStatus {
            available: path.is_some(),
            version: path.as_deref().and_then(pandoc_version),
            path: path.map(|p| p.to_string_lossy().into_owned()),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn export_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    default_name: String,
    format: String,
) -> Result<Option<Selection>, String> {
    let purpose = Purpose::write(&format)?;
    let permit = store.dialog(window.label())?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(default_name)
            .set_title("导出文档");
        dialog = match purpose {
            Purpose::Pdf => dialog.add_filter("PDF 文档 (*.pdf)", &["pdf"]),
            Purpose::Html => dialog.add_filter("HTML 网页 (*.html; *.htm)", &["html", "htm"]),
            Purpose::Docx => dialog.add_filter("Word 文档 (*.docx)", &["docx"]),
            Purpose::Png => dialog.add_filter("PNG 图像 (*.png)", &["png"]),
            Purpose::Markdown => dialog.add_filter("所有文件 (*.*)", &["*"]),
            _ => return Err("不支持的导出操作".into()),
        };
        let path = dialog
            .blocking_save_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        store.selected(&permit, path, purpose)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn import_open_dialog(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    format: String,
) -> Result<Option<Selection>, String> {
    let purpose = Purpose::read(&format)?;
    let permit = store.dialog(window.label())?;
    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("导入文档");
        let dialog = if purpose == Purpose::ReadHtml {
            dialog.add_filter("HTML 网页 (*.html; *.htm)", &["html", "htm"])
        } else {
            dialog.add_filter("Word 文档 (*.docx)", &["docx"])
        };
        let path = dialog
            .blocking_pick_file()
            .map(|p| p.into_path().map_err(|e| e.to_string()))
            .transpose()?;
        store.selected(&permit, path, purpose)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn release_conversion_lease(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    token: String,
) {
    store.release(window.label(), &token);
}
#[tauri::command]
pub async fn save_binary_file(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    token: String,
    format: String,
    bytes: BinaryBytes,
) -> Result<(), String> {
    let purpose = Purpose::write(&format)?;
    if !matches!(purpose, Purpose::Html | Purpose::Png | Purpose::Docx) {
        return Err("此命令只接受 HTML/PNG/DOCX 授权".into());
    }
    let op = store.begin(window.label(), &[(&token, purpose)])?;
    tauri::async_runtime::spawn_blocking(move || conversion::save_binary(&op, &bytes.0))
        .await
        .map_err(|e| e.to_string())?
}

/// Raw bytes avoid a large JSON number array on the WebView main thread. The
/// same window-bound, single-operation DOCX lease still controls the commit.
#[tauri::command]
pub async fn save_docx_bytes(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let token = request.headers().get("x-markumo-conversion-token")
        .and_then(|value| value.to_str().ok()).ok_or("缺少 Word 导出授权")?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Word 导出需要原始二进制请求".into()) };
    if bytes.len() > conversion::MAX_OUTPUT || !bytes.starts_with(b"PK\x03\x04") {
        return Err("Word 输出格式无效或超过 16 MiB，未写入文件".into());
    }
    let op = store.begin(window.label(), &[(token, Purpose::Docx)])?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || conversion::save_binary(&op, &bytes))
        .await.map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn read_conversion_html(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    token: String,
) -> Result<String, String> {
    let op = store.begin(window.label(), &[(&token, Purpose::ReadHtml)])?;
    tauri::async_runtime::spawn_blocking(move || conversion::read_html(&op))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pandoc_export_docx(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    files: State<'_, crate::commands::files::FileStore>,
    workspace: State<'_, crate::commands::workspace::WorkspaceStore>,
    token: String,
    markdown_content: InputText,
    document_token: Option<String>,
) -> Result<(), String> {
    let op = store.begin(window.label(), &[(&token, Purpose::Docx)])?;
    let owner = window.label().to_owned();
    let files = files.inner().clone();
    let workspace = workspace.for_window(&owner)?;
    tauri::async_runtime::spawn_blocking(move || {
        let exe = find_pandoc_path().ok_or("未检测到可用的 Pandoc，请先安装 Pandoc。")?;
        conversion::export_docx(&op, &markdown_content.0, &exe, &NativeRunner, |relative| {
            op.check()?;
            let token = document_token
                .as_deref()
                .ok_or("本地 Word 图片需要已授权的 Markdown 文档，请先保存文档。")?;
            let roots = workspace.lock().map_err(|e| e.to_string())?.roots();
            let mut files = files.lock().map_err(|e| e.to_string())?;
            files.set_owner(&owner);
            files
                .markdown_image(token, relative, &roots, true)
                .map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pandoc_import_docx(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    source_token: String,
    target_token: String,
) -> Result<String, String> {
    let op = store.begin(
        window.label(),
        &[
            (&source_token, Purpose::ReadDocx),
            (&target_token, Purpose::Markdown),
        ],
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let exe = find_pandoc_path().ok_or("未检测到可用的 Pandoc，请先安装 Pandoc。")?;
        conversion::import_docx(&op, &exe, &NativeRunner)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn print_to_pdf(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    token: String,
    html_content: InputText,
    options: Option<PdfPrintOptions>,
) -> Result<(), String> {
    let op = store.begin(window.label(), &[(&token, Purpose::Pdf)])?;
    tauri::async_runtime::spawn_blocking(move || {
        let _ = options;
        conversion::export_pdf(&op, |output| render_pdf(&app, &op, &html_content.0, output))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(not(windows))]
fn render_pdf(
    _app: &AppHandle,
    _op: &conversion::Operation,
    _html: &str,
    _output: &Path,
) -> Result<(), String> {
    Err("当前平台暂未实现原生 PDF 导出能力。".into())
}
#[cfg(windows)]
struct PdfWorkspace(Option<tempfile::TempDir>);
#[cfg(windows)]
impl PdfWorkspace {
    fn new() -> Result<Self, String> {
        tempfile::Builder::new()
            .prefix("markumo-pdf-")
            .tempdir()
            .map(|dir| Self(Some(dir)))
            .map_err(|e| e.to_string())
    }
    fn path(&self) -> &Path {
        self.0.as_ref().unwrap().path()
    }
}
#[cfg(windows)]
impl Drop for PdfWorkspace {
    fn drop(&mut self) {
        let Some(directory) = self.0.take() else {
            return;
        };
        let path = directory.path().to_path_buf();
        if directory.close().is_err() {
            // WebView2 releases its isolated profile asynchronously after
            // destruction. Retry only this native-owned random directory.
            std::thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    match std::fs::remove_dir_all(&path) {
                        Ok(()) => break,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                        Err(_) if Instant::now() < deadline => {
                            std::thread::sleep(Duration::from_millis(100))
                        }
                        Err(e) => {
                            eprintln!("临时打印数据清理失败，请删除 {}: {e}", path.display());
                            break;
                        }
                    }
                }
            });
        }
    }
}
#[cfg(windows)]
fn render_pdf(
    app: &AppHandle,
    op: &conversion::Operation,
    html: &str,
    output: &Path,
) -> Result<(), String> {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    };
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfCompletedHandler};
    use windows_core::Interface;
    let work = Arc::new(PdfWorkspace::new()?);
    let input = work.path().join("print.html");
    std::fs::write(&input, conversion::print_html(html)?).map_err(|e| e.to_string())?;
    let url = url::Url::from_file_path(&input).map_err(|_| "打印文件 URL 无效")?;
    let allowed = url.clone();
    let window = WebviewWindowBuilder::new(
        app,
        format!("pdf-print-{}", conversion::random_id()?),
        WebviewUrl::External(url),
    )
    .on_navigation(move |url| url == &allowed)
    .data_directory(work.path().join("webview-profile"))
    .visible(false)
    .decorations(false)
    .title("Markumo PDF Export")
    .build()
    .map_err(|e| format!("创建打印容器失败: {e}"))?;
    let alive = Arc::new(AtomicBool::new(true));
    let close_window = window.clone();
    let close_alive = alive.clone();
    let _cleanup = conversion::Cleanup::new(move || {
        close_alive.store(false, Ordering::Release);
        if let Err(e) = close_window.destroy() {
            eprintln!("销毁 PDF 打印窗口失败: {e}");
        }
    });
    let generated = work.path().join("printed.pdf");
    let (tx, rx) = mpsc::channel();
    let print_output = generated.clone();
    let job_alive = alive.clone();
    let job_work = work.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1200));
        if !job_alive.load(Ordering::Acquire) {
            return;
        }
        let failed = tx.clone();
        let result = window.with_webview(move |wv| {
            let work = job_work;
            if !job_alive.load(Ordering::Acquire) {
                return;
            }
            let result = (|| -> Result<(), String> {
                let controller = wv.controller();
                let core = unsafe { controller.CoreWebView2() }.map_err(|e| e.to_string())?;
                let core7: ICoreWebView2_7 = core.cast().map_err(|e| e.to_string())?;
                let wide: Vec<u16> = print_output
                    .to_string_lossy()
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let completed = tx.clone();
                let handler =
                    PrintToPdfCompletedHandler::create(Box::new(move |error, success| {
                        let _retain_temporary_resources = &work;
                        let result = if success && error.is_ok() {
                            Ok(())
                        } else {
                            Err(format!("WebView2 导出 PDF 失败: {error:?}"))
                        };
                        let _ = completed.send(result);
                        Ok(())
                    }));
                unsafe {
                    core7.PrintToPdf(
                        windows_core::PCWSTR::from_raw(wide.as_ptr()),
                        None,
                        Some(&handler),
                    )
                }
                .map_err(|e| e.to_string())
            })();
            if let Err(e) = result {
                let _ = tx.send(Err(e));
            }
        });
        if let Err(e) = result {
            let _ = failed.send(Err(e.to_string()));
        }
    });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        op.check()?;
        if std::fs::metadata(&generated).is_ok_and(|m| m.len() > conversion::MAX_OUTPUT as u64) {
            return Err("PDF 输出超过 16 MiB".into());
        }
        if Instant::now() >= deadline {
            return Err("导出 PDF 超时（30 秒）".into());
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => {
                result?;
                let bytes = conversion::read_bounded(&generated, conversion::MAX_OUTPUT)?;
                conversion::validate_pdf(&bytes)?;
                return std::fs::write(output, bytes).map_err(|e| format!("暂存 PDF 失败: {e}"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(e) => return Err(format!("打印回调丢失: {e}")),
        }
    }
}
