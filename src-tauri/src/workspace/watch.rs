use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

use crate::display::display_path;

pub(super) struct WorkspaceWatcher {
    app: AppHandle,
    label: String,
    watcher: Option<RecommendedWatcher>,
    roots: HashSet<PathBuf>,
}

impl WorkspaceWatcher {
    pub(super) fn new(app: AppHandle, label: &str) -> Self {
        Self {
            app,
            label: label.into(),
            watcher: None,
            roots: HashSet::new(),
        }
    }

    pub(super) fn set_roots(&mut self, roots: Vec<PathBuf>) -> Result<(), String> {
        if roots.is_empty() {
            self.watcher = None;
            self.roots.clear();
            return Ok(());
        }
        if self.watcher.is_none() {
            self.watcher = Some(self.start().map_err(|e| e.to_string())?);
        }
        let watcher = self.watcher.as_mut().unwrap();
        let wanted: HashSet<_> = roots.into_iter().collect();
        self.roots.retain(|root| {
            if wanted.contains(root) {
                return true;
            }
            let _ = watcher.unwatch(root);
            false
        });
        let mut failures = Vec::new();
        for root in wanted {
            if !self.roots.contains(&root) {
                match watcher.watch(&root, RecursiveMode::Recursive) {
                    Ok(()) => {
                        self.roots.insert(root);
                    }
                    Err(error) => failures.push(format!("{}：{error}", display_path(&root))),
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("；"))
        }
    }

    fn start(&self) -> notify::Result<RecommendedWatcher> {
        let (wake, batches) = mpsc::sync_channel(1);
        // None represents a rescan after a watcher error or a large burst.
        let pending = Arc::new(Mutex::new(Some(HashSet::new())));
        let changes = pending.clone();
        let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            let mut changes = changes.lock().unwrap();
            let Some(paths) = changes.as_mut() else {
                return;
            };
            match result {
                Ok(event) if !event.need_rescan() => {
                    if event
                        .paths
                        .iter()
                        .any(|path| path.file_name().is_some_and(|name| name == ".gitignore"))
                        && !event.kind.is_access()
                    {
                        *changes = None;
                    } else if matches!(
                        event.kind,
                        EventKind::Any
                            | EventKind::Create(_)
                            | EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(_))
                    ) {
                        paths.extend(
                            event
                                .paths
                                .iter()
                                .filter_map(|path| path.parent())
                                .map(display_path),
                        );
                        if paths.len() > 512 {
                            *changes = None;
                        }
                    } else {
                        return;
                    }
                }
                _ => *changes = None,
            }
            let _ = wake.try_send(());
        })?;
        let app = self.app.clone();
        let label = self.label.clone();
        std::thread::spawn(move || {
            while batches.recv().is_ok() {
                std::thread::sleep(Duration::from_millis(120));
                let batch = std::mem::replace(&mut *pending.lock().unwrap(), Some(HashSet::new()));
                if batch.as_ref().is_none_or(|paths| !paths.is_empty()) {
                    let _ = app.emit_to(&label, "workspace-tree-change", batch);
                }
            }
        });
        Ok(watcher)
    }
}
