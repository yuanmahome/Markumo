use crate::files::{
    FileError, FileMetadata, FileService, Layout, OpenBatch, OpenFile, Preferences, Result,
    SaveTarget,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, State, Window};
use tauri_plugin_dialog::DialogExt;

pub type FileStore = Arc<Mutex<FileService>>;

/// Global cap for concurrent media chunk reads. Four 256 KiB reads keep the
/// native peak bounded while allowing one image plus several PDF range requests.
const MAX_MEDIA_READS: usize = 4;
static ACTIVE_MEDIA_READS: AtomicUsize = AtomicUsize::new(0);

/// RAII reservation for one media read. The permit is dropped on success, on
/// every error path, and while unwinding a failed blocking task.
struct MediaReadPermit;

impl MediaReadPermit {
    fn acquire() -> Option<Self> {
        let mut active = ACTIVE_MEDIA_READS.load(Ordering::Acquire);
        loop {
            if active >= MAX_MEDIA_READS {
                return None;
            }
            match ACTIVE_MEDIA_READS.compare_exchange_weak(
                active,
                active + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self),
                Err(actual) => active = actual,
            }
        }
    }
}

impl Drop for MediaReadPermit {
    fn drop(&mut self) {
        ACTIVE_MEDIA_READS.fetch_sub(1, Ordering::AcqRel);
    }
}

#[tauri::command]
pub async fn media_metadata(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
) -> Result<(crate::files::media::MediaMetadata, String)> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.media_metadata(&token)
    })
    .await
}
#[tauri::command]
pub async fn read_media_chunk(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    expected_version: String,
    offset: u64,
    length: usize,
) -> Result<tauri::ipc::Response> {
    let _permit = MediaReadPermit::acquire()
        .ok_or_else(|| FileError::new("busy", "媒体读取繁忙，请稍后重新加载。"))?;
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.read_media_chunk(&token, &expected_version, offset, length)
            .map(tauri::ipc::Response::new)
    })
    .await
}
#[tauri::command]
pub async fn open_media_default(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
) -> Result<()> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        let path = s.media_path(&token)?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    wide.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                )
            };
            if result as isize <= 32 {
                return Err(FileError::new(
                    "open",
                    "系统默认程序无法打开此文件，请检查文件关联。",
                ));
            }
        }
        #[cfg(not(windows))]
        {
            let command = if cfg!(target_os = "macos") {
                "open"
            } else {
                "xdg-open"
            };
            std::process::Command::new(command)
                .arg(&path)
                .spawn()
                .map_err(FileError::io)?;
        }
        Ok(())
    })
    .await
}

async fn operate<T: Send + 'static>(
    store: FileStore,
    owner: String,
    action: impl FnOnce(&mut FileService) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut service = store
            .lock()
            .map_err(|_| FileError::new("state", "文件服务不可用，编辑内容仍保留。"))?;
        service.set_owner(&owner);
        action(&mut service)
    })
    .await
    .map_err(|error| FileError::new("task", &error.to_string()))?
}

#[tauri::command]
pub async fn open_dialog(
    app: AppHandle,
    window: Window,
    store: State<'_, FileStore>,
    encoding: Option<String>,
) -> Result<OpenBatch> {
    let owner = window.label().to_owned();
    let paths = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_files()
    })
    .await
    .map_err(|error| FileError::new("dialog", &error.to_string()))?;
    operate(store.inner().clone(), owner, move |service| {
        let mut paths_buf = Vec::new();
        let mut errors = Vec::new();
        for file in paths.unwrap_or_default() {
            match file.into_path() {
                Ok(path) => paths_buf.push(path),
                Err(error) => errors.push(error.to_string()),
            }
        }
        let mut batch = service.open_batch(paths_buf, encoding.as_deref());
        batch.errors.extend(errors);
        Ok(batch)
    })
    .await
}

