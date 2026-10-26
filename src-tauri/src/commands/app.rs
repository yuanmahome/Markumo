#[tauri::command]
pub fn get_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
pub fn ensure_update_window(window: tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Manager;
    if window.app_handle().webview_windows().len() != 1 {
        return Err("请先保存修改并关闭其他 Markumo 窗口，再安装更新。".into());
    }
    Ok(())
}

fn validated_external_url(raw: &str) -> Result<String, String> {
    let url = tauri::Url::parse(raw).map_err(|_| "无效链接".to_string())?;
    if !["http", "https"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("仅允许不含账号信息的 HTTP/HTTPS 链接".into());
    }
    Ok(url.into())
}

#[tauri::command]
pub async fn open_external_link(url: String) -> Result<(), String> {
    let url = validated_external_url(&url)?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::Shell::ShellExecuteW;
            let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
            // Dispatch directly through the registered URL association. Waiting
            // for rundll32 can otherwise leave a click pending without feedback.
            let result = unsafe {
                ShellExecuteW(
                    std::ptr::null_mut(),
                    std::ptr::null(),
                    wide.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    1,
                )
            } as isize;
            if result > 32 {
                Ok(())
            } else {
                Err(format!(
                    "系统浏览器未能打开链接（错误 {result}），请检查 HTTP/HTTPS 默认浏览器。"
                ))
            }
        }
        #[cfg(not(windows))]
        {
            #[cfg(target_os = "macos")]
            let mut command = {
                let mut command = std::process::Command::new("open");
                command.arg(&url);
                command
            };
            #[cfg(all(not(windows), not(target_os = "macos")))]
            let mut command = {
                let mut command = std::process::Command::new("xdg-open");
                command.arg(&url);
                command
            };
            let status = command.status().map_err(|e| format!("打开链接失败: {e}"))?;
            if !status.success() {
                return Err("系统浏览器未能打开链接".into());
            }
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
