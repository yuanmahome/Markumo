mod commands;
mod conversion;
mod display;
mod detach;
mod files;
mod history;
mod profile_migration;
mod recovery;
mod session;
mod workspace;

use commands::files::FileStore;
use commands::workspace::WorkspaceStore;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tauri::{Emitter, Manager};
use workspace::SearchManager;

/// Registers a window's workspace service and launch record.
fn register_window(app: &tauri::AppHandle, label: &str, paths: Vec<PathBuf>) -> Result<(), String> {
    let updates = app.state::<commands::update::UpdateStore>();
    let coordinator = updates.lock().map_err(|e| e.to_string())?;
    if coordinator.owner.is_some() {
        return Err("正在安装更新，请重启后再打开新窗口。".into());
    }
    let temporary = !paths.is_empty();
    let mut ws = workspace::WorkspaceService::default();
    ws.configure(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("workspaces.json"),
    );
    if temporary {
        ws.disable_persistence()
    }
    app.state::<WorkspaceStore>().insert(label, ws)?;
    let state = app.state::<session::LaunchStore>();
    let mut registry = state.lock().map_err(|_| "启动状态不可用".to_string())?;
    if !registry.windows.contains_key(label) {
        registry.insert(label.into(), paths);
    }
    app.state::<conversion::ConversionStore>().register(label);
    Ok(())
}

/// Registers a window created by detaching a tab.
///
/// It owns no session and keeps no workspace persistence of its own, so the new
/// window cannot overwrite the main session or duplicate the workspace index.
pub(crate) fn register_detached_window(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<(), String> {
    let updates = app.state::<commands::update::UpdateStore>();
    let coordinator = updates.lock().map_err(|e| e.to_string())?;
    if coordinator.owner.is_some() {
        return Err("正在安装更新，请重启后再移动标签。".into());
    }
    drop(coordinator);
    let mut ws = workspace::WorkspaceService::default();
    ws.configure(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("workspaces.json"),
    );
    ws.disable_persistence();
    app.state::<WorkspaceStore>().insert(label, ws)?;
    app.state::<session::LaunchStore>()
        .lock()
        .map_err(|_| "启动状态不可用".to_string())?
        .insert_detached(label.into());
    app.state::<conversion::ConversionStore>().register(label);
    Ok(())
}

fn cleanup_window(app: &tauri::AppHandle, label: &str) {    app.state::<conversion::ConversionStore>().close(label);
    if let Ok(mut registry) = app.state::<session::LaunchStore>().lock() {
        registry.remove(label);
    }
    app.state::<WorkspaceStore>().remove(label);
}

/// Brings a window to the front and asks its frontend to open whatever was
/// queued for it. The queued paths stay in the registry until the frontend
/// drains them, so a request that arrives before the page is ready is not lost.
fn deliver(app: &tauri::AppHandle, label: &str) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = window.emit("files-pending", ());
}

/// Asks a window to select tabs it already has, without reading the files again
/// or creating duplicate tabs.
fn activate(app: &tauri::AppHandle, label: &str, paths: &[PathBuf]) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.set_focus();
    let _ = window.emit("external-activate", paths.to_vec());
}