#[tauri::command]
pub async fn save_dialog(
    app: AppHandle,
    window: Window,
    store: State<'_, FileStore>,
    source_token: Option<String>,
    name: String,
) -> Result<Option<SaveTarget>> {
    let owner = window.label().to_owned();
    let filename = PathBuf::from(name)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Untitled.txt".into());
    // The native save dialog cannot report which filter the user selected, so
    // the default type is derived from the document before the dialog opens and
    // is applied only when the typed name has no extension of its own.
    let default_extension = default_save_extension(&filename);
    let dialog_extension = default_extension.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(filename)
            .set_title("保存文件");
        for (label, extensions) in ordered_save_filters(&dialog_extension) {
            dialog = dialog.add_filter(label, &extensions);
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|error| FileError::new("dialog", &error.to_string()))?;
    operate(
        store.inner().clone(),
        owner,
        move |service| match selected {
            Some(path) => {
                let chosen = path
                    .into_path()
                    .map_err(|error| FileError::new("path", &error.to_string()))?;
                service
                    .prepare_target(
                        complete_save_extension(chosen, &default_extension),
                        source_token.as_deref(),
                    )
                    .map(Some)
            }
            None => Ok(None),
        },
    )
    .await
}

/// Save-dialog filters. The list intentionally covers every extension this
/// product registers for editing; unsupported binary formats are not offered as
/// if they were fully editable.
const SAVE_FILTERS: &[(&str, &[&str])] = &[
    ("文本文档 (*.txt)", &["txt"]),
    ("Markdown (*.md; *.markdown)", &["md", "markdown"]),
    ("JSON (*.json; *.jsonc)", &["json", "jsonc"]),
    ("JavaScript (*.js; *.jsx)", &["js", "jsx"]),
    ("TypeScript (*.ts; *.tsx)", &["ts", "tsx"]),
    ("HTML (*.html; *.htm)", &["html", "htm"]),
    ("CSS (*.css; *.scss)", &["css", "scss"]),
    ("Vue (*.vue)", &["vue"]),
    ("XML (*.xml)", &["xml"]),
    ("YAML (*.yaml; *.yml)", &["yaml", "yml"]),
    ("Java (*.java)", &["java"]),
    ("Python (*.py)", &["py"]),
    ("Go (*.go)", &["go"]),
    ("Rust (*.rs)", &["rs"]),
    ("SQL (*.sql)", &["sql"]),
    ("Shell (*.sh; *.bat; *.cmd)", &["sh", "bat", "cmd"]),
    (
        "日志与配置 (*.log; *.ini; *.cfg; *.conf; *.properties)",
        &["log", "ini", "cfg", "conf", "properties"],
    ),
    ("所有文件 (*.*)", &["*"]),
];

fn extension_of(name: &str) -> Option<String> {
    Path::new(name)
        .extension()
        .map(|extension| {
            extension
                .to_string_lossy()
                .trim_start_matches('.')
                .to_ascii_lowercase()
        })
        .filter(|extension| !extension.is_empty())
}

/// The default type for a document: its own extension, otherwise plain text.
/// A "new Markdown document" already carries `.md` in its seed name.
fn default_save_extension(name: &str) -> String {
    extension_of(name).unwrap_or_else(|| "txt".into())
}

/// Filter order for the native dialog: the document's own type first so the
/// common case needs no interaction, then the remaining types in a stable order.
fn ordered_save_filters(default_extension: &str) -> Vec<(&'static str, Vec<&'static str>)> {
    let mut ordered: Vec<(&'static str, Vec<&'static str>)> = SAVE_FILTERS
        .iter()
        .map(|(label, extensions)| (*label, extensions.to_vec()))
        .collect();
    if let Some(index) = ordered.iter().position(|(_, extensions)| {
        extensions
            .iter()
            .any(|extension| extension.eq_ignore_ascii_case(default_extension))
    }) {
        let preferred = ordered.remove(index);
        ordered.insert(0, preferred);
    }
    ordered
}

