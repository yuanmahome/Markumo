//! Auxiliary search windows never register file/workspace/session services.
//! Mini changes only the existing native window's placement.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
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
    #[cfg(windows)]
    maximized_frame: Option<MaximizedFrame>,
    topmost: bool,
}
#[derive(Default)]
pub struct ToolWindows {
    searches: Mutex<HashMap<String, SearchWindow>>,
    mini: Mutex<HashMap<String, Placement>>,
    mini_switching: Mutex<HashSet<String>>,
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
fn fit_geometry(
    window: &WebviewWindow,
    geometry: &Geometry,
) -> Result<(Geometry, tauri::Monitor), String> {
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
    Ok((
        Geometry {
            x,
            y,
            width,
            height,
        },
        monitor,
    ))
}
fn place(window: &WebviewWindow, geometry: &Geometry) -> Result<(), String> {
    let (geometry, _) = fit_geometry(window, geometry)?;
    window
        .set_size(tauri::LogicalSize::new(geometry.width, geometry.height))
        .map_err(err)?;
    window
        .set_position(tauri::PhysicalPosition::new(geometry.x, geometry.y))
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
            close_search(app, window.label(), false)?;
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
    .decorations(false)
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
pub fn search_peer_windows(window: WebviewWindow) -> Result<Vec<String>, String> {
    owner_only(&window)?;
    let labels = window
        .app_handle()
        .state::<crate::session::LaunchStore>()
        .lock()
        .map_err(err)?
        .order
        .clone();
    Ok(labels
        .into_iter()
        .filter(|label| label != window.label())
        .collect())
}

#[tauri::command]
pub fn search_peer_send(
    window: WebviewWindow,
    target: Option<String>,
    payload: Value,
) -> Result<(), String> {
    owner_only(&window)?;
    if payload.to_string().len() > 8 * 1024 * 1024 {
        return Err("跨窗口搜索消息超出预算".into());
    }
    let peers = search_peer_windows(window.clone())?;
    if let Some(target) = &target {
        if !peers.contains(target) || window.app_handle().get_webview_window(target).is_none() {
            return Err("对应的编辑窗口已关闭".into());
        }
    }
    let message = serde_json::json!({"source":window.label(),"payload":payload});
    for label in peers
        .into_iter()
        .filter(|label| target.as_ref().is_none_or(|target| target == label))
    {
        window
            .emit_to(label, "search-peer-message", &message)
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn search_peer_buffers(
    window: WebviewWindow,
    mut query: crate::workspace::search::SearchQuery,
    search_manager: tauri::State<'_, crate::workspace::search::SearchManager>,
) -> Result<
    (
        Vec<crate::workspace::search::SearchMatch>,
        crate::workspace::search::SearchSummary,
    ),
    String,
> {
    use crate::workspace::search::WorkspaceSearcher;
    owner_only(&window)?;
    query.scope = "opened".into();
    let scoped_id = format!("{}:{}", window.label(), query.search_id);
    let cancel_token = search_manager.create_token(&scoped_id);
    let manager = search_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut matches = Vec::new();
        let result = WorkspaceSearcher::execute_search_detailed(
            &[],
            &query,
            cancel_token.clone(),
            |batch| matches.extend(batch),
        );
        manager.cleanup(&scoped_id, &cancel_token);
        result.map(|summary| (matches, summary))
    })
    .await
    .map_err(err)?
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
pub fn search_window_dock(
    window: WebviewWindow,
    session: String,
    docked: Option<bool>,
) -> Result<(), String> {
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
    close_search(app, &owner, docked.unwrap_or(true))
}
fn close_search(app: &tauri::AppHandle, owner: &str, docked: bool) -> Result<(), String> {
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
            serde_json::json!({"session":pair.session,"error":failure,"docked":docked}),
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
            if owner.is_some() {
                let _ = window.emit_to(window.label(), "search-window-close-request", ());
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
                let _ = close_search(app, &owner, false);
            }
        }
        return true;
    }
    if let tauri::WindowEvent::Destroyed = event {
        let _ = close_search(app, window.label(), false);
        if let Ok(mut states) = app.state::<ToolWindows>().mini.lock() {
            states.remove(window.label());
        }
    }
    // Scale and monitor topology changes are reconciled when restoring or reopening.
    false
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct WindowFrame {
    position: tauri::PhysicalPosition<i32>,
    size: tauri::PhysicalSize<u32>,
}
impl WindowFrame {
    fn capture(window: &WebviewWindow) -> Result<Self, String> {
        Ok(Self {
            position: window.outer_position().map_err(err)?,
            size: window.inner_size().map_err(err)?,
        })
    }

    fn fitted(geometry: &Geometry, monitor: &tauri::Monitor) -> Self {
        Self {
            position: tauri::PhysicalPosition::new(geometry.x, geometry.y),
            size: tauri::LogicalSize::new(geometry.width, geometry.height)
                .to_physical(monitor.scale_factor()),
        }
    }

    fn apply(self, window: &WebviewWindow) -> Result<(), String> {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SetWindowPos, SWP_NOACTIVATE, SWP_NOZORDER,
            };
            // Move and resize in one UI-thread operation without changing focus or z-order.
            let inner = window.inner_size().map_err(err)?;
            let outer = window.outer_size().map_err(err)?;
            let width = self.size.width as i32 + outer.width as i32 - inner.width as i32;
            let height = self.size.height as i32 + outer.height as i32 - inner.height as i32;
            let hwnd = window.hwnd().map_err(err)?.0;
            if unsafe {
                SetWindowPos(
                    hwnd,
                    std::ptr::null_mut(),
                    self.position.x,
                    self.position.y,
                    width,
                    height,
                    SWP_NOACTIVATE | SWP_NOZORDER,
                )
            } == 0
            {
                return Err(err(std::io::Error::last_os_error()));
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            window.set_size(self.size).map_err(err)?;
            window.set_position(self.position).map_err(err)
        }
    }

    fn interpolate(self, target: Self, progress: f64) -> Self {
        let ease = progress * progress * (3. - 2. * progress);
        let interpolate = |from: f64, to: f64| (from + (to - from) * ease).round();
        Self {
            position: tauri::PhysicalPosition::new(
                interpolate(self.position.x.into(), target.position.x.into()) as i32,
                interpolate(self.position.y.into(), target.position.y.into()) as i32,
            ),
            size: tauri::PhysicalSize::new(
                interpolate(self.size.width.into(), target.size.width.into()) as u32,
                interpolate(self.size.height.into(), target.size.height.into()) as u32,
            ),
        }
    }
}

#[cfg(windows)]
#[derive(Clone)]
struct MaximizedFrame {
    frame: WindowFrame,
    monitor: Option<tauri::Monitor>,
    placement: windows_sys::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT,
}
#[cfg(windows)]
impl MaximizedFrame {
    fn capture(window: &WebviewWindow) -> Result<Self, String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT};
        let mut placement = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let hwnd = window.hwnd().map_err(err)?.0;
        if unsafe { GetWindowPlacement(hwnd, &mut placement) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(Self {
            frame: WindowFrame::capture(window)?,
            monitor: window.current_monitor().map_err(err)?,
            placement,
        })
    }

