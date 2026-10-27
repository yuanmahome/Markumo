use crate::{
    detach::{clamp_window_origin, DetachPayload, DetachRegistry, WorkArea},
    session::MAX_WINDOWS,
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Emitter, Manager, WebviewWindow};

pub type DetachStore = Arc<Mutex<DetachRegistry>>;

/// Emitted to the source window after a target window adopted the document.
pub const DETACH_COMMITTED_EVENT: &str = "markumo:detach-committed";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachStarted {
    pub handoff_id: String,
    pub label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdoptedDocument {
    pub handoff_id: String,
    pub source_label: String,
    pub payload: DetachPayload,
}

/// Physical desktop rectangle of one monitor, used only for placement math.
fn work_areas(window: &WebviewWindow) -> Vec<WorkArea> {
    let Ok(monitors) = window.available_monitors() else {
        return Vec::new();
    };
    monitors
        .into_iter()
        .map(|monitor| WorkArea {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            width: monitor.size().width as f64,
            height: monitor.size().height as f64,
        })
        .collect()
}

/// Converts a drop point expressed in the source webview's CSS pixels (which may
/// be negative or beyond the window once the pointer left it) into desktop
/// physical pixels.
fn drop_point_physical(window: &WebviewWindow, css_x: f64, css_y: f64) -> (f64, f64) {
    let scale = window.scale_factor().unwrap_or(1.0);
    let origin = window
        .inner_position()
        .map(|position| (position.x as f64, position.y as f64))
        .unwrap_or((0.0, 0.0));
    (origin.0 + css_x * scale, origin.1 + css_y * scale)
}

#[tauri::command]
pub async fn detach_tab_to_window(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    files: tauri::State<'_, crate::commands::files::FileStore>,
    payload: DetachPayload,
    drop_x: f64,
    drop_y: f64,
    force_new: Option<bool>,
) -> Result<DetachStarted, String> {
    let source = window.label().to_owned();
    if let Some(token) = payload.file_token.as_deref() {
        let mut service = files.lock().map_err(|e| e.to_string())?;
        service.set_owner(&source);
        let granted = service.session_path(token).map_err(|e| e.message)?;
        if !payload
            .path
            .as_deref()
            .is_some_and(|path| crate::workspace::search::same_file(path, &granted))
        {
            return Err("文档路径与文件授权不匹配".into());
        }
    } else if payload.path.as_ref().is_some_and(|path| !path.is_empty()) {
        return Err("文档没有可移交的文件授权".into());
    }
    if !drop_x.is_finite() || !drop_y.is_finite() {
        return Err("无效窗口坐标".into());
    }
    let app = window.app_handle().clone();
    let (physical_x, physical_y) = drop_point_physical(&window, drop_x, drop_y);

    // 1. Check if the drop lands within an existing visible window (drag-back or cross-window move)
    let mut existing_target: Option<(WebviewWindow, f64, f64)> = None;
    #[cfg(windows)]
    let top_window = unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetAncestor, WindowFromPoint, GA_ROOT};
        GetAncestor(
            WindowFromPoint(windows_sys::Win32::Foundation::POINT {
                x: physical_x.round() as i32,
                y: physical_y.round() as i32,
            }),
            GA_ROOT,
        )
    };
    for (label, w) in app.webview_windows() {
        if force_new.unwrap_or(false) || label == source || !w.is_visible().unwrap_or(false) {
            continue;
        }
        #[cfg(windows)]
        if !w.hwnd().is_ok_and(|handle| handle.0 == top_window) {
            continue;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let px = pos.x as f64;
            let py = pos.y as f64;
            let pw = size.width as f64;
            let ph = size.height as f64;
            if physical_x >= px
                && physical_x <= px + pw
                && physical_y >= py
                && physical_y <= py + ph
            {
                let scale = w.scale_factor().unwrap_or(1.0);
                let origin = w.inner_position().map_err(|e| e.to_string())?;
                let css_x = (physical_x - origin.x as f64) / scale;
                let css_y = (physical_y - origin.y as f64) / scale;
                existing_target = Some((w, css_x, css_y));
                break;
            }
        }
    }

    if let Some((target_win, target_x, target_y)) = existing_target {
        let handoff_id = {
            let mut registry = store.lock().map_err(|e| e.to_string())?;
            registry.begin_for_target(&source, target_win.label(), payload, Instant::now())?
        };
        let _ = target_win.set_focus();
        if let Err(error) = target_win.emit_to(
            target_win.label(),
            "markumo:incoming-tab",
            serde_json::json!({
                "handoffId": handoff_id,
                "x": target_x,
                "y": target_y,
            }),
        ) {
            store
                .lock()
                .map_err(|e| e.to_string())?
                .rollback(&handoff_id);
            return Err(error.to_string());
        }
        return Ok(DetachStarted {
            handoff_id,
            label: target_win.label().to_string(),
        });
    }

    // 2. Otherwise create a new detached window
    let window_count = window.app_handle().webview_windows().len();

    // Prepare: nothing about the source document changes here.
    let (label, handoff_id) = {
        let mut registry = store.lock().map_err(|e| e.to_string())?;
        let label = registry.begin(
            &source,
            payload,
            Instant::now(),
            window_count,
            MAX_WINDOWS,
            &|candidate| app.get_webview_window(candidate).is_some(),
        )?;
        let id = registry.id_for_label(&label).ok_or("移交注册失败")?;
        (label, id)
    };

    // Everything below can fail. A failure releases the reservation and closes
    // any half-built window, so the source document stays exactly where it was.
    let build = || -> Result<(), String> {
        // The new window is a detached owner: it adopts this document and keeps
        // no session or workspace index of its own.
        crate::register_detached_window(window.app_handle(), &label)?;
        let mut config = window
            .app_handle()
            .config()
            .app
            .windows
            .first()
            .cloned()
            .ok_or("缺少窗口配置")?;
        config.label = label.clone();
        let built = tauri::WebviewWindowBuilder::from_config(window.app_handle(), &config)
            .map_err(|e| e.to_string())?
            .title("Markumo")
            .build()
            .map_err(|e| e.to_string())?;
        // Placement happens after build so physical coordinates map exactly onto
        // the desktop, including mixed-DPI and multi-monitor layouts.
        let areas = work_areas(&window);
        let (physical_x, physical_y) = drop_point_physical(&window, drop_x, drop_y);
        let size = built
            .outer_size()
            .map(|size| (size.width as f64, size.height as f64))
            .unwrap_or((1200.0, 800.0));
        let (x, y) = clamp_window_origin(physical_x, physical_y, size.0, size.1, &areas);
        let _ = built.set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ));
        let _ = built.set_focus();
        Ok(())
    };

    if let Err(error) = build() {
        if let Ok(mut registry) = store.lock() {
            registry.rollback(&handoff_id);
        }
        if let Some(created) = app.get_webview_window(&label) {
            let _ = created.destroy();
        }
        crate::cleanup_window(&app, &label);
        return Err(format!("无法创建新窗口：{error}"));
    }

    Ok(DetachStarted { handoff_id, label })
}