/// Complete a user-typed name with the document's default extension. An explicit
/// extension is always respected, so `README.md` never becomes `README.md.txt`.
/// Trailing dots/spaces (which Windows ignores) are trimmed before completing.
fn complete_save_extension(path: PathBuf, default_extension: &str) -> PathBuf {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return path;
    };
    if extension_of(name).is_some() {
        return path;
    }
    let base = name.trim_end_matches(['.', ' ']);
    if base.is_empty() || default_extension.is_empty() {
        return path;
    }
    path.with_file_name(format!("{base}.{default_extension}"))
}

#[tauri::command]
pub async fn open_recent(
    window: Window,
    store: State<'_, FileStore>,
    path: String,
    encoding: Option<String>,
) -> Result<OpenFile> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, move |service| {
        service.open_recent(&path, encoding.as_deref())
    })
    .await
}
#[tauri::command]
pub async fn reopen_file(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    encoding: String,
) -> Result<OpenFile> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, move |service| {
        service.reopen(&token, &encoding)
    })
    .await
}
#[tauri::command]
pub async fn save_file(
    window: Window,
    store: State<'_, FileStore>,
    history: State<'_, Arc<Mutex<crate::history::HistoryStore>>>,
    token: String,
    text: String,
    expected_version: Option<String>,
    encoding: String,
    bom: bool,
) -> Result<FileMetadata> {
    let owner = window.label().to_owned();
    let history = history.inner().clone();
    operate(store.inner().clone(), owner, move |service| {
        let history = history.lock().map_err(|_| FileError::new("history_backup", "历史存储状态损坏，未执行保存。"))?;
        service.save_with_history(&token, &text, expected_version.as_deref(), &encoding, bom, &history)
    })
    .await
}
#[tauri::command]
pub async fn release_file(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
) -> Result<()> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, move |service| {
        service.release(&token);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn check_external_file(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
) -> Result<String> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.check_external(&token)
    })
    .await
}
#[tauri::command]
pub async fn read_external_file(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    expected_version: String,
    encoding: String,
) -> Result<OpenFile> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.read_external(&token, &expected_version, &encoding)
    })
    .await
}
#[tauri::command]
pub async fn watch_external_files(
    window: Window,
    store: State<'_, FileStore>,
    tokens: Vec<String>,
    generation: u64,
    lease: u64,
) -> Result<crate::files::external::WatchStatus> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.watch_external(tokens, generation, lease)
    })
    .await
}
#[tauri::command]
pub async fn begin_external_watch(window: Window, store: State<'_, FileStore>) -> Result<u64> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        Ok(s.begin_external_watch())
    })
    .await
}
#[tauri::command]
pub async fn end_external_watch(
    window: Window,
    store: State<'_, FileStore>,
    lease: u64,
) -> Result<()> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.end_external_watch(lease);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn read_class_hex(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    expected_version: String,
    offset: usize,
) -> Result<crate::files::classfile::HexPage> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, move |service| {
        service.read_class_hex(&token, &expected_version, offset)
    })
    .await
}

#[tauri::command]
pub async fn read_markdown_image(
    window: Window,
    store: State<'_, FileStore>,
    workspace: State<'_, crate::commands::workspace::WorkspaceStore>,
    token: String,
    relative: String,
    full: Option<bool>,
) -> Result<tauri::ipc::Response> {
    let owner = window.label().to_owned();
    let workspace = workspace
        .for_window(window.label())
        .map_err(|e| FileError::new("state", &e))?;
    let roots = tauri::async_runtime::spawn_blocking(move || {
        workspace
            .lock()
            .map(|service| service.roots())
            .map_err(|_| FileError::new("state", "工作区授权不可用。"))
    })
    .await
    .map_err(|error| FileError::new("task", &error.to_string()))??;
    operate(store.inner().clone(), owner, move |service| {
        service
            .markdown_image(&token, &relative, &roots, full.unwrap_or(false))
            .map(tauri::ipc::Response::new)
    })
    .await
}

