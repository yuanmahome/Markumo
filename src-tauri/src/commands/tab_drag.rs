//! An on-demand physical pointer release observer. No window or WebView is
//! created here. DOM capture remains responsible for in-window drop targets.
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Emitter, WebviewWindow};
pub type NativeDragStore = Arc<Mutex<HashMap<String, (String, Arc<AtomicBool>)>>>;
pub fn cancel_owner(store: &NativeDragStore, owner: &str, id: Option<&str>) {
    if let Ok(mut entries) = store.lock() {
        if entries
            .get(owner)
            .is_some_and(|(current, _)| id.is_none_or(|id| id == current))
        {
            if let Some((_, flag)) = entries.remove(owner) {
                flag.store(true, Ordering::Relaxed)
            }
        }
    }
}
#[tauri::command]
pub fn cancel_tab_drag(
    window: WebviewWindow,
    store: tauri::State<'_, NativeDragStore>,
    id: String,
) {
    cancel_owner(&store, window.label(), Some(&id))
}
#[tauri::command]
pub fn begin_tab_drag(
    window: WebviewWindow,
    store: tauri::State<'_, NativeDragStore>,
    id: String,
) -> Result<bool, String> {
    if id.is_empty() || id.len() > 128 {
        return Err("无效拖动标识".into());
    }
    #[cfg(not(windows))]
    {
        let _ = (window, store, id);
        Ok(false)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_CONTROL, VK_ESCAPE, VK_LBUTTON, VK_MENU,
            },
            WindowsAndMessaging::{GetCursorPos, GetForegroundWindow, GetWindowThreadProcessId},
        };
        // CDP/synthetic pointer events are not physical drags. They continue
        // through the DOM path instead of being mistaken for an OS release.
        if unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } >= 0 {
            return Ok(false);
        }
        cancel_owner(&store, window.label(), None);
        let flag = Arc::new(AtomicBool::new(false));
        store
            .lock()
            .map_err(|e| e.to_string())?
            .insert(window.label().into(), (id.clone(), flag.clone()));
        let registry = store.inner().clone();
        let failure_owner = window.label().to_owned();
        let failure_id = id.clone();
        std::thread::Builder::new().name("tab-drag-release".into()).spawn(move||{
            let started=Instant::now();
            let point=loop{
                if flag.load(Ordering::Relaxed){break None}
                if started.elapsed()>Duration::from_secs(120)||window.is_minimized().unwrap_or(true)||unsafe{GetAsyncKeyState(VK_ESCAPE as i32)}<0{break None}
                let foreground=unsafe{GetForegroundWindow()};let mut pid=0;
                unsafe{GetWindowThreadProcessId(foreground,&mut pid)};
                // Alt-Tab or another application taking focus cancels. A blur
                // while moving over another Markumo window is still permitted.
                if pid!=std::process::id(){break None}
                let mut cursor=windows_sys::Win32::Foundation::POINT{x:0,y:0};
                if unsafe{GetCursorPos(&mut cursor)}==0{break None}
                if unsafe{GetAsyncKeyState(VK_LBUTTON as i32)}>=0{
                    let origin=window.inner_position().ok();let scale=window.scale_factor().unwrap_or(1.0);
                    break origin.map(|origin|serde_json::json!({"x":(cursor.x-origin.x) as f64/scale,"y":(cursor.y-origin.y) as f64/scale,"ctrlKey":unsafe{GetAsyncKeyState(VK_CONTROL as i32)}<0,"altKey":unsafe{GetAsyncKeyState(VK_MENU as i32)}<0}));
                }
                std::thread::sleep(Duration::from_millis(16));
            };
            if !flag.load(Ordering::Relaxed){let _=window.emit_to(window.label(),"markumo:tab-drag-finished",serde_json::json!({"id":id,"point":point}));}
            if let Ok(mut entries)=registry.lock(){if entries.get(window.label()).is_some_and(|(_,current)|Arc::ptr_eq(current,&flag)){entries.remove(window.label());}}
        }).map_err(|e|{cancel_owner(&store,&failure_owner,Some(&failure_id));e.to_string()})?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_is_scoped_to_owner_and_drag_id() {
        let store = NativeDragStore::default();
        let flag = Arc::new(AtomicBool::new(false));
        store
            .lock()
            .unwrap()
            .insert("main".into(), ("new".into(), flag.clone()));
        cancel_owner(&store, "other", None);
        cancel_owner(&store, "main", Some("old"));
        assert!(!flag.load(Ordering::Relaxed));
        cancel_owner(&store, "main", Some("new"));
        assert!(flag.load(Ordering::Relaxed));
        assert!(store.lock().unwrap().is_empty());
    }
}
