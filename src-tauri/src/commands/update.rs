use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State, WebviewWindow};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WindowStatus {
    pub dirty_count: usize,
    pub busy: bool,
    pub composing: bool,
    pub ready: bool,
}
pub struct UpdateCoordinator {
    pub owner: Option<String>,
    pub statuses: HashMap<String, WindowStatus>,
    process: String,
}
impl Default for UpdateCoordinator {
    fn default() -> Self {
        Self {
            owner: None,
            statuses: HashMap::new(),
            process: format!(
                "{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos()
            ),
        }
    }
}
impl UpdateCoordinator {
    pub fn acquire(
        &mut self,
        label: &str,
        window_count: usize,
        registered_count: usize,
    ) -> Result<(), String> {
        if window_count != 1 || registered_count != 1 {
            return Err("请先保存修改并关闭其他 Markumo 窗口，再安装更新。".into());
        }
        if self.owner.is_some() {
            return Err("另一个更新安装操作正在进行。".into());
        }
        self.owner = Some(label.into());
        Ok(())
    }
    pub fn release(&mut self, label: &str) {
        if self.owner.as_deref() == Some(label) {
            self.owner = None
        }
    }
    pub fn require_owner(&self, label: &str) -> Result<(), String> {
        if self.owner.as_deref() == Some(label) {
            Ok(())
        } else {
            Err("尚未获得更新安装锁".into())
        }
    }
}
pub type UpdateStore = Mutex<UpdateCoordinator>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    version: String,
    platform: String,
    install_supported: bool,
}
#[tauri::command]
pub fn update_runtime() -> Runtime {
    Runtime {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        install_supported: !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some(),
    }
}
#[tauri::command]
pub fn report_update_window(
    window: WebviewWindow,
    status: WindowStatus,
    store: State<'_, UpdateStore>,
) -> Result<(), String> {
    if status.dirty_count > 10000 {
        return Err("窗口状态无效".into());
    }
    store
        .lock()
        .map_err(|e| e.to_string())?
        .statuses
        .insert(window.label().into(), status);
    Ok(())
}
#[tauri::command]
pub fn update_windows_status(
    window: WebviewWindow,
    store: State<'_, UpdateStore>,
) -> Result<Vec<Option<WindowStatus>>, String> {
    let coordinator = store.lock().map_err(|e| e.to_string())?;
    Ok(window
        .app_handle()
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() != window.label())
        .map(|label| coordinator.statuses.get(label).cloned())
        .collect())
}
#[tauri::command]
pub fn begin_update_install(
    window: WebviewWindow,
    store: State<'_, UpdateStore>,
    launches: State<'_, crate::session::LaunchStore>,
) -> Result<(), String> {
    crate::commands::app::ensure_update_window(window.clone())?;
    let mut coordinator = store.lock().map_err(|e| e.to_string())?;
    let registered = launches.lock().map_err(|e| e.to_string())?.windows.len();
    coordinator.acquire(
        window.label(),
        window.app_handle().webview_windows().len(),
        registered,
    )
}
#[tauri::command]
pub fn end_update_install(
    window: WebviewWindow,
    store: State<'_, UpdateStore>,
) -> Result<(), String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .release(window.label());
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingUpdate {
    from_version: String,
    target_version: String,
    process: String,
}
fn valid_version(version: &str) -> bool {
    version.len() <= 64
        && version.split('.').count() == 3
        && version
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}
pub fn restore_after_update(path: &Path, current: &str) -> bool {
    std::fs::metadata(path)
        .ok()
        .filter(|meta| meta.len() <= 8192)
        .and_then(|_| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<PendingUpdate>(&bytes).ok())
        .is_some_and(|marker| {
            valid_version(&marker.target_version) && marker.target_version == current
        })
}
fn write_pending(path: &Path, marker: &PendingUpdate) -> Result<(), String> {
    if !valid_version(&marker.target_version) {
        return Err("目标更新版本无效".into());
    }
    std::fs::create_dir_all(path.parent().ok_or("更新标记路径无效")?).map_err(|e| e.to_string())?;
    let version = crate::files::disk_version(path).map_err(|e| e.message)?;
    let canonical = crate::files::checked_path(path, true).map_err(|e| e.message)?;
    crate::files::atomic::write_checked(
        &canonical,
        &serde_json::to_vec(marker).map_err(|e| e.to_string())?,
        version.as_deref(),
    )
    .map_err(|e| e.message)
}
#[tauri::command]
pub fn mark_update_pending(
    window: WebviewWindow,
    target_version: String,
    store: State<'_, UpdateStore>,
) -> Result<(), String> {
    crate::commands::app::ensure_update_window(window.clone())?;
    let coordinator = store.lock().map_err(|e| e.to_string())?;
    coordinator.require_owner(window.label())?;
    let path = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pending-update.json");
    write_pending(
        &path,
        &PendingUpdate {
            from_version: env!("CARGO_PKG_VERSION").into(),
            target_version,
            process: coordinator.process.clone(),
        },
    )
}
#[tauri::command]
pub fn clear_update_pending(
    window: WebviewWindow,
    store: State<'_, UpdateStore>,
) -> Result<(), String> {
    let coordinator = store.lock().map_err(|e| e.to_string())?;
    coordinator.require_owner(window.label())?;
    let path = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pending-update.json");
    if path.exists() {
        std::fs::remove_file(path).map_err(|e| e.to_string())?
    }
    Ok(())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Confirmation {
    confirmed: bool,
    target_version: String,
}
fn consume_pending(
    path: &Path,
    process: &str,
    current: &str,
) -> Result<Option<Confirmation>, String> {
    if !path.exists() {
        return Ok(None);
    }
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 8192 {
        return Err("更新标记无效".into());
    }
    let marker: PendingUpdate =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if marker.process == process {
        return Ok(None);
    }
    std::fs::remove_file(path).map_err(|e| e.to_string())?;
    Ok(Some(Confirmation {
        confirmed: valid_version(&marker.target_version) && marker.target_version == current,
        target_version: marker.target_version,
    }))
}
#[tauri::command]
pub fn confirm_update_startup(
    window: WebviewWindow,
    store: State<'_, UpdateStore>,
) -> Result<Option<Confirmation>, String> {
    let coordinator = store.lock().map_err(|e| e.to_string())?;
    let path = window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pending-update.json");
    consume_pending(&path, &coordinator.process, env!("CARGO_PKG_VERSION"))
}