#[tauri::command]
pub async fn reveal_markdown_image(
    window: Window,
    store: State<'_, FileStore>,
    workspace: State<'_, crate::commands::workspace::WorkspaceStore>,
    token: String,
    relative: String,
) -> Result<()> {
    let owner = window.label().to_owned();
    let workspace = workspace
        .for_window(window.label())
        .map_err(|e| FileError::new("state", &e))?;
    let _roots = tauri::async_runtime::spawn_blocking(move || {
        workspace
            .lock()
            .map(|service| service.roots())
            .map_err(|_| FileError::new("state", "工作区授权不可用。"))
    })
    .await
    .map_err(|error| FileError::new("task", &error.to_string()))??;
    operate(store.inner().clone(), owner, move |service| {
        let path = service.resolve_image(&token, &relative)?;
        crate::commands::workspace::reveal_path(&path).map_err(|e| FileError::new("reveal", &e))
    })
    .await
}

#[tauri::command]
pub async fn open_markdown_image_default(
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    relative: String,
) -> Result<()> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, move |service| {
        let path = service.resolve_image(&token, &relative)?;
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            wide.push(0);
            unsafe {
                ShellExecuteW(std::ptr::null_mut(), std::ptr::null(), wide.as_ptr(), std::ptr::null(), std::ptr::null(), 1);
            }
        }
        #[cfg(target_os = "macos")]
        let _ = std::process::Command::new("open").arg(&path).spawn();
        #[cfg(all(unix, not(target_os = "macos")))]
        let _ = std::process::Command::new("xdg-open").arg(&path).spawn();
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn choose_markdown_images(
    app: AppHandle,
    window: Window,
    store: State<'_, FileStore>,
) -> Result<Vec<crate::files::images::ImageInput>> {
    let owner = window.label().to_owned();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_files()
    })
    .await
    .map_err(|e| FileError::new("dialog", &e.to_string()))?;
    let paths = selected
        .unwrap_or_default()
        .into_iter()
        .map(|p| {
            p.into_path()
                .map_err(|e| FileError::new("path", &e.to_string()))
        })
        .collect::<Result<Vec<_>>>()?;
    operate(store.inner().clone(), owner, move |s| {
        Ok(s.image_inputs(paths))
    })
    .await
}

#[tauri::command]
pub async fn import_markdown_image(
    window: Window,
    store: State<'_, FileStore>,
    input: crate::files::images::ImageImport,
) -> Result<crate::files::images::ImportedImage> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.import_image(input)
    })
    .await
}

#[tauri::command]
pub async fn authorize_markdown_image_directory(
    app: AppHandle,
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    relative: String,
) -> Result<bool> {
    let owner = window.label().to_owned();
    let t = token.clone();
    let r = relative.clone();
    let target = operate(store.inner().clone(), owner.clone(), move |s| {
        s.image_directory(&t, &r)
    })
    .await?;
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title(format!("授权图片目录：{}", target.display()))
            .set_directory(&target)
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| FileError::new("dialog", &e.to_string()))?;
    let Some(selected) = selected else {
        return Ok(false);
    };
    let path = selected
        .into_path()
        .map_err(|e| FileError::new("path", &e.to_string()))?;
    operate(store.inner().clone(), owner, move |s| {
        s.authorize_image_directory(&token, &relative, &path)?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub async fn authorize_markdown_image_read(
    app: AppHandle,
    window: Window,
    store: State<'_, FileStore>,
    token: String,
    relative: String,
) -> Result<bool> {
    let owner = window.label().to_owned();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .set_title("授权 Markdown 引用的本地图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| FileError::new("dialog", &e.to_string()))?;
    let Some(selected) = selected else {
        return Ok(false);
    };
    let selected = selected
        .into_path()
        .map_err(|e| FileError::new("path", &e.to_string()))?;
    operate(store.inner().clone(), owner, move |s| {
        s.authorize_image_read(&token, &relative, &selected)?;
        Ok(true)
    })
    .await
}

#[tauri::command]
pub async fn release_image_inputs(
    window: Window,
    store: State<'_, FileStore>,
    tokens: Vec<String>,
) -> Result<()> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        s.release_image_inputs(&tokens);
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn open_dropped_files(
    window: Window,
    store: State<'_, FileStore>,
    tokens: Vec<String>,
) -> Result<OpenBatch> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        Ok(s.open_image_inputs(&tokens))
    })
    .await
}