    fn begin_animation(&self, window: &WebviewWindow) -> Result<Option<Geometry>, String> {
        use windows_sys::Win32::{
            Foundation::RECT,
            UI::WindowsAndMessaging::{GetWindowRect, SetWindowPlacement, SW_SHOWNORMAL},
        };
        let Some(monitor) = &self.monitor else {
            return Ok(None);
        };
        let hwnd = window.hwnd().map_err(err)?.0;
        let mut visible = RECT::default();
        if unsafe { GetWindowRect(hwnd, &mut visible) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        // WINDOWPLACEMENT uses workspace coordinates, while GetWindowRect uses screen coordinates.
        let dx = monitor.work_area().position.x - monitor.position().x;
        let dy = monitor.work_area().position.y - monitor.position().y;
        let normal = self.placement.rcNormalPosition;
        let scale = monitor.scale_factor();
        let inset_width = visible.right - visible.left - self.frame.size.width as i32;
        let inset_height = visible.bottom - visible.top - self.frame.size.height as i32;
        let geometry = Geometry {
            x: normal.left + dx,
            y: normal.top + dy,
            width: ((normal.right - normal.left - inset_width).max(1) as f64) / scale,
            height: ((normal.bottom - normal.top - inset_height).max(1) as f64) / scale,
        };
        let mut placement = self.placement;
        placement.showCmd = SW_SHOWNORMAL as u32;
        placement.rcNormalPosition = RECT {
            left: visible.left - dx,
            right: visible.right - dx,
            top: visible.top - dy,
            bottom: visible.bottom - dy,
        };
        if unsafe { SetWindowPlacement(hwnd, &placement) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(Some(geometry))
    }

    fn restore(&self, window: &WebviewWindow) -> Result<(), String> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPlacement, ShowWindow, SW_SHOWMAXIMIZED,
        };
        let hwnd = window.hwnd().map_err(err)?.0;
        let mut placement = self.placement;
        placement.showCmd = SW_SHOWMAXIMIZED as u32;
        // Maximize at the current size first, then restore the original normal bounds.
        unsafe { ShowWindow(hwnd, SW_SHOWMAXIMIZED) };
        if unsafe { SetWindowPlacement(hwnd, &placement) } == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
}

// Wait on the worker between frames so a slow UI thread never accumulates resize requests.
fn on_window_thread<T: Send + 'static>(
    window: &WebviewWindow,
    work: impl FnOnce(&WebviewWindow) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, receive) = mpsc::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let result = if handle
                .app_handle()
                .get_webview_window(handle.label())
                .is_some()
            {
                work(&handle)
            } else {
                Err("编辑窗口已关闭".into())
            };
            let _ = send.send(result);
        })
        .map_err(err)?;
    receive.recv().map_err(err)?
}

