//! Auxiliary search windows never register file/workspace/session services.
//! Mini changes only the existing native window's placement.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager, WebviewWindow};

#[derive(Clone)]
struct SearchWindow {
    label: String,
    session: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Geometry {
    x: i32,
    y: i32,
    width: f64,
    height: f64,
}
#[derive(Clone)]
struct Placement {
    geometry: Geometry,
    maximized: bool,
    topmost: bool,
}
#[derive(Default)]
pub struct ToolWindows {
    searches: Mutex<HashMap<String, SearchWindow>>,
    mini: Mutex<HashMap<String, Placement>>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn capture(window: &WebviewWindow) -> Result<Geometry, String> {
    let position = window.outer_position().map_err(err)?;
    let scale = window.scale_factor().map_err(err)?;
    let size = window.inner_size().map_err(err)?.to_logical::<f64>(scale);
    Ok(Geometry {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}
// Physical desktop coordinates can be negative on monitors left of the primary.
// Clamp to a current work area, including after a saved monitor is unplugged.
fn place(window: &WebviewWindow, geometry: &Geometry) -> Result<(), String> {
    let monitors = window.available_monitors().map_err(err)?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let a = m.work_area();
            geometry.x >= a.position.x
                && geometry.x < a.position.x + a.size.width as i32
                && geometry.y >= a.position.y
                && geometry.y < a.position.y + a.size.height as i32
        })
        .cloned()
        .or(window.current_monitor().map_err(err)?)
        .or(window.primary_monitor().map_err(err)?)
        .ok_or("没有可用显示器，无法恢复窗口位置")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let width = geometry
        .width
        .clamp(240., (area.size.width as f64 / scale).max(240.));
    let height = geometry
        .height
        .clamp(180., (area.size.height as f64 / scale - 40.).max(180.));
    let x = geometry.x.clamp(
        area.position.x,
        area.position.x + (area.size.width as i32 - (width * scale) as i32).max(0),
    );
    let y = geometry.y.clamp(
        area.position.y,
        area.position.y + (area.size.height as i32 - (height * scale) as i32 - 40).max(0),
    );
    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(err)?;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(err)
}
fn geometry_path(window: &WebviewWindow) -> Result<std::path::PathBuf, String> {
    Ok(window
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(err)?
        .join(format!("search-window-{}.json", window.label())))
}
fn save_geometry(owner: &WebviewWindow, child: &WebviewWindow) -> Result<(), String> {
    let path = geometry_path(owner)?;
    let geometry = capture(child)?;
    let bytes = serde_json::to_vec(&geometry).map_err(err)?;
    let parent = path.parent().ok_or("窗口配置目录不可用")?;
    std::fs::create_dir_all(parent).map_err(err)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(err)?;
    use std::io::Write;
    temp.write_all(&bytes).map_err(err)?;
    temp.persist(path).map_err(err)?;
    Ok(())
}
fn owner_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label().starts_with("search-") {
        return Err("搜索视图不能创建编辑窗口".into());
    }
    if !window
        .app_handle()
        .state::<crate::session::LaunchStore>()
        .lock()
        .map_err(err)?
        .windows
        .contains_key(window.label())
    {
        return Err("编辑窗口已失效".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn search_window_open(window: WebviewWindow, session: String) -> Result<String, String> {
    owner_only(&window)?;
    if session.len() > 80
        || session.is_empty()
        || !session
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    {
        return Err("搜索会话无效".into());
    }
    let app = window.app_handle();
    let store = app.state::<ToolWindows>();
    let existing = store
        .searches
        .lock()
        .map_err(err)?
        .get(window.label())
        .cloned();
    if let Some(existing) = existing {
        if existing.session != session {
            // A reloaded owner cannot adopt a renderer using the old nonce.
            close_search(app, window.label())?;
        } else if let Some(child) = app.get_webview_window(&existing.label) {
            child.unminimize().map_err(err)?;
            child.set_focus().map_err(err)?;
            return Ok(existing.label);
        }
    }
    // Each native lifetime gets a fresh label. A late Destroyed event from an
    // older window must never match and close the replacement window.
    let label = format!("search-{}-{}", window.label(), session);
    let pair = SearchWindow {
        label: label.clone(),
        session: session.clone(),
    };
    store
        .searches
        .lock()
        .map_err(err)?
        .insert(window.label().into(), pair);
    let result = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html?searchWindow=1".into()),
    )
    .title("Markumo · 全局搜索")
    .inner_size(960., 600.)
    .min_inner_size(320., 300.)
    .visible(false)
    .build();
    let child = match result {
        Ok(child) => child,
        Err(error) => {
            store.searches.lock().map_err(err)?.remove(window.label());
            return Err(err(error));
        }
    };
    if let Ok(path) = geometry_path(&window) {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(geometry) = serde_json::from_slice::<Geometry>(&bytes) {
                if geometry.width.is_finite() && geometry.height.is_finite() {
                    if let Err(error) = place(&child, &geometry) {
                        let _ = child.destroy();
                        store.searches.lock().map_err(err)?.remove(window.label());
                        return Err(error);
                    }
                }
            }
        }
    }
    child.show().map_err(err)?;
    child.set_focus().map_err(err)?;
    Ok(label)
}
#[tauri::command]
pub fn search_window_identity(window: WebviewWindow) -> Result<(String, String), String> {
    let store = window.app_handle().state::<ToolWindows>();
    let pairs = store.searches.lock().map_err(err)?;
    pairs
        .iter()
        .find(|(_, pair)| pair.label == window.label())
        .map(|(owner, pair)| (owner.clone(), pair.session.clone()))
        .ok_or("搜索主窗口已关闭".into())
}
#[tauri::command]
pub fn search_window_send(
    window: WebviewWindow,
    session: String,
    payload: Value,
) -> Result<(), String> {
    let app = window.app_handle();
    let store = app.state::<ToolWindows>();
    let (owner, pair) = store
        .searches
        .lock()
        .map_err(err)?
        .iter()
        .find(|(owner, pair)| {
            (owner.as_str() == window.label() || pair.label == window.label())
                && pair.session == session
        })
        .map(|(o, p)| (o.clone(), p.clone()))
        .ok_or("搜索会话已失效".to_string())?;
    let target = if owner == window.label() {
        pair.label
    } else {
        owner
    };
    if payload.to_string().len() > 12 * 1024 * 1024 {
        return Err("搜索视图消息超出预算".into());
    }
    window
        .emit_to(
            target,
            "search-window-message",
            serde_json::json!({"session":session,"payload":payload}),
        )
        .map_err(err)
}
#[tauri::command]
pub fn search_window_dock(window: WebviewWindow, session: String) -> Result<(), String> {
    let app = window.app_handle();
    let store = app.state::<ToolWindows>();
    let owner = store
        .searches
        .lock()
        .map_err(err)?
        .iter()
        .find(|(owner, pair)| {
            (owner.as_str() == window.label() || pair.label == window.label())
                && pair.session == session
        })
        .map(|(o, _)| o.clone())
        .ok_or("搜索会话已失效")?;
    close_search(app, &owner)
}
fn close_search(app: &tauri::AppHandle, owner: &str) -> Result<(), String> {
    let pair = app
        .state::<ToolWindows>()
        .searches
        .lock()
        .map_err(err)?
        .remove(owner);
    if let Some(pair) = pair {
        let mut failure = None;
        if let Some(child) = app.get_webview_window(&pair.label) {
            if let Some(parent) = app.get_webview_window(owner) {
                if let Err(error) = save_geometry(&parent, &child) {
                    failure = Some(error)
                }
            }
            child.destroy().map_err(err)?;
        }
        app.emit_to(
            owner,
            "search-window-closed",
            serde_json::json!({"session":pair.session,"error":failure}),
        )
        .map_err(err)?;
    }
    Ok(())
}
pub fn auxiliary_event(window: &tauri::Window, event: &tauri::WindowEvent) -> bool {
    let app = window.app_handle();
    if window.label().starts_with("search-") {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let owner = app
                .state::<ToolWindows>()
                .searches
                .lock()
                .ok()
                .and_then(|pairs| {
                    pairs
                        .iter()
                        .find(|(_, p)| p.label == window.label())
                        .map(|(owner, _)| owner.clone())
                });
            if let Some(owner) = owner {
                if let Err(error) = close_search(app, &owner) {
                    let _ = app.emit_to(owner, "search-window-error", error);
                }
            } else if let Some(child) = app.get_webview_window(window.label()) {
                let _ = child.destroy();
            }
        }
        if let tauri::WindowEvent::Destroyed = event {
            let owner = app
                .state::<ToolWindows>()
                .searches
                .lock()
                .ok()
                .and_then(|pairs| {
                    pairs
                        .iter()
                        .find(|(_, p)| p.label == window.label())
                        .map(|(owner, _)| owner.clone())
                });
            if let Some(owner) = owner {
                let _ = close_search(app, &owner);
            }
        }
        return true;
    }
    if let tauri::WindowEvent::Destroyed = event {
        let _ = close_search(app, window.label());
        if let Ok(mut states) = app.state::<ToolWindows>().mini.lock() {
            states.remove(window.label());
        }
    }
    // Scale and monitor topology changes are reconciled when restoring or reopening.
    false
}
#[tauri::command]
pub fn mini_window(window: WebviewWindow, enabled: bool) -> Result<(), String> {
    owner_only(&window)?;
    let app = window.app_handle();
    let store = app.state::<ToolWindows>();
    if enabled {
        #[cfg(target_os = "linux")]
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            return Err(
                "当前 Wayland 会话不支持精确恢复原生窗口位置；请使用 X11 会话进入 Mini 模式".into(),
            );
        }
        if window.is_fullscreen().map_err(err)? {
            return Err("请先退出系统全屏，再进入 Mini 模式".into());
        }
        if store.mini.lock().map_err(err)?.contains_key(window.label()) {
            return Ok(());
        }
        let maximized = window.is_maximized().map_err(err)?;
        let topmost = window.is_always_on_top().map_err(err)?;
        if maximized {
            window.unmaximize().map_err(err)?;
        }
        let geometry = match capture(&window) {
            Ok(geometry) => geometry,
            Err(error) => {
                if maximized {
                    let _ = window.maximize();
                }
                return Err(error);
            }
        };
        let previous = Placement {
            geometry,
            maximized,
            topmost,
        };
        store
            .mini
            .lock()
            .map_err(err)?
            .insert(window.label().into(), previous.clone());
        let result = (|| {
            window
                .set_min_size(Some(tauri::LogicalSize::new(240., 240.)))
                .map_err(err)?;
            window.unmaximize().map_err(err)?;
            place(
                &window,
                &Geometry {
                    width: 400.,
                    height: 520.,
                    ..previous.geometry.clone()
                },
            )?;
            window.set_always_on_top(true).map_err(err)
        })();
        if let Err(error) = result {
            let recovery = restore_mini(&window, &previous);
            if recovery.is_ok() {
                store.mini.lock().map_err(err)?.remove(window.label());
            }
            return Err(format!(
                "Mini 切换失败：{error}{}",
                recovery
                    .err()
                    .map(|e| format!("；恢复失败：{e}"))
                    .unwrap_or_default()
            ));
        }
    } else {
        let previous = store.mini.lock().map_err(err)?.get(window.label()).cloned();
        if let Some(previous) = previous {
            restore_mini(&window, &previous)?;
            store.mini.lock().map_err(err)?.remove(window.label());
        }
    }
    Ok(())
}
fn restore_mini(window: &WebviewWindow, previous: &Placement) -> Result<(), String> {
    window.set_always_on_top(previous.topmost).map_err(err)?;
    window.unmaximize().map_err(err)?;
    place(window, &previous.geometry)?;
    if window.label() == "main" {
        window
            .set_min_size(Some(tauri::LogicalSize::new(680., 480.)))
            .map_err(err)?;
    } else {
        window
            .set_min_size(None::<tauri::LogicalSize<f64>>)
            .map_err(err)?;
    }
    if previous.maximized {
        window.maximize().map_err(err)?
    }
    Ok(())
}
#[tauri::command]
pub fn mini_pin(window: WebviewWindow, pinned: bool) -> Result<(), String> {
    if !window
        .app_handle()
        .state::<ToolWindows>()
        .mini
        .lock()
        .map_err(err)?
        .contains_key(window.label())
    {
        return Err("当前窗口不在 Mini 模式".into());
    }
    window.set_always_on_top(pinned).map_err(err)
}
