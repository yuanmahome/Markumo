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
        .outer_position()
        .map(|position| (position.x as f64, position.y as f64))
        .unwrap_or((0.0, 0.0));
    (origin.0 + css_x * scale, origin.1 + css_y * scale)
}

#[tauri::command]
pub async fn detach_tab_to_window(
    window: WebviewWindow,
    store: tauri::State<'_, DetachStore>,
    payload: DetachPayload,
    drop_x: f64,
    drop_y: f64,
) -> Result<DetachStarted, String> {
    let source = window.label().to_owned();
    let app = window.app_handle().clone();
    let (physical_x, physical_y) = drop_point_physical(&window, drop_x, drop_y);

    // 1. Check if the drop lands within an existing visible window (drag-back or cross-window move)
    let mut existing_target: Option<(WebviewWindow, f64, f64)> = None;
    for (label, w) in app.webview_windows() {
        if label == source || !w.is_visible().unwrap_or(false) {
            continue;
        }
        if let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) {
            let px = pos.x as f64;
            let py = pos.y as f64;
            let pw = size.width as f64;
            let ph = size.height as f64;
            if physical_x >= px && physical_x <= px + pw && physical_y >= py && physical_y <= py + ph {
                let scale = w.scale_factor().unwrap_or(1.0);
                let css_x = (physical_x - px) / scale;
                let css_y = (physical_y - py) / scale;
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
        let _ = target_win.emit(
            "markumo:incoming-tab",
            serde_json::json!({
                "handoffId": handoff_id,
                "x": target_x,
                "y": target_y,
            }),
        );
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
            let _ = created.close();
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
) -> Result<Option<AdoptedDocument>, String> {
    let label = window.label().to_owned();
    let (handoff_id, source_label, payload) = {
        let mut registry = store.lock().map_err(|e| e.to_string())?;
        let Some((id, source)) = registry
            .handoffs
            .iter()
            .find(|handoff| handoff.label == label)
            .map(|handoff| (handoff.id.clone(), handoff.source.clone()))
        else {
            return Ok(None);
        };
        (id, source, registry.adopt(&label)?)
    };

    // Hand the document's file grant to this window so it can save the same file.
    // The token, canonical path, writability and identity never change.
    if let Some(token) = payload.file_token.as_deref() {
        let mut service = files.lock().map_err(|e| e.to_string())?;
        if let Err(error) = service.transfer_grant(token, &source_label, &label) {
            eprintln!("移交文件授权失败：{error}");
        }
    }

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
    let committed = store.lock().map_err(|e| e.to_string())?.commit(&handoff_id);
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
    store: tauri::State<'_, DetachStore>,
    handoff_id: String,
) -> Result<(), String> {
    if let Ok(mut registry) = store.lock() {
        registry.rollback(&handoff_id);
    }
    Ok(())
}

/// Best-effort cleanup when any window disappears.
pub fn forget_window(store: &DetachStore, label: &str) {
    if let Ok(mut registry) = store.lock() {
        registry.forget_window(label);
    }
}