fn same_display(first: &tauri::Monitor, second: &tauri::Monitor) -> bool {
    first.position() == second.position()
        && first.size() == second.size()
        && first.scale_factor() == second.scale_factor()
        && first.work_area().position == second.work_area().position
        && first.work_area().size == second.work_area().size
}

fn animate_mini(
    window: &WebviewWindow,
    target: WindowFrame,
    monitor: &tauri::Monitor,
    animated: bool,
) -> Result<(), String> {
    let start = WindowFrame::capture(window)?;
    if start == target {
        return Ok(());
    }
    // Separate displays can have different DPI or gaps in the desktop layout.
    if !animated
        || !window
            .current_monitor()
            .map_err(err)?
            .is_some_and(|m| same_display(&m, monitor))
    {
        return on_window_thread(window, move |window| target.apply(window));
    }

    const DURATION: Duration = Duration::from_millis(220);
    const FRAME_INTERVAL: Duration = Duration::from_millis(16);
    let started = Instant::now();
    let mut last = start;
    loop {
        std::thread::sleep(FRAME_INTERVAL);
        let progress = (started.elapsed().as_secs_f64() / DURATION.as_secs_f64()).min(1.);
        let frame = start.interpolate(target, progress);
        if frame != last {
            on_window_thread(window, move |window| frame.apply(window))?;
            last = frame;
        }
        if progress == 1. {
            return Ok(());
        }
    }
}

#[tauri::command]
pub async fn mini_window(
    window: WebviewWindow,
    enabled: bool,
    reduced_motion: Option<bool>,
) -> Result<(), String> {
    owner_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let store = window.app_handle().state::<ToolWindows>();
        let label = window.label();
        if !store
            .mini_switching
            .lock()
            .map_err(err)?
            .insert(label.into())
        {
            return Err("窗口正在切换 Mini 模式".into());
        }
        let result = (|| {
            let launches = window.app_handle().state::<crate::session::LaunchStore>();
            if enabled {
                let mut registry = launches.lock().map_err(err)?;
                let launch = registry.windows.get_mut(label).ok_or("编辑窗口已失效")?;
                if !launch.pending.is_empty() {
                    return Err("请等待当前文件打开后再切换 Mini 模式".into());
                }
                launch.mini = true;
            }
            let result = switch_mini(&window, &store, enabled, !reduced_motion.unwrap_or(false));
            if enabled != result.is_ok() {
                if let Some(launch) = launches.lock().map_err(err)?.windows.get_mut(label) {
                    launch.mini = false;
                }
            }
            result
        })();
        store.mini_switching.lock().map_err(err)?.remove(label);
        result
    })
    .await
    .map_err(err)?
}

