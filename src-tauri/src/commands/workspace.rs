use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, State, Window};
use tauri_plugin_dialog::DialogExt;

use crate::{
    commands::files::FileStore,
    files::OpenFile,
    workspace::{
        SearchManager, SearchMatch, SearchQuery, WorkspaceInfo, WorkspaceNode, WorkspaceSearcher,
        WorkspaceService,
    },
};

#[derive(Default)]
pub struct WorkspaceStore {
    windows: Mutex<std::collections::HashMap<String, Arc<Mutex<WorkspaceService>>>>,
}
impl WorkspaceStore {
    pub fn insert(&self, label: &str, service: WorkspaceService) -> Result<(), String> {
        self.windows
            .lock()
            .map_err(|e| e.to_string())?
            .insert(label.into(), Arc::new(Mutex::new(service)));
        Ok(())
    }
    pub fn for_window(&self, label: &str) -> Result<Arc<Mutex<WorkspaceService>>, String> {
        self.windows
            .lock()
            .map_err(|e| e.to_string())?
            .get(label)
            .cloned()
            .ok_or_else(|| "窗口工作区尚未初始化".into())
    }
    pub fn remove(&self, label: &str) {
        if let Ok(mut windows) = self.windows.lock() {
            windows.remove(label);
        }
    }
}