/// External open router. One decision point for every file handed to Markumo
/// from the shell (double-click, "open with", context menu, second instance).
///
/// Rules:
/// * A file already open in any window activates that window and tab; it is never
///   reloaded over unsaved edits and never duplicated.
/// * A file already queued for a window stays with that window.
/// * Otherwise the most recent single-file window takes the file as a new tab.
/// * With no single-file window, one is created for this batch. A workspace
///   window is never given external files, so its tabs and unsaved work stay put.
fn route_launch(app: tauri::AppHandle, paths: Vec<PathBuf>) {
    // WebView2 window creation must run outside a synchronous event handler.
    std::thread::spawn(move || {
        let requested = session::normalize_external_paths(paths);
        if requested.is_empty() {
            // No usable file arguments: surface the primary window instead.
            let label = {
                let state = app.state::<session::LaunchStore>();
                let registry = match state.lock() {
                    Ok(registry) => registry,
                    Err(_) => return,
                };
                registry.owner().or_else(|| registry.latest_window())
            };
            if let Some(label) = label {
                deliver(&app, &label)
            }
            return;
        }
        // Ownership snapshot first, then one atomic registry decision. The two
        // locks are never held at the same time, so no ordering deadlock exists.
        // Native identities are resolved before taking the file-service lock so
        // a locked or slow file cannot stall every window.
        let identities: Vec<_> = requested
            .iter()
            .map(|path| files::file_identity(path))
            .collect();
        let owners: Vec<Option<String>> = {
            let store = app.state::<FileStore>();
            let files = match store.lock() {
                Ok(files) => files,
                Err(_) => return,
            };
            requested
                .iter()
                .zip(identities)
                .map(|(path, identity)| files.owner_of_path(path, identity))
                .collect()
        };
        let plan = {
            let state = app.state::<session::LaunchStore>();
            let mut registry = match state.lock() {
                Ok(registry) => registry,
                Err(_) => return,
            };
            session::plan_external_open(&mut registry, &requested, &owners, &|label| {
                app.get_webview_window(label).is_some()
            })
        };
        for label in &plan.deliveries {
            deliver(&app, label)
        }
        for (label, paths) in &plan.activate {
            activate(&app, label, paths)
        }
        if let Some((label, initial)) = plan.created {
            if let Err(error) = register_window(&app, &label, initial) {
                eprintln!("启动窗口失败：{error}");
                cleanup_window(&app, &label);
                return;
            }
            let mut config = app.config().app.windows[0].clone();
            config.label = label.clone();
            if let Err(error) = tauri::WebviewWindowBuilder::from_config(&app, &config)
                .and_then(|builder| builder.build())
            {
                eprintln!("创建窗口失败：{error}");
                cleanup_window(&app, &label);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace_store = WorkspaceStore::default();
    let search_manager = SearchManager::default();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            route_launch(app.clone(), session::argument_paths(args, std::path::Path::new(&cwd)));
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Arc::new(Mutex::new(files::FileService::default())))
        .manage(workspace_store)
        .manage(session::LaunchStore::default())
        .manage(session::SessionStore::default())
        .manage(commands::update::UpdateStore::default())
        .manage(conversion::ConversionStore::default())
        .manage(recovery::RecoveryStore::default())
        .manage(search_manager)
        .manage(commands::detach::DetachStore::default())
        .manage(commands::tab_drag::NativeDragStore::default())
        .manage(std::sync::Arc::new(std::sync::Mutex::new(history::HistoryStore::default())))
        .setup(move |app| {
            let store = app.state::<FileStore>();
            let mut service = store.lock().map_err(|_| std::io::Error::other("文件服务状态损坏"))?;
            let app_data = app.path().app_data_dir()?;
            profile_migration::migrate(&app_data)?;
            service.configure(app_data.join("files.json"));
            // Initialization failure is reported by watch_external, not hidden.
            service.external_watcher = files::external::ExternalWatcher::new(app.handle().clone()).ok();
            drop(service);
            app.state::<recovery::RecoveryStore>()
                .lock()
                .map_err(|_| std::io::Error::other("恢复存储状态损坏"))?
                .configure(app_data.join("recovery"));
            // Saved-version history lives in its own directory so it can never be
            // confused with crash-recovery drafts.
            app.state::<std::sync::Arc<std::sync::Mutex<history::HistoryStore>>>()
                .lock()
                .map_err(|_| std::io::Error::other("历史版本存储状态损坏"))?
                .configure(app_data.join("history"));
            app.state::<session::SessionStore>().lock().map_err(|_|std::io::Error::other("会话状态损坏"))?.configure(app_data.join("last-session.json"));
            let paths=session::argument_paths(std::env::args(),&std::env::current_dir()?);
            let restoring_update=commands::update::restore_after_update(&app_data.join("pending-update.json"),env!("CARGO_PKG_VERSION"));
            register_window(app.handle(),"main",if restoring_update{Vec::new()}else{paths.clone()}).map_err(std::io::Error::other)?;
            if restoring_update {
                if let Some(main)=app.state::<session::LaunchStore>().lock().map_err(|_|std::io::Error::other("会话状态损坏"))?.windows.get_mut("main"){main.pending=paths;}
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // Require the registered frontend close handshake. Even startup or
            // failed JS registration must not silently close an unsaved editor.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) = event {
                // Frontend hit-tests the editor before deciding import vs open.
                // Send capabilities, never accept arbitrary frontend paths.
                if let Ok(mut files)=window.app_handle().state::<FileStore>().lock(){
                    files.set_owner(window.label());
                    let inputs=files.image_inputs(paths.clone());
                    let scale=window.scale_factor().unwrap_or(1.0);
                    let _=window.emit_to(window.label(),"native-file-drop",serde_json::json!({"inputs":inputs,"x":position.x/scale,"y":position.y/scale}));
                }
            }
            if let tauri::WindowEvent::Destroyed=event{
                let app=window.app_handle();
                commands::tab_drag::cancel_owner(&app.state::<commands::tab_drag::NativeDragStore>(),window.label(),None);
                let search=app.state::<SearchManager>();search.forget_owner(window.label());
                let previews=search.previews.clone();let owner=window.label().to_owned();
                tauri::async_runtime::spawn_blocking(move||{if let Ok(mut cache)=previews.lock(){cache.clear(&owner)}});
                app.state::<conversion::ConversionStore>().close(window.label());
                if let Ok(mut update)=app.state::<commands::update::UpdateStore>().lock(){update.release(window.label());update.statuses.remove(window.label());}
                app.state::<WorkspaceStore>().remove(window.label());
                if let Ok(mut registry)=app.state::<session::LaunchStore>().lock(){registry.windows.remove(window.label());}
                // A detached window that closed before adopting must not leak
                // the document body or keep the source tab blocked.
                commands::detach::forget_window(
                    app,
                    &app.state::<commands::detach::DetachStore>().inner().clone(),
                    &app.state::<FileStore>().inner().clone(),
                    window.label(),
                );
                if let Ok(mut files)=app.state::<FileStore>().lock(){files.release_owner(window.label());}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::update::update_runtime, commands::update::report_update_window, commands::update::update_windows_status,
            commands::update::begin_update_install, commands::update::end_update_install, commands::update::mark_update_pending,
            commands::update::clear_update_pending, commands::update::confirm_update_startup,
            commands::app::get_app_version,
            commands::app::ensure_update_window,
            commands::session::initialize_launch,commands::session::persist_session,
            commands::detach::detach_tab_to_window, commands::detach::take_detached_document,
            commands::tab_drag::begin_tab_drag,commands::tab_drag::cancel_tab_drag,
            commands::detach::detach_status,
            commands::detach::commit_detach, commands::detach::cancel_detach,
            commands::history::history_record, commands::history::history_import, commands::history::history_list,
            commands::history::history_read, commands::history::history_delete,
            commands::history::history_clear, commands::history::history_usage,
            commands::recovery::recovery_list, commands::recovery::recovery_read,
            commands::recovery::recovery_save, commands::recovery::recovery_delete,
            commands::app::open_external_link,
            commands::settings::load_editor_settings, commands::settings::save_editor_settings,
            commands::files::open_dialog, commands::files::save_dialog,
            commands::files::open_recent, commands::files::reopen_file,
            commands::files::save_file, commands::files::release_file,
            commands::files::check_external_file, commands::files::read_external_file, commands::files::watch_external_files,
            commands::files::begin_external_watch, commands::files::end_external_watch,
            commands::files::read_class_hex,
            commands::files::media_metadata,
            commands::files::read_media_chunk,
            commands::files::open_media_default,
            commands::files::read_markdown_image,
            commands::files::reveal_markdown_image,
            commands::files::open_markdown_image_default,
            commands::files::choose_markdown_images,commands::files::import_markdown_image,
            commands::files::authorize_markdown_image_directory,commands::files::release_image_inputs,
            commands::files::authorize_markdown_image_read,
            commands::files::open_dropped_files,commands::files::clipboard_image_files,
            commands::workspace::reveal_workspace_node,
            commands::files::drain_pending, commands::files::file_preferences, commands::files::persist_layout,
            commands::workspace::open_workspace_dialog,
            commands::workspace::open_dropped_workspace,
            commands::workspace::remove_workspace_folder,
            commands::workspace::restore_workspace_folders,
            commands::workspace::open_workspace_path,
            commands::workspace::open_workspace_file,
            commands::workspace::read_directory,
            commands::workspace::workspace_file_visible,
            commands::workspace::create_workspace_file,
            commands::workspace::create_workspace_directory,
            commands::workspace::rename_workspace_node,
            commands::workspace::delete_workspace_node,
            commands::workspace::move_workspace_node,
            commands::workspace::get_recent_workspaces,
            commands::workspace::search_workspace,
            commands::workspace::preview_workspace_search,
            commands::workspace::clear_workspace_search_preview,
            commands::workspace::choose_workspace_search_directory,
            commands::workspace::preview_workspace_replace,
            commands::workspace::apply_workspace_replace,
            commands::workspace::validate_workspace_replace,
            commands::workspace::cancel_workspace_search,
            commands::workspace::find_workspace_files,
            commands::workspace::set_workspace_ignored,
            commands::workspace::reveal_in_explorer,
            commands::conversion::detect_pandoc,
            commands::conversion::export_save_dialog,
            commands::conversion::import_open_dialog,
            commands::conversion::release_conversion_lease,
            commands::conversion::read_conversion_html,
            commands::conversion::save_binary_file, commands::conversion::save_docx_bytes,
            commands::conversion::pandoc_export_docx,
            commands::conversion::pandoc_import_docx,
            commands::conversion::print_to_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Markumo");
}
