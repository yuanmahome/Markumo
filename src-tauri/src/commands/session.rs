use crate::{
    commands::{files::FileStore, workspace::WorkspaceStore},
    files::{Layout, OpenBatch},
    session::{LaunchKind, LaunchStore, SessionInput, SessionStore},
    workspace::WorkspaceInfo,
};
use serde::Serialize;
use tauri::{Manager, State, Window};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Startup {
    kind: LaunchKind,
    files: OpenBatch,
    roots: Vec<WorkspaceInfo>,
    active_path: Option<String>,
    layout: Layout,
    warnings: Vec<String>,
    owns_session: bool,
    editor_layout: Option<serde_json::Value>,
}

#[tauri::command]
pub async fn initialize_launch(
    app: tauri::AppHandle,
    window: Window,
    launches: State<'_, LaunchStore>,
    sessions: State<'_, SessionStore>,
    files: State<'_, FileStore>,
    workspaces: State<'_, WorkspaceStore>,
) -> Result<Startup, String> {
    let label = window.label().to_owned();
    let launch = launches
        .lock()
        .map_err(|e| e.to_string())?
        .windows
        .get(&label)
        .cloned()
        .ok_or("窗口启动请求尚未注册")?;
    let session = if launch.kind == LaunchKind::App {
        sessions.lock().map_err(|e| e.to_string())?.load()
    } else {
        Ok(None)
    };
    let files = files.inner().clone();
    let workspaces = workspaces.for_window(&label)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = Startup {
            kind: launch.kind,
            files: OpenBatch::default(),
            roots: Vec::new(),
            active_path: None,
            layout: Layout::default(),
            warnings: Vec::new(),
            owns_session: launch.kind == LaunchKind::App,
            editor_layout: None,
        };
        let session = match session {
            Ok(session) => session,
            Err(error) => {
                result.warnings.push(error);
                None
            }
        };
        if let Some(session) = session.as_ref() {
            result.layout = session.layout.clone();
            result.active_path = session.active_path.clone();
            result.editor_layout = session.editor_layout.clone();
            if session.kind == "workspace" {
                let mut ws = workspaces.lock().map_err(|e| e.to_string())?;
                for root in &session.roots {
                    match ws.add_workspace(root.into()) {
                        Ok(info) => result.roots.push(info),
                        Err(error) => result
                            .warnings
                            .push(format!("工作区恢复失败：{root}：{error}")),
                    }
                }
            }
        }
        // An interrupted example open can persist the root before README succeeds.
        let example_path = app.state::<crate::examples::ExampleStore>().0.lock()
            .ok().and_then(|store| store.as_ref().and_then(|service| service.workspace_path().ok().flatten()));
        let empty_session = allows_automatic_example(session.as_ref(), example_path.as_deref());
        if launch.kind != LaunchKind::Detached && (launch.kind == LaunchKind::File || empty_session) {
            match crate::examples::automatic(&app, launch.kind == LaunchKind::File) {
                Ok(Some(path)) => {
                    match workspaces.lock().map_err(|e| e.to_string())?.add_workspace(path.clone()) {
                        Ok(info) => {
                            if !result.roots.iter().any(|root| root.root_path == info.root_path) { result.roots.push(info); }
                            result.layout.mode = "workspace".into(); result.layout.sidebar_visible = true;
                            // The saved empty layout must not remove the freshly opened README.
                            result.editor_layout = None;
                            let readme = path.join("README.md");
                            result.active_path = Some(readme.to_string_lossy().into_owned());
                            let mut service = files.lock().map_err(|e| e.to_string())?;
                            service.set_owner(&label);
                            result.files = service.open_batch(vec![readme], None);
                        }
                        Err(error) => result.warnings.push(error),
                    }
                }
                Err(error) => result.warnings.push(format!("示例工作区初始化失败：{error}")),
                _ => {}
            }
        }
        let mut service = files.lock().map_err(|e| e.to_string())?;
        service.set_owner(&label);
        if launch.kind == LaunchKind::File {
            result.files = service.open_batch(launch.paths, None)
        } else if let Some(session) = session {
            let mut bytes = 0;
            for tab in session.tabs {
                if bytes >= 48 * 1024 * 1024 {
                    result
                        .warnings
                        .push("恢复文件总量超过48 MiB，剩余标签已跳过".into());
                    break;
                }
                let path = std::path::PathBuf::from(&tab.path);
                if crate::files::checked_path(&path, false).is_ok_and(|canonical| canonical != path)
                {
                    result
                        .files
                        .errors
                        .push(format!("路径目标发生变化，已跳过 {}", tab.path));
                    continue;
                }
                match service.open_selected(path, Some(&tab.encoding)) {
                    Ok(file) => {
                        bytes += file.text.len();
                        result.files.files.push(file)
                    }
                    Err(error) => result
                        .files
                        .errors
                        .push(format!("无法恢复 {}：{}", tab.path, error)),
                }
            }
        }
        // Failed roots degrade to a safe single-file/empty view.
        if result.roots.is_empty() {
            result.layout.mode = "single".into();
            result.layout.sidebar_visible = false;
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
// Tauri injects each managed state handle independently; grouping them would
// change the command contract used by the frontend.
#[allow(clippy::too_many_arguments)]
pub async fn persist_session(
    window: Window,
    input: SessionInput,
    launches: State<'_, LaunchStore>,
    sessions: State<'_, SessionStore>,
    files: State<'_, FileStore>,
    workspaces: State<'_, WorkspaceStore>,
    updates: State<'_, super::update::UpdateStore>,
    for_update: Option<bool>,
) -> Result<(), String> {
    let label = window.label();
    if for_update.unwrap_or(false) {
        updates
            .lock()
            .map_err(|e| e.to_string())?
            .require_owner(label)?;
    } else if launches
        .lock()
        .map_err(|e| e.to_string())?
        .owner()
        .as_deref()
        != Some(label)
    {
        return Err("文件关联临时窗口不能写入主会话".into());
    }
    let roots = workspaces
        .for_window(label)?
        .lock()
        .map_err(|e| e.to_string())?
        .roots();
    let mut file_service = files.lock().map_err(|e| e.to_string())?;
    file_service.set_owner(label);
    let session = crate::session::capture(input, &file_service, roots)?;
    drop(file_service);
    // Bounded atomic JSON write, serialized independently of editor input.
    sessions.lock().map_err(|e| e.to_string())?.save(&session)
}

// Only an empty session or our own interrupted example workspace may be replaced.
fn allows_automatic_example(session: Option<&crate::session::LastSession>, example: Option<&std::path::Path>) -> bool {
    session.is_none_or(|s| s.tabs.is_empty() && (
        s.roots.is_empty() || example.is_some_and(|example| s.roots.iter().all(|root|
            std::path::Path::new(root).canonicalize().ok().zip(example.canonicalize().ok()).is_some_and(|(root, example)| root == example)
        ))
    ))
}

#[cfg(test)]
mod example_launch_tests {
    use super::*;
    #[test]
    fn retry_empty_session_but_keep_user_files_and_workspaces() {
        let temp = tempfile::tempdir().unwrap();
        let example = temp.path().join("example"); let user = temp.path().join("user");
        std::fs::create_dir(&example).unwrap(); std::fs::create_dir(&user).unwrap();
        let mut session: crate::session::LastSession = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "kind": "single", "roots": [], "tabs": [], "activePath": null,
            "layout": {"mode":"single", "sidebarVisible":false, "sidebarWidth":254}
        })).unwrap();
        assert!(allows_automatic_example(Some(&session), Some(&example)));
        session.roots.push(example.to_string_lossy().into_owned());
        assert!(allows_automatic_example(Some(&session), Some(&example)));
        session.roots.push(user.to_string_lossy().into_owned());
        assert!(!allows_automatic_example(Some(&session), Some(&example)));
        session.roots.clear();
        session.tabs.push(crate::session::SessionTab {path: "user.md".into(), encoding: "UTF-8".into()});
        assert!(!allows_automatic_example(Some(&session), Some(&example)));
    }
}
