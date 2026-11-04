//! Packaged examples are copied once, file by file, into a writable workspace.
use std::{fs, io::{self, Write}, path::{Path, PathBuf}, sync::Mutex};
use serde::{Serialize, Deserialize};
use tauri::Manager;
#[derive(Default)]
pub struct ExampleStore(pub Mutex<Option<ExampleService>>);
#[derive(Serialize, Deserialize)]
struct Progress { status: String, path: Option<PathBuf> }
pub struct ExampleService { state: PathBuf, source: PathBuf, documents: PathBuf, fallback: PathBuf }
impl ExampleService {
    pub fn configure(state_dir: &Path, source: PathBuf, documents: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(state_dir)?;
        let service = Self { state: state_dir.join("examples-state.json"), source, documents, fallback: state_dir.join("examples") };
        if !service.state.try_exists()? {
            let existing = ["files.json", "editor-settings.json", "workspaces.json", "last-session.json", ".markumo-profile-migrated-v1", "recovery"]
                .iter().any(|name| state_dir.join(name).exists());
            service.save(&Progress { status: if existing { "skipped" } else { "pending" }.into(), path: None })?;
        }
        Ok(service)
    }
    fn save(&self, state: &Progress) -> io::Result<()> {
        let version = crate::files::disk_version(&self.state).map_err(io::Error::other)?;
        crate::files::atomic::write_checked(&self.state, &serde_json::to_vec(state)?, version.as_deref()).map_err(io::Error::other)
    }
    fn load(&self) -> io::Result<Progress> {
        let file = fs::File::open(&self.state)?;
        if file.metadata()?.len() > 8192 { return Err(io::Error::other("示例状态过大")); }
        Ok(serde_json::from_reader(file)?)
    }
    pub fn open(&self, automatic: bool, explicit_file: bool) -> io::Result<Option<PathBuf>> {
        let mut state = self.load()?;
        if automatic && explicit_file {
            state.status = "skipped".into(); self.save(&state)?; return Ok(None)
        }
        if automatic && state.status != "pending" { return Ok(None) }
        if state.path.is_none() {
            // Reserve a new directory; never adopt an unrelated folder with the same name.
            let mut reserved = None;
            for parent in [&self.documents, &self.fallback] {
                if fs::create_dir_all(parent).is_err() { continue }
                for index in 0..100 {
                    let name = if index == 0 { "Markumo Examples".into() } else { format!("Markumo Examples ({index})") };
                    let path = parent.join(name);
                    match fs::create_dir(&path) {
                        Ok(()) => { reserved = Some(path); break }
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                        Err(_) => break,
                    }
                }
                if reserved.is_some() { break }
            }
            state.path = Some(reserved.ok_or_else(|| io::Error::other("无法创建可写示例目录"))?);
            state.status = "pending".into(); self.save(&state)?;
        }
        let target = state.path.as_ref().unwrap();
        copy_examples(&self.source, target, target, &mut 0)?;
        if !target.join("README.md").is_file() { return Err(io::Error::other("示例缺少 README.md")); }
        state.status = "complete".into(); self.save(&state)?;
        Ok(state.path)
    }
}
fn copy_examples(source: &Path, target: &Path, root: &Path, count: &mut usize) -> io::Result<()> {
    crate::workspace::guard::validate_under_root(root, target).map_err(io::Error::other)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?; *count += 1;
        if *count > 150 { return Err(io::Error::other("示例数量超过预算")) }
        let meta = entry.file_type()?;
        if meta.is_symlink() { return Err(io::Error::other("示例不能包含符号链接")) }
        let path = target.join(entry.file_name());
        if meta.is_dir() {
            if !path.exists() { fs::create_dir(&path)?; }
            copy_examples(&entry.path(), &path, root, count)?;
        } else if meta.is_file() {
            if path.try_exists()? { continue }
            if entry.metadata()?.len() > 4 * 1024 * 1024 { return Err(io::Error::other("示例文件过大")) }
            // Commit with no-clobber so crashes never leave a partial destination.
            let mut temp = tempfile::NamedTempFile::new_in(target)?;
            io::copy(&mut fs::File::open(entry.path())?, &mut temp)?;
            temp.flush()?; temp.as_file().sync_all()?;
            temp.persist_noclobber(path).map_err(|e| e.error)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn example_workspace(store: tauri::State<'_, ExampleStore>) -> Result<String, String> {
    store.0.lock().map_err(|e| e.to_string())?.as_ref().ok_or("示例服务未初始化")?
        .open(false, false).map_err(|e| e.to_string())?.map(|p| p.to_string_lossy().into_owned()).ok_or("示例目录不可用".into())
}
pub fn automatic(app: &tauri::AppHandle, explicit_file: bool) -> Result<Option<PathBuf>, String> {
    app.state::<ExampleStore>().0.lock().map_err(|e| e.to_string())?.as_ref().ok_or("示例服务未初始化")?
        .open(true, explicit_file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
 use super::*;
 fn fixture() -> (tempfile::TempDir, ExampleService) {
  let temp = tempfile::tempdir().unwrap();
  let source = temp.path().join("source"); fs::create_dir(&source).unwrap(); fs::write(source.join("README.md"), "示例").unwrap();
  let service = ExampleService::configure(&temp.path().join("profile"), source, temp.path().join("documents")).unwrap();
  (temp, service)
 }
 #[test] fn once_and_preserves_user_edits() {
  let (_temp, service) = fixture(); let path = service.open(true, false).unwrap().unwrap();
  fs::write(path.join("README.md"), "我的修改").unwrap();
  assert!(service.open(true, false).unwrap().is_none());
  assert_eq!(service.open(false, false).unwrap(), Some(path.clone()));
  assert_eq!(fs::read_to_string(path.join("README.md")).unwrap(), "我的修改");
 }
 #[test] fn explicit_file_suppresses_future_automatic_open() {
  let (_temp, service) = fixture(); assert!(service.open(true, true).unwrap().is_none());
  assert!(service.open(true, false).unwrap().is_none()); assert!(service.open(false, false).unwrap().is_some());
 }
 #[test] fn existing_profile_is_not_new() {
  let temp = tempfile::tempdir().unwrap(); fs::write(temp.path().join("files.json"), "{}").unwrap();
  let service = ExampleService::configure(temp.path(), temp.path().join("source"), temp.path().join("docs")).unwrap();
  assert!(service.open(true, false).unwrap().is_none());
 }
 #[test] fn interruption_retries_without_overwriting() {
  let (_temp, service) = fixture(); fs::rename(&service.source, service.source.with_extension("backup")).unwrap();
  assert!(service.open(true, false).is_err()); assert_eq!(service.load().unwrap().status, "pending");
  let target = service.load().unwrap().path.unwrap(); fs::write(target.join("README.md"), "用户文件").unwrap();
  fs::rename(service.source.with_extension("backup"), &service.source).unwrap();
  assert_eq!(service.open(true, false).unwrap(), Some(target.clone()));
  assert_eq!(fs::read_to_string(target.join("README.md")).unwrap(), "用户文件");
 }
 #[test] fn directory_collision_and_unwritable_documents_fall_back() {
  let (_temp, mut service) = fixture(); fs::create_dir_all(service.documents.join("Markumo Examples")).unwrap();
  assert!(service.open(false, false).unwrap().unwrap().ends_with("Markumo Examples (1)"));
  let (_temp2, second) = fixture(); service = second;
  fs::write(&service.documents, "not a directory").unwrap();
  assert!(service.open(true, false).unwrap().unwrap().starts_with(&service.fallback));
 }
 #[test] fn concurrent_windows_initialize_once() {
  let (_temp, service) = fixture(); let service = std::sync::Arc::new(Mutex::new(service));
  let handles: Vec<_> = (0..4).map(|_| { let service = service.clone(); std::thread::spawn(move || service.lock().unwrap().open(true, false).unwrap()) }).collect();
  assert_eq!(handles.into_iter().filter_map(|h| h.join().unwrap()).count(), 1);
 }
}
