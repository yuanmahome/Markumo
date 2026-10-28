use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Mutex};
use tauri::Manager;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSettings {
    theme: String,
    ui_font_size: u8,
    font_size: u8,
    font_family: String,
    word_wrap: bool,
    typewriter_mode: bool,
    caret_animation: String,
    syntax_style: String,
    bracket_mode: String,
    show_outline: bool,
    outline_width: u16,
    indent_size: u8,
    use_tabs: bool,
    default_md_mode: String,
    live_toolbar: bool,
    markdown_typography: MarkdownTypography,
    markdown_clipboard: MarkdownClipboard,
    external_file_monitoring: bool,
    auto_reload_external: bool,
    auto_save: bool,
    auto_check_updates: bool,
    auto_download_updates: bool,
    auto_save_delay: u32,
    tree_click_mode: String,
    auto_follow_active_file: bool,
    smart_expand: bool,
    compact_folders: bool,
    #[serde(deserialize_with = "deserialize_keymap_preset")]
    keymap_preset: String,
    image_rules: ImageRules,
    document_image_rules: BTreeMap<String, ImageRules>,
    #[serde(default = "legacy_settings_version")]
    settings_version: u8,
    #[serde(default = "legacy_shortcut_version")]
    shortcut_version: u8,
    custom_shortcuts: Vec<String>,
    shortcuts: BTreeMap<String, String>,
    file_modes: BTreeMap<String, String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkdownTypography {
    width: u16,
    font_size: u8,
    font_family: String,
    line_height: f64,
    code_line_numbers: bool,
    code_wrap: bool,
    image_border: bool,
}
impl Default for MarkdownTypography {
    fn default() -> Self {
        Self {
            width: 860,
            font_size: 16,
            font_family: "system".into(),
            line_height: 1.6,
            code_line_numbers: true,
            code_wrap: false,
            image_border: true,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct MarkdownClipboard {
    copy_across_blocks: bool,
    copy_whole_line: bool,
    // Both legacy values already enabled cross-block Markdown. Accept the old
    // single-block override on read, then retire it on the next settings write.
    #[serde(rename = "copyMarkdown", skip_serializing)]
    _legacy_copy_markdown: Option<bool>,
}
impl Default for MarkdownClipboard {
    fn default() -> Self {
        Self {
            copy_across_blocks: true,
            copy_whole_line: false,
            _legacy_copy_markdown: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRules {
    location: String,
    custom_directory: String,
    relative: bool,
    dot_prefix: bool,
    escape: bool,
}
impl Default for ImageRules {
    fn default() -> Self {
        Self {
            location: "assets".into(),
            custom_directory: "./assets/".into(),
            relative: true,
            dot_prefix: true,
            escape: true,
        }
    }
}
fn valid_image_rules(rules: &ImageRules) -> bool {
    ["original", "sibling", "assets", "document", "custom"].contains(&rules.location.as_str())
        && rules.custom_directory.len() <= 4096
        && !rules.custom_directory.contains('\0')
}
impl Default for EditorSettings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            ui_font_size: 14,
            font_size: 14,
            font_family: "system".into(),
            word_wrap: false,
            typewriter_mode: false,
            caret_animation: "smooth".into(),
            syntax_style: "soft".into(),
            bracket_mode: "matching".into(),
            show_outline: false,
            outline_width: 240,
            indent_size: 2,
            use_tabs: false,
            default_md_mode: "live".into(),
            live_toolbar: true,
            markdown_typography: MarkdownTypography::default(),
            markdown_clipboard: MarkdownClipboard::default(),
            external_file_monitoring: true,
            auto_reload_external: true,
            auto_save: false,
            auto_check_updates: true,
            auto_download_updates: false,
            auto_save_delay: 1500,
            tree_click_mode: "single".into(),
            auto_follow_active_file: false,
            smart_expand: true,
            compact_folders: false,
            keymap_preset: "markumo".into(),
            image_rules: ImageRules::default(),
            document_image_rules: BTreeMap::new(),
            settings_version: 7,
            shortcut_version: 4,
            custom_shortcuts: Vec::new(),
            shortcuts: BTreeMap::new(),
            file_modes: BTreeMap::new(),
        }
    }
}
/// Files written before settings provenance existed carry no version field.
/// They are read as version 1 so a legacy `autoSave` value is preserved rather
/// than replaced by the new opt-in default.
fn legacy_settings_version() -> u8 {
    1
}
fn legacy_shortcut_version() -> u8 {
    1
}
fn deserialize_keymap_preset<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<String, D::Error> {
    let value = String::deserialize(deserializer)?;
    Ok(if value == "lightedit" {
        "markumo".into()
    } else {
        value
    })
}
fn validate(settings: &EditorSettings) -> Result<(), String> {
    if !["off", "matching", "rainbow"].contains(&settings.bracket_mode.as_str()) {
        return Err("不支持的括号高亮模式".into());
    }
    if ![
        "soft",
        "standard",
        "vivid",
        "fleet",
        "fleet-dark",
        "fleet-light",
        "monokai-pro",
        "monokai-classic",
        "one-dark",
        "github-dark",
        "github-light",
    ]
    .contains(&settings.syntax_style.as_str())
    {
        return Err("不支持的编辑器配色".into());
    }
    let md = &settings.markdown_typography;
    if !(480..=1400).contains(&md.width)
        || !(12..=28).contains(&md.font_size)
        || !md.line_height.is_finite()
        || !(1.2..=2.4).contains(&md.line_height)
        || !["system", "serif", "mono"].contains(&md.font_family.as_str())
    {
        return Err("Markdown 排版设置超出支持范围".into());
    }
    if !["dark", "light", "system"].contains(&settings.theme.as_str())
        || !(12..=20).contains(&settings.ui_font_size)
        || !(160..=520).contains(&settings.outline_width)
        || !(10..=24).contains(&settings.font_size)
        || !["system", "consolas", "cascadia"].contains(&settings.font_family.as_str())
        || !["off", "quick", "smooth"].contains(&settings.caret_animation.as_str())
        || !(1..=8).contains(&settings.indent_size)
        || !(500..=10000).contains(&settings.auto_save_delay)
        || !["single", "double"].contains(&settings.tree_click_mode.as_str())
        || !["markumo", "fleet", "typora"].contains(&settings.keymap_preset.as_str())
        || !(1..=7).contains(&settings.settings_version)
        || !(1..=4).contains(&settings.shortcut_version)
        || settings.custom_shortcuts.len() > 128
        || settings.custom_shortcuts.iter().any(|id| id.len() > 64)
        || !["live", "source", "split"].contains(&settings.default_md_mode.as_str())
        || settings.file_modes.len() > 100
        || settings.shortcuts.len() > 128
        || !valid_image_rules(&settings.image_rules)
        || settings.document_image_rules.len() > 100
        || settings
            .document_image_rules
            .iter()
            .any(|(key, value)| key.len() > 16384 || !valid_image_rules(value))
    {
        return Err("首选项超出支持范围".into());
    }
    if settings.file_modes.iter().any(|(path, mode)| {
        path.len() > 16384 || !["live", "source", "split"].contains(&mode.as_str())
    }) || settings
        .shortcuts
        .iter()
        .any(|(id, key)| id.len() > 64 || key.len() > 64)
    {
        return Err("首选项字段无效".into());
    }
    Ok(())
}
fn load(path: &std::path::Path) -> Result<EditorSettings, String> {
    if !path.exists() {
        return Ok(EditorSettings::default());
    }
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 128 * 1024 {
        return Err("首选项文件过大".into());
    }
    let mut settings: EditorSettings =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("首选项损坏: {e}"))?;
    settings.syntax_style = match settings.syntax_style.as_str() {
        "fleet" | "fleet-dark" | "fleet-light" => "soft".into(),
        "monokai-pro" | "monokai-classic" => "vivid".into(),
        "one-dark" | "github-dark" | "github-light" => "standard".into(),
        _ => settings.syntax_style,
    };
    validate(&settings)?;
    Ok(settings)
}
fn save(path: &std::path::Path, settings: &EditorSettings) -> Result<(), String> {
    validate(settings)?;
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(path.parent().ok_or("首选项目录无效")?).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("首选项文件过大；旧设置仍保留".into());
    }
    let version = crate::files::disk_version(path).map_err(|e| e.message)?;
    let canonical = crate::files::checked_path(path, true).map_err(|e| e.message)?;
    crate::files::atomic::write_checked(&canonical, &bytes, version.as_deref())
        .map_err(|e| e.message)
}
#[tauri::command]
pub async fn load_editor_settings(app: tauri::AppHandle) -> Result<EditorSettings, String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("editor-settings.json");
    tauri::async_runtime::spawn_blocking(move || load(&path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn save_editor_settings(
    app: tauri::AppHandle,
    settings: EditorSettings,
) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("editor-settings.json");
    tauri::async_runtime::spawn_blocking(move || save(&path, &settings))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod clipboard_tests {
    use super::*;

    #[test]
    fn legacy_clipboard_keeps_cross_block_and_whole_line_behavior() {
        for always_markdown in [false, true] {
            let settings: EditorSettings = serde_json::from_value(serde_json::json!({
                "settingsVersion": 6,
                "markdownClipboard": {"copyMarkdown": always_markdown, "copyWholeLine": true}
            }))
            .unwrap();
            assert!(validate(&settings).is_ok());
            let value = serde_json::to_value(&settings).unwrap();
            assert_eq!(
                value["markdownClipboard"],
                serde_json::json!({
                    "copyAcrossBlocks": true, "copyWholeLine": true
                })
            );
        }
    }

    #[test]
    fn cross_block_opt_out_survives_native_serialization() {
        let settings: EditorSettings = serde_json::from_value(serde_json::json!({
            "settingsVersion": 7,
            "markdownClipboard": {"copyAcrossBlocks": false, "copyWholeLine": true}
        }))
        .unwrap();
        assert!(validate(&settings).is_ok());
        let next: EditorSettings =
            serde_json::from_slice(&serde_json::to_vec(&settings).unwrap()).unwrap();
        assert!(!next.markdown_clipboard.copy_across_blocks);
        assert!(next.markdown_clipboard.copy_whole_line);
        assert!(MarkdownClipboard::default().copy_across_blocks);
        assert!(serde_json::from_value::<EditorSettings>(serde_json::json!({
            "markdownClipboard": {"copyAcrossBlocks": "false"}
        }))
        .is_err());
    }
}