fn switch_mini(
    window: &WebviewWindow,
    store: &ToolWindows,
    enabled: bool,
    animated: bool,
) -> Result<(), String> {
    let label = window.label();
    let saved = store.mini.lock().map_err(err)?.get(label).cloned();
    if !enabled {
        if let Some(previous) = saved {
            restore_mini(window, &previous, animated)?;
            store.mini.lock().map_err(err)?.remove(label);
        }
        return Ok(());
    }
    if saved.is_some() {
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return Err(
            "当前 Wayland 会话不支持精确恢复原生窗口位置；请使用 X11 会话进入 Mini 模式".into(),
        );
    }
    if window.is_fullscreen().map_err(err)? {
        return Err("请先退出系统全屏，再进入 Mini 模式".into());
    }
    #[cfg(windows)]
    let animate_from_maximized = animated;
    let previous = on_window_thread(window, move |window| {
        let maximized = window.is_maximized().map_err(err)?;
        let topmost = window.is_always_on_top().map_err(err)?;
        #[cfg(windows)]
        let maximized_frame = maximized
            .then(|| MaximizedFrame::capture(window))
            .transpose()?;
        #[cfg(windows)]
        let from_visible = maximized_frame
            .as_ref()
            .filter(|_| animate_from_maximized)
            .map(|frame| frame.begin_animation(window))
            .transpose()?
            .flatten();
        #[cfg(not(windows))]
        let from_visible = None;
        let geometry = if let Some(geometry) = from_visible {
            geometry
        } else {
            if maximized {
                window.unmaximize().map_err(err)?;
            }
            capture(window).inspect_err(|_| {
                if maximized {
                    let _ = window.maximize();
                }
            })?
        };
        Ok(Placement {
            geometry,
            maximized,
            #[cfg(windows)]
            maximized_frame,
            topmost,
        })
    })?;
    store
        .mini
        .lock()
        .map_err(err)?
        .insert(label.into(), previous.clone());
    let result = (|| {
        window
            .set_min_size(Some(tauri::LogicalSize::new(240., 240.)))
            .map_err(err)?;
        let (geometry, monitor) = fit_geometry(
            window,
            &Geometry {
                width: 400.,
                height: 520.,
                ..previous.geometry.clone()
            },
        )?;
        animate_mini(
            window,
            WindowFrame::fitted(&geometry, &monitor),
            &monitor,
            animated,
        )?;
        window.set_always_on_top(true).map_err(err)
    })();
    if let Err(error) = result {
        let recovery = restore_mini(window, &previous, false);
        if recovery.is_ok() || window.app_handle().get_webview_window(label).is_none() {
            store.mini.lock().map_err(err)?.remove(label);
        }
        return Err(format!(
            "Mini 切换失败：{error}{}",
            recovery
                .err()
                .map(|e| format!("；恢复失败：{e}"))
                .unwrap_or_default()
        ));
    }
    Ok(())
}

fn restore_mini(
    window: &WebviewWindow,
    previous: &Placement,
    animated: bool,
) -> Result<(), String> {
    window.unmaximize().map_err(err)?;
    let (geometry, monitor) = fit_geometry(window, &previous.geometry)?;
    let restored = WindowFrame::fitted(&geometry, &monitor);
    #[cfg(windows)]
    let exact_maximized = previous.maximized_frame.clone().filter(|frame| {
        frame
            .monitor
            .as_ref()
            .is_some_and(|display| same_display(display, &monitor))
    });
    #[cfg(windows)]
    let target = exact_maximized
        .as_ref()
        .filter(|_| animated)
        .map_or(restored, |frame| frame.frame);
    #[cfg(not(windows))]
    let target = restored;
    animate_mini(window, target, &monitor, animated)?;

    let maximized = previous.maximized;
    let topmost = previous.topmost;
    on_window_thread(window, move |window| {
        window.set_always_on_top(topmost).map_err(err)?;
        if window.label() == "main" {
            window
                .set_min_size(Some(tauri::LogicalSize::new(680., 480.)))
                .map_err(err)?;
        } else {
            window
                .set_min_size(None::<tauri::LogicalSize<f64>>)
                .map_err(err)?;
        }
        #[cfg(windows)]
        if let Some(maximized) = exact_maximized {
            return maximized.restore(window);
        }
        if maximized {
            window.maximize().map_err(err)?;
        }
        Ok(())
    })
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
