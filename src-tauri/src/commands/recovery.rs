use crate::{
    recovery::{RecoveryInput, RecoveryList, RecoveryRead, RecoverySaveResult, RecoveryStore},
    session::LaunchStore,
};
use tauri::{State, Window};

fn require_owner(window: &Window, launches: &LaunchStore) -> Result<(), String> {
    if launches
        .lock()
        .map_err(|e| e.to_string())?
        .owner()
        .as_deref()
        != Some(window.label())
    {
        return Err("只有主窗口可以访问未保存文档恢复记录".into());
    }
    Ok(())
}

#[tauri::command]
pub fn recovery_list(
    window: Window,
    launches: State<'_, LaunchStore>,
    store: State<'_, RecoveryStore>,
) -> Result<RecoveryList, String> {
    require_owner(&window, &launches)?;
    let registry = launches.lock().map_err(|e| e.to_string())?;
    let mut result = store.lock().map_err(|e| e.to_string())?.list()?;
    // A live editor's checkpoint is not an abandoned recovery draft.
    result.records.retain(|record| registry.recovery_claims.get(&record.id)
        .is_none_or(|owner| owner == window.label()));
    Ok(result)
}

#[tauri::command]
pub fn recovery_read(
    window: Window,
    id: String,
    launches: State<'_, LaunchStore>,
    store: State<'_, RecoveryStore>,
) -> Result<RecoveryRead, String> {
    require_owner(&window, &launches)?;
    store.lock().map_err(|e| e.to_string())?.read(&id)
}

#[tauri::command]
pub fn recovery_save(
    window: Window,
    input: RecoveryInput,
    token: Option<String>,
    files: State<'_, crate::commands::files::FileStore>,
    launches: State<'_, LaunchStore>,
    store: State<'_, RecoveryStore>,
) -> Result<RecoverySaveResult, String> {
    let mut registry = launches.lock().map_err(|e| e.to_string())?;
    let label = window.label();
    if !registry.windows.contains_key(label) { return Err("窗口未注册".into()); }
    if registry.owner().as_deref() != Some(label) {
        if input.id.as_ref().is_some_and(|id| registry.recovery_claims.get(id).map(String::as_str) != Some(label)) { return Err("恢复记录不属于此窗口".into()); }
        if let Some(path) = &input.path {
            let mut service = files.lock().map_err(|e| e.to_string())?;
            service.set_owner(label);
            let granted = service.session_path(token.as_deref().ok_or("缺少文件授权")?).map_err(|e| e.message)?;
            if !crate::workspace::search::same_file(path, &granted) { return Err("恢复路径与文件授权不符".into()); }
        }
    }
    let result = store.lock().map_err(|e| e.to_string())?.save(input)?;
    registry.recovery_claims.insert(result.record.id.clone(), label.into());
    Ok(result)
}

#[tauri::command]
pub fn recovery_delete(
    window: Window,
    id: String,
    launches: State<'_, LaunchStore>,
    store: State<'_, RecoveryStore>,
) -> Result<(), String> {
    let mut registry = launches.lock().map_err(|e| e.to_string())?;
    if registry.recovery_claims.get(&id).is_some_and(|owner| owner != window.label()) {
        return Err("其他窗口正在使用此恢复快照".into());
    }
    if registry.owner().as_deref() != Some(window.label()) && registry.recovery_claims.get(&id).map(String::as_str) != Some(window.label()) { return Err("恢复记录不属于此窗口".into()); }
    store.lock().map_err(|e| e.to_string())?.delete(&id)?;
    registry.recovery_claims.remove(&id);
    Ok(())
}