/// Called by a freshly created window. It takes the pending body exactly once
/// and, in the same step, moves the file write ownership to this window.
#[tauri::command]
pub async fn take_detached_document(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    files: tauri::State<'_, crate::commands::files::FileStore>,
    handoff_id: Option<String>,
) -> Result<Option<AdoptedDocument>, String> {
    let label = window.label().to_owned();
    let (handoff_id, source_label, payload) = {
        let mut registry = store.lock().map_err(|e| e.to_string())?;
        let Some((id, source)) = registry
            .handoffs
            .iter()
            .find(|handoff| {
                handoff.label == label
                    && !handoff.adopted
                    && handoff_id.as_ref().is_none_or(|id| &handoff.id == id)
            })
            .map(|handoff| (handoff.id.clone(), handoff.source.clone()))
        else {
            return Ok(None);
        };
        let payload = registry
            .handoffs
            .iter()
            .find(|handoff| handoff.id == id)
            .unwrap()
            .payload
            .clone();
        if let Some(token) = payload.file_token.as_deref() {
            files
                .lock()
                .map_err(|e| e.to_string())?
                .transfer_grant(token, &source, &label)
                .map_err(|e| e.message)?;
        }
        let payload = registry.adopt_id(&id, &label)?;
        (id, source, payload)
    };

    Ok(Some(AdoptedDocument {
        handoff_id,
        source_label,
        payload,
    }))
}