#[tauri::command]
pub async fn clipboard_image_files(
    window: Window,
    store: State<'_, FileStore>,
) -> Result<Vec<crate::files::images::ImageInput>> {
    operate(store.inner().clone(), window.label().into(), move |s| {
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStringExt;
            use windows_sys::Win32::{
                System::DataExchange::{
                    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
                },
                UI::Shell::DragQueryFileW,
            };
            struct Clipboard;
            impl Drop for Clipboard {
                fn drop(&mut self) {
                    unsafe {
                        CloseClipboard();
                    }
                }
            }
            unsafe {
                if IsClipboardFormatAvailable(15) == 0 {
                    return Ok(Vec::new());
                }
                if OpenClipboard(std::ptr::null_mut()) == 0 {
                    return Err(FileError::new("clipboard", "系统剪贴板暂不可用，请重试。"));
                }
                let _clipboard = Clipboard;
                let handle = GetClipboardData(15);
                if handle.is_null() {
                    return Ok(Vec::new());
                }
                let mut paths = Vec::new();
                for index in 0..DragQueryFileW(handle, u32::MAX, std::ptr::null_mut(), 0).min(100) {
                    let len = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
                    if len == 0 || len > 32768 {
                        continue;
                    }
                    let mut buffer = vec![0u16; len as usize + 1];
                    DragQueryFileW(handle, index, buffer.as_mut_ptr(), len + 1);
                    paths.push(PathBuf::from(std::ffi::OsString::from_wide(
                        &buffer[..len as usize],
                    )));
                }
                Ok(s.image_inputs(paths))
            }
        }
        #[cfg(not(windows))]
        {
            let _ = s;
            Ok(Vec::new())
        }
    })
    .await
}
#[tauri::command]
pub async fn drain_pending(
    window: Window,
    launches: State<'_, crate::session::LaunchStore>,
    store: State<'_, FileStore>,
) -> Result<OpenBatch> {
    let owner = window.label().to_owned();
    let paths = {
        let mut registry = launches
            .lock()
            .map_err(|_| FileError::new("state", "启动状态不可用"))?;
        let launch = registry
            .windows
            .get_mut(&owner)
            .ok_or_else(|| FileError::new("state", "窗口未注册"))?;
        std::mem::take(&mut launch.pending)
    };
    operate(store.inner().clone(), owner, move |service| {
        Ok(service.open_batch(paths, None))
    })
    .await
}
#[tauri::command]
pub async fn file_preferences(window: Window, store: State<'_, FileStore>) -> Result<Preferences> {
    let owner = window.label().to_owned();
    operate(store.inner().clone(), owner, |service| {
        Ok(service.preferences.clone())
    })
    .await
}
#[tauri::command]
pub async fn persist_layout(
    window: Window,
    launches: State<'_, crate::session::LaunchStore>,
    store: State<'_, FileStore>,
    layout: Layout,
) -> Result<()> {
    let owner = window.label().to_owned();
    if launches
        .lock()
        .map_err(|_| FileError::new("state", "启动状态不可用"))?
        .owner()
        .as_deref()
        != Some(&owner)
    {
        return Ok(());
    }
    operate(store.inner().clone(), owner, move |service| {
        service.set_layout(layout)
    })
    .await
}
