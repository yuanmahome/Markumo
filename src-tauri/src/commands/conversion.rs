use crate::conversion::{self, ConversionStore, InputText, Purpose, Selection};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PdfPrintOptions {
    pub paper_size: Option<String>,
    pub orientation: Option<String>,
    pub margins: Option<String>,
    pub print_background: Option<bool>,
}

#[tauri::command]
pub async fn export_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    files: State<'_, crate::commands::files::FileStore>,
    default_name: String,
    format: String,
    document_token: Option<String>,
    default_directory: Option<String>,
) -> Result<Option<Selection>, String> {
    let purpose = Purpose::write(&format)?;
    let permit = store.dialog(window.label())?;
    let store = store.inner().clone();
    let files = files.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let source = export_document_path(&files, window.label(), document_token.as_deref());
        // The preference is a dialog hint only, never a file capability.
        // Only store.selected after native confirmation authorizes the output.
        let directory = export_directory(
            source.as_deref(),
            default_directory.as_deref(),
            app.path().document_dir().ok(),
        );
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(default_name)
            .set_title("导出文档");
        if let Some(directory) = directory {
            dialog = dialog.set_directory(directory);
        }
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

fn export_document_path(
    files: &crate::commands::files::FileStore,
    owner: &str,
    token: Option<&str>,
) -> Option<PathBuf> {
    let token = token?;
    let mut service = files.lock().ok()?;
    service.set_owner(owner);
    service.revealed_path(token).ok()
}

fn export_directory(
    source: Option<&Path>,
    configured: Option<&str>,
    documents: Option<PathBuf>,
) -> Option<PathBuf> {
    fn usable(path: &Path) -> bool {
        path.is_absolute() && path.is_dir() && std::fs::read_dir(path).is_ok()
    }
    source
        .and_then(Path::parent)
        .filter(|path| usable(path))
        .map(Path::to_path_buf)
        .or_else(|| {
            configured
                .map(Path::new)
                .filter(|path| usable(path))
                .map(Path::to_path_buf)
        })
        .or_else(|| documents.filter(|path| usable(path)))
}

#[cfg(test)]
mod export_directory_tests {
    use super::*;
    #[test]
    fn document_hint_requires_a_current_window_grant_and_existing_source() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("系统理解.md");
        std::fs::write(&path, "# 中文").unwrap();
        let files = crate::commands::files::FileStore::default();
        let opened = {
            let mut service = files.lock().unwrap();
            service.set_owner("a");
            service.open_selected(path.clone(), None).unwrap()
        };
        assert!(export_document_path(&files, "a", None).is_none());
        assert!(export_document_path(&files, "a", Some("forged")).is_none());
        assert!(export_document_path(&files, "b", Some(&opened.metadata.token)).is_none());
        assert!(export_document_path(&files, "a", Some(&opened.metadata.token)).is_some());
        std::fs::remove_file(&path).unwrap();
        assert!(export_document_path(&files, "a", Some(&opened.metadata.token)).is_none());
    }
    #[test]
    fn current_document_precedes_preference_and_missing_directories_fall_back() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("中文 空格 😀");
        let configured = temp.path().join("configured");
        let documents = temp.path().join("documents");
        for dir in [&source, &configured, &documents] {
            std::fs::create_dir(dir).unwrap();
        }
        let file = source.join("系统理解.md");
        assert_eq!(
            export_directory(Some(&file), configured.to_str(), Some(documents.clone())),
            Some(source.clone())
        );
        assert_eq!(
            export_directory(None, configured.to_str(), Some(documents.clone())),
            Some(configured.clone())
        );
        std::fs::remove_dir(&source).unwrap();
        assert_eq!(
            export_directory(Some(&file), configured.to_str(), Some(documents.clone())),
            Some(configured.clone())
        );
        std::fs::remove_dir(&configured).unwrap();
        assert_eq!(
            export_directory(Some(&file), configured.to_str(), Some(documents.clone())),
            Some(documents.clone())
        );
        assert_eq!(
            export_directory(None, Some("relative"), Some(documents.clone())),
            Some(documents)
        );
        assert_eq!(export_directory(None, None, None), None);
    }
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
/// Binary bodies avoid copying large payloads into JSON number arrays.
#[tauri::command]
pub async fn save_conversion_bytes(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let token = request
        .headers()
        .get("x-markumo-conversion-token")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少转换目标授权")?;
    let format = request
        .headers()
        .get("x-markumo-conversion-format")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少转换格式")?;
    let purpose = Purpose::write(format)?;
    if !matches!(purpose, Purpose::Docx | Purpose::Png | Purpose::Html) {
        return Err("不支持的二进制转换格式".into());
    }
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("转换输出需要原始二进制请求".into());
    };
    if bytes.len() > conversion::MAX_OUTPUT {
        return Err("转换输出超过 16 MiB".into());
    }
    let op = store.begin(window.label(), &[(token, purpose)])?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || conversion::save_binary(&op, &bytes))
        .await
        .map_err(|e| e.to_string())?
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
pub async fn prepare_docx_import(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    source_token: String,
) -> Result<conversion::PreparedImport, String> {
    let op = store.begin(window.label(), &[(&source_token, Purpose::ReadDocx)])?;
    tauri::async_runtime::spawn_blocking(move || {
        op.verify(0)?;
        if !op
            .path(0)
            .extension()
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.eq_ignore_ascii_case("docx"))
        {
            return Err("只支持 .docx；请将 .doc、.docm 或加密文档另存为标准 DOCX".into());
        }
        let bytes = conversion::read_bounded(op.path(0), conversion::MAX_OUTPUT)?;
        let document = conversion::docx::parse(&bytes, &|| op.check())?;
        op.stage_import(document)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[derive(Serialize)]
pub struct ImportedDocument {
    #[serde(flatten)]
    summary: conversion::ImportSummary,
    file: Option<crate::files::OpenFile>,
}
#[tauri::command]
pub async fn commit_docx_import(
    window: WebviewWindow,
    store: State<'_, ConversionStore>,
    files: State<'_, crate::commands::files::FileStore>,
    draft_token: String,
    target_token: String,
) -> Result<ImportedDocument, String> {
    let (op, document) = store.begin_import(window.label(), &draft_token, &target_token)?;
    let files = files.inner().clone();
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let mut summary = conversion::commit_import(&op, document)?;
        let file = if op.check().is_ok() {
            match files.lock() {
                Ok(mut files) => {
                    files.set_owner(&owner);
                    match files.open_selected(op.path(1).to_owned(), None) {
                        Ok(f) => Some(f),
                        Err(e) => {
                            summary.warnings.push(conversion::docx::ast::Warning {
                                kind: "open".into(),
                                message: format!("导入已保存到 {}，但打开失败：{e}", summary.path),
                            });
                            None
                        }
                    }
                }
                Err(_) => {
                    summary.warnings.push(conversion::docx::ast::Warning {
                        kind: "open".into(),
                        message: format!(
                            "导入已保存到 {}；文件服务暂不可用，请稍后打开。",
                            summary.path
                        ),
                    });
                    None
                }
            }
        } else {
            None
        };
        Ok(ImportedDocument { summary, file })
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
    use webview2_com::{
        ExecuteScriptCompletedHandler, Microsoft::Web::WebView2::Win32::*,
        PrintToPdfCompletedHandler,
    };
    use windows_core::Interface;
    let work = Arc::new(PdfWorkspace::new()?);
    let input = work.path().join("print.html");
    std::fs::write(&input, conversion::print_html(html)?).map_err(|e| e.to_string())?;
    let url = url::Url::from_file_path(&input).map_err(|_| "打印文件 URL 无效")?;
    let allowed = url.clone();
    let loaded = Arc::new(AtomicBool::new(false));
    let page_loaded = loaded.clone();
    let window = WebviewWindowBuilder::new(
        app,
        format!("pdf-print-{}", conversion::random_id()?),
        WebviewUrl::External(url),
    )
    .on_page_load(move |_, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            page_loaded.store(true, Ordering::Release);
        }
    })
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
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut stable = 0;
        while stable < 2 {
            if !job_alive.load(Ordering::Acquire) {
                return;
            }
            if Instant::now() >= deadline {
                let _ = tx.send(Err("打印资源准备超时".into()));
                return;
            }
            if !loaded.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            let (ready_tx, ready_rx) = mpsc::channel();
            // Fixed host-owned read-only probe. Document scripts remain forbidden by CSP.
            let probe = window.with_webview(move |wv| {
                let result = (|| -> Result<(), String> {
                    let core = unsafe { wv.controller().CoreWebView2() }.map_err(|e| e.to_string())?;
                    let script = windows_core::HSTRING::from("document.readyState === 'complete' && document.fonts.status === 'loaded' && Array.from(document.images).every(i => i.complete) && Array.from(document.querySelectorAll('svg')).every(s => s.getBoundingClientRect().width > 0)");
                    let completed = ready_tx.clone();
                    let handler = ExecuteScriptCompletedHandler::create(Box::new(move |error, value| {
                        let _ = completed.send(error.is_ok() && value == "true"); Ok(())
                    }));
                    unsafe { core.ExecuteScript(&script, &handler) }.map_err(|e| e.to_string())
                })();
                if result.is_err() { let _ = ready_tx.send(false); }
            });
            if probe.is_ok()
                && ready_rx
                    .recv_timeout(Duration::from_secs(1))
                    .unwrap_or(false)
            {
                stable += 1
            } else {
                stable = 0
            }
            std::thread::sleep(Duration::from_millis(50));
        }
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