/// Commit: the source drops its tab only after the target confirmed adoption.
#[tauri::command]
pub async fn commit_detach(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    handoff_id: String,
) -> Result<(), String> {
    let mut registry = store.lock().map_err(|e| e.to_string())?;
    if !registry.handoffs.iter().any(|handoff| {
        handoff.id == handoff_id && handoff.label == window.label() && handoff.adopted
    }) {
        return Err("移交未接收或不属于此目标窗口".into());
    }
    let committed = registry.commit(&handoff_id);
    if let Some((source, document_id)) = committed {
        let _ = window.app_handle().emit_to(
            source,
            DETACH_COMMITTED_EVENT,
            serde_json::json!({ "handoffId": handoff_id, "documentId": document_id }),
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_detach(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    files: tauri::State<'_, crate::commands::files::FileStore>,
    handoff_id: String,
) -> Result<bool, String> {
    rollback(
        window.app_handle(),
        &store,
        &files,
        &handoff_id,
        Some(window.label()),
    )
}

/// Best-effort cleanup when any window disappears.
pub fn forget_window(
    app: &tauri::AppHandle,
    store: &DetachStore,
    files: &crate::commands::files::FileStore,
    label: &str,
) {
    let ids = store
        .lock()
        .map(|registry| {
            registry
                .handoffs
                .iter()
                .filter(|h| h.source == label || h.label == label)
                .map(|h| h.id.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for id in ids {
        let _ = rollback(app, store, files, &id, None);
    }
    if let Ok(mut registry) = store.lock() {
        registry.forget_window(label)
    }
}
fn rollback(
    app: &tauri::AppHandle,
    store: &DetachStore,
    files: &crate::commands::files::FileStore,
    id: &str,
    caller: Option<&str>,
) -> Result<bool, String> {
    let mut registry = store.lock().map_err(|e| e.to_string())?;
    if caller.is_some_and(|owner| registry.status(id, owner) == "committed") {
        return Ok(true);
    }
    if let Some(handoff) = registry.handoffs.iter().find(|h| h.id == id) {
        if caller.is_some_and(|caller| caller != handoff.source && caller != handoff.label) {
            return Err("移交不属于此窗口".into());
        }
        if handoff.adopted {
            if let Some(token) = handoff.payload.file_token.as_deref() {
                let mut service = files.lock().map_err(|e| e.to_string())?;
                if service.grant_owner(token) == Some(&handoff.label)
                    && app.get_webview_window(&handoff.source).is_some()
                {
                    service
                        .transfer_grant(token, &handoff.label, &handoff.source)
                        .map_err(|e| e.message)?;
                }
            }
        }
        let _ = app.emit_to(
            &handoff.source,
            "markumo:detach-canceled",
            serde_json::json!({"handoffId":id,"documentId":handoff.payload.document_id}),
        );
    }
    registry.rollback(id);
    Ok(false)
}
#[tauri::command]
pub fn detach_status(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    handoff_id: String,
) -> Result<String, String> {
    Ok(store
        .lock()
        .map_err(|e| e.to_string())?
        .status(&handoff_id, window.label())
        .into())
}