#[derive(Serialize, Clone)]
pub struct SearchDonePayload {
    pub search_id: String,
    pub total: usize,
    pub canceled: bool,
    pub limited: bool,
    pub skipped: usize,
    pub reason: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn open_workspace_dialog(
    app: AppHandle,
    window: Window,
    store: State<'_, WorkspaceStore>,
    add: Option<bool>,
) -> Result<Option<WorkspaceInfo>, String> {
    let store = store.for_window(window.label())?;

    let folder = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let path = match folder {
        Some(f) => f.into_path().map_err(|e| e.to_string())?,
        None => return Ok(None),
    };

    let service = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let mut svc = service.lock().map_err(|e| e.to_string())?;
        if add.unwrap_or(false) {
            svc.add_workspace(path).map(Some)
        } else {
            svc.open_workspace(path).map(Some)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_dropped_workspace(
    window: Window,
    files: State<'_, FileStore>,
    store: State<'_, WorkspaceStore>,
    token: String,
) -> Result<WorkspaceInfo, String> {
    let service = store.for_window(window.label())?;
    let files = Arc::clone(files.inner());
    let owner = window.label().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let path = {
            let mut files = files.lock().map_err(|e| e.to_string())?;
            files.set_owner(&owner);
            files
                .take_dropped_directory(&token)
                .map_err(|e| e.to_string())?
        };
        // Adding preserves existing roots and unsaved editor tabs. With no root,
        // add_workspace uses the normal initial-workspace opening flow.
        let result = service
            .lock()
            .map_err(|e| e.to_string())?
            .add_workspace(path);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn remove_workspace_folder(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
) -> Result<(), String> {
    let store = store.for_window(window.label())?;

    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .remove_workspace(std::path::Path::new(&path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn restore_workspace_folders(
    window: Window,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<WorkspaceInfo>, String> {
    let store = store.for_window(window.label())?;

    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        store
            .lock()
            .map_err(|e| e.to_string())?
            .restore_workspaces()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_workspace_path(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
    add: Option<bool>,
) -> Result<WorkspaceInfo, String> {
    let store = store.for_window(window.label())?;

    let path_buf = PathBuf::from(path);
    let service = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let mut svc = service.lock().map_err(|e| e.to_string())?;
        if !svc
            .recent_workspaces()
            .iter()
            .any(|p| std::path::Path::new(p) == path_buf.as_path())
        {
            return Err("目录尚未授权；请通过目录选择对话框打开".into());
        }
        if add.unwrap_or(false) {
            svc.add_workspace(path_buf)
        } else {
            svc.open_workspace(path_buf)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn open_workspace_file(
    window: Window,
    path: String,
    encoding: Option<String>,
    ws_store: State<'_, WorkspaceStore>,
    file_store: State<'_, FileStore>,
) -> Result<OpenFile, String> {
    let ws_store = ws_store.for_window(window.label())?;
    let owner = window.label().to_owned();

    let path_buf = PathBuf::from(&path);
    let fstore = Arc::clone(&file_store);
    let ws_store = Arc::clone(&ws_store);
    tauri::async_runtime::spawn_blocking(move || {
        let ws = ws_store.lock().map_err(|e| e.to_string())?;
        let root = ws.root_for_path(&path_buf)?;
        let valid_path = crate::workspace::guard::validate_under_root(root, &path_buf)
            .map_err(|e| e.to_string())?;
        let mut fs = fstore.lock().map_err(|e| e.to_string())?;
        fs.set_owner(&owner);
        fs.open_selected(valid_path, encoding.as_deref())
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn workspace_file_visible(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
) -> Result<bool, String> {
    let service = store.for_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|error| error.to_string())?;
        Ok(svc.file_visible(std::path::Path::new(&path)))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_directory(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<WorkspaceNode>, String> {
    let store = store.for_window(window.label())?;

    let path_buf = PathBuf::from(path);
    let service = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|e| e.to_string())?;
        svc.read_directory(&path_buf)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_workspace_file(
    window: Window,
    parent_dir: String,
    name: String,
    store: State<'_, WorkspaceStore>,
) -> Result<WorkspaceNode, String> {
    let store = store.for_window(window.label())?;

    let parent = PathBuf::from(parent_dir);
    let service = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|e| e.to_string())?;
        svc.create_file(&parent, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn create_workspace_directory(
    window: Window,
    parent_dir: String,
    name: String,
    store: State<'_, WorkspaceStore>,
) -> Result<WorkspaceNode, String> {
    let store = store.for_window(window.label())?;

    let parent = PathBuf::from(parent_dir);
    let service = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|e| e.to_string())?;
        svc.create_directory(&parent, &name)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rename_workspace_node(
    window: Window,
    old_path: String,
    new_name: String,
    ws_store: State<'_, WorkspaceStore>,
    file_store: State<'_, FileStore>,
) -> Result<(String, String), String> {
    let ws_store = ws_store.for_window(window.label())?;
    let owner = window.label().to_owned();

    let old = PathBuf::from(&old_path);
    let ws_service = Arc::clone(&ws_store);
    let f_service = Arc::clone(&file_store);
    tauri::async_runtime::spawn_blocking(move || {
        let ws = ws_service.lock().map_err(|e| e.to_string())?;
        let root = ws.root_for_path(&old)?;
        let old =
            crate::workspace::guard::validate_under_root(root, &old).map_err(|e| e.to_string())?;
        let mut fs = f_service.lock().map_err(|e| e.to_string())?;
        fs.set_owner(&owner);
        let res = ws.rename_node(&old, &new_name)?;
        let parent = old.parent().unwrap_or_else(|| std::path::Path::new(""));
        let new_path = parent.join(&new_name);
        fs.update_grant_path(&old, &new_path);
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_workspace_node(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
    file_store: State<'_, FileStore>,
) -> Result<String, String> {
    let store = store.for_window(window.label())?;

    let target = PathBuf::from(path);
    let service = Arc::clone(&store);
    let f_service = Arc::clone(&file_store);
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|e| e.to_string())?;
        let root = svc.root_for_path(&target)?;
        let valid = crate::workspace::guard::validate_under_root(root, &target)
            .map_err(|e| e.to_string())?;
        let files = f_service.lock().map_err(|e| e.to_string())?;
        if files.has_grants_under(&valid) {
            return Err("请先保存并关闭此条目内的已打开文件，再删除".into());
        }
        svc.delete_node(&target)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_workspace_node(
    window: Window,
    src_path: String,
    dest_dir: String,
    store: State<'_, WorkspaceStore>,
    file_store: State<'_, FileStore>,
) -> Result<(String, String), String> {
    let store = store.for_window(window.label())?;
    let owner = window.label().to_owned();

    let src = PathBuf::from(src_path);
    let dest = PathBuf::from(dest_dir);
    let service = Arc::clone(&store);
    let f_service = Arc::clone(&file_store);
    tauri::async_runtime::spawn_blocking(move || {
        let svc = service.lock().map_err(|e| e.to_string())?;
        let root = svc.root_for_path(&src)?;
        if svc.root_for_path(&dest)? != root {
            return Err("暂不支持跨工作区文件夹移动；请在同一文件夹内选择目标".into());
        }
        let src =
            crate::workspace::guard::validate_under_root(root, &src).map_err(|e| e.to_string())?;
        let dest =
            crate::workspace::guard::validate_under_root(root, &dest).map_err(|e| e.to_string())?;
        let mut files = f_service.lock().map_err(|e| e.to_string())?;
        files.set_owner(&owner);
        let result = svc.move_node(&src, &dest)?;
        files.update_grant_path(&src, &dest.join(src.file_name().ok_or("无效文件名")?));
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_recent_workspaces(
    window: Window,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<String>, String> {
    let store = store.for_window(window.label())?;

    let service = Arc::clone(&store);
    let svc = service.lock().map_err(|e| e.to_string())?;
    Ok(svc.recent_workspaces())
}

#[tauri::command]
pub async fn search_workspace(
    window: Window,
    query: SearchQuery,
    store: State<'_, WorkspaceStore>,
    search_manager: State<'_, SearchManager>,
) -> Result<usize, String> {
    let store = store.for_window(window.label())?;

    let roots = {
        let svc = store.lock().map_err(|e| e.to_string())?;
        let roots = svc.roots();
        if roots.is_empty() && query.scope != "opened" {
            return Err("当前未打开工作区".into());
        }
        roots
    };

    let scoped_id = format!("{}:{}", window.label(), query.search_id);
    let cancel_token = search_manager.create_token(&scoped_id);
    let search_id = query.search_id.clone();
    let sm = search_manager.inner().clone();
    let win = window.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut total = 0;
        let result = WorkspaceSearcher::execute_search_detailed(
            &roots,
            &query,
            cancel_token.clone(),
            |batch: Vec<SearchMatch>| {
                total += batch.len();
                let _ = win.emit("workspace-search-batch", batch);
            },
        );

        let canceled = cancel_token.load(std::sync::atomic::Ordering::Relaxed);

        let summary = result.as_ref().ok();
        let _ = win.emit(
            "workspace-search-done",
            SearchDonePayload {
                search_id: search_id.clone(),
                total,
                canceled,
                limited: summary.is_some_and(|s| s.limited),
                skipped: summary.map_or(0, |s| s.skipped),
                reason: summary.and_then(|s| s.reason.clone()),
                error: result.as_ref().err().cloned(),
            },
        );

        sm.cleanup(&scoped_id, &cancel_token);
        result.map(|summary| summary.total)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn set_workspace_ignored(
    window: Window,
    show: bool,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<WorkspaceNode>, String> {
    let store = store.for_window(window.label())?;

    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let mut svc = store.lock().map_err(|e| e.to_string())?;
        svc.show_ignored = show;
        let root = svc.current_root().ok_or("未打开工作区")?.to_path_buf();
        svc.read_directory(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn find_workspace_files(
    window: Window,
    query: String,
    include_ignored: bool,
    limit: Option<usize>,
    store: State<'_, WorkspaceStore>,
) -> Result<Vec<crate::workspace::search::QuickFile>, String> {
    let store = store.for_window(window.label())?;

    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let roots = store.lock().map_err(|e| e.to_string())?.roots();
        if roots.is_empty() {
            return Err("未打开工作区".into());
        }
        // The palette requests a bounded index once; a normal query keeps the
        // original small result cap.
        let limit = limit.unwrap_or(100).clamp(1, 50_000);
        crate::workspace::search::find_files_roots(&roots, &query, include_ignored, limit)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cancel_workspace_search(
    window: Window,
    search_id: String,
    search_manager: State<'_, SearchManager>,
) -> Result<(), String> {
    search_manager.cancel(&format!("{}:{}", window.label(), search_id));
    Ok(())
}

#[tauri::command]
pub async fn preview_workspace_search(
    window: Window,
    request: crate::workspace::preview::PreviewRequest,
    store: State<'_, WorkspaceStore>,
    search_manager: State<'_, SearchManager>,
) -> Result<crate::workspace::preview::SourcePreview, String> {
    let service = store.for_window(window.label())?;
    let cache = search_manager.previews.clone();
    let owner = window.label().to_string();
    let scoped_id = format!("preview:{owner}");
    let canceled = search_manager.shared_token(&scoped_id);
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let roots = service.lock().map_err(|e| e.to_string())?.roots();
            let mut cache = cache.lock().map_err(|e| e.to_string())?;
            if canceled.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("源码预览请求已取消".into());
            }
            let result = cache.read(&owner, &roots, &request);
            if canceled.load(std::sync::atomic::Ordering::Relaxed) {
                // Closing/switching while I/O was in flight must not repopulate
                // the owner's otherwise released decoded-source cache.
                cache.clear(&owner);
                return Err("源码预览请求已取消".into());
            }
            result
        })();
        result
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn clear_workspace_search_preview(
    window: Window,
    search_manager: State<'_, SearchManager>,
) -> Result<(), String> {
    let cache = search_manager.previews.clone();
    let owner = window.label().to_string();
    search_manager.cancel(&format!("preview:{owner}"));
    tauri::async_runtime::spawn_blocking(move || {
        cache.lock().map_err(|e| e.to_string())?.clear(&owner);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn choose_workspace_search_directory(
    app: AppHandle,
    window: Window,
    store: State<'_, WorkspaceStore>,
) -> Result<Option<String>, String> {
    let service = store.for_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let picked = app.dialog().file().blocking_pick_folder();
        let Some(picked) = picked else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        let workspace = service.lock().map_err(|e| e.to_string())?;
        let root = workspace.root_for_path(&path)?;
        let valid =
            crate::workspace::guard::validate_under_root(root, &path).map_err(|e| e.to_string())?;
        Ok(Some(crate::display::display_path(&valid)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn preview_workspace_replace(
    window: Window,
    query: SearchQuery,
    replacement: String,
    targets: Vec<String>,
    store: State<'_, WorkspaceStore>,
    search_manager: State<'_, SearchManager>,
) -> Result<crate::workspace::replace::ReplacePreview, String> {
    let service = store.for_window(window.label())?;
    let id = format!("{}:{}", window.label(), query.search_id);
    let token = search_manager.create_token(&id);
    let manager = search_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let roots = service.lock().map_err(|e| e.to_string())?.roots();
        let result = crate::workspace::replace::preview(
            &roots,
            &query,
            &replacement,
            &targets,
            token.clone(),
        );
        manager.cleanup(&id, &token);
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn apply_workspace_replace(
    window: Window,
    request: crate::workspace::replace::ReplaceApply,
    store: State<'_, WorkspaceStore>,
    file_store: State<'_, FileStore>,
) -> Result<usize, String> {
    let service = store.for_window(window.label())?;
    let files = file_store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Same lock order as workspace open/rename. Roots and file grants cannot
        // change between authorization and the checked write.
        let workspace = service.lock().map_err(|e| e.to_string())?;
        let files = files.lock().map_err(|e| e.to_string())?;
        crate::workspace::replace::apply_closed(&workspace.roots(), &request, &files)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn validate_workspace_replace(
    window: Window,
    path: String,
    version: String,
    query: SearchQuery,
    store: State<'_, WorkspaceStore>,
) -> Result<(), String> {
    let service = store.for_window(window.label())?;
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = service.lock().map_err(|e| e.to_string())?;
        let path = crate::workspace::replace::allowed_path(
            &workspace.roots(),
            PathBuf::from(path).as_path(),
            &query,
        )?;
        if crate::files::read_disk(&path).map_err(|e| e.to_string())?.1 != version {
            return Err("磁盘版本已变化，请重新预览".into());
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reveal_in_explorer(
    window: Window,
    token: String,
    store: State<'_, FileStore>,
) -> Result<(), String> {
    let owner = window.label().to_owned();

    let store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut service = store.lock().map_err(|e| e.to_string())?;
        service.set_owner(&owner);
        let p = service.revealed_path(&token).map_err(|e| e.message)?;
        reveal_path(&p)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn reveal_workspace_node(
    window: Window,
    path: String,
    store: State<'_, WorkspaceStore>,
) -> Result<(), String> {
    let store = store.for_window(window.label())?;

    let store = store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let p = store
            .lock()
            .map_err(|error| error.to_string())?
            .revealed_path(&std::path::PathBuf::from(path))?;
        reveal_path(&p)
    })
    .await
    .map_err(|error| error.to_string())?
}
pub(crate) fn reveal_path(p: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::{
            System::Com::{
                CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
            },
            UI::Shell::{SHOpenFolderAndSelectItems, SHParseDisplayName},
        };
        let wide = shell_path(p);
        unsafe {
            let initialized = CoInitializeEx(std::ptr::null(), COINIT_APARTMENTTHREADED as u32);
            if initialized < 0 {
                return Err(format!("资源管理器 COM 初始化失败: {initialized:#x}"));
            }
            let mut pidl = std::ptr::null_mut();
            let parsed = SHParseDisplayName(
                wide.as_ptr(),
                std::ptr::null_mut(),
                &mut pidl,
                0,
                std::ptr::null_mut(),
            );
            let result = if parsed >= 0 {
                SHOpenFolderAndSelectItems(pidl, 0, std::ptr::null(), 0)
            } else {
                parsed
            };
            if !pidl.is_null() {
                CoTaskMemFree(pidl.cast());
            }
            CoUninitialize();
            if result < 0 {
                return Err(format!("在资源管理器显示失败: {result:#x}"));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let status = std::process::Command::new("open")
            .arg("-R")
            .arg(&p)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("文件管理器启动失败".into());
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = p.parent() {
            let status = std::process::Command::new("xdg-open")
                .arg(parent)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("文件管理器启动失败".into());
            }
        }
    }
    Ok(())
}

#[cfg(windows)]
fn shell_path(path: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let unc: Vec<u16> = "\\\\?\\UNC\\".encode_utf16().collect();
    let prefix: Vec<u16> = "\\\\?\\".encode_utf16().collect();
    if wide.starts_with(&unc) {
        wide.splice(..unc.len(), "\\\\".encode_utf16());
    } else if wide.starts_with(&prefix) {
        wide.drain(..prefix.len());
    }
    wide.push(0);
    wide
}
