//! A single native watcher, shared parent-directory subscriptions, and a bounded
//! hint queue. Hints never authorize a path or stand in for a verified read.
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::{collections::{HashMap, HashSet}, path::PathBuf, sync::{mpsc, Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tauri::{AppHandle, Emitter};
use super::{FileError, Result};

#[derive(Clone, Serialize)]
pub struct Hint { pub generation: u64, pub tokens: Vec<String>, pub error: Option<String> }
#[derive(Default)]
struct Targets { owners: HashMap<String, (u64, HashMap<String, PathBuf>)> }
#[derive(Debug, Serialize)]
#[serde(rename_all="camelCase")]
pub struct WatchStatus { pub watcher_count: usize, pub directory_count: usize, pub file_count: usize }

// Both normal and deadline-boundary events obey the same filtering and budget.
// In particular, a late access event must not start another hash/read cycle.
fn collect_event(event: notify::Result<notify::Event>, paths: &mut HashSet<PathBuf>, error: &mut Option<String>) -> bool {
    match event {
        Ok(event) if !matches!(event.kind, notify::EventKind::Access(_)) => {
            let mut overflow = false;
            for path in event.paths {
                if paths.len() < 4096 || paths.contains(&path) { paths.insert(path); }
                else { overflow = true; }
            }
            overflow
        }
        Ok(_) => false,
        Err(e) => { *error = Some(format!("实时监测发生错误，已改用窗口焦点检查：{e}")); false }
    }
}

pub struct ExternalWatcher {
    watcher: Option<RecommendedWatcher>,
    targets: Arc<Mutex<Targets>>,
    directories: HashSet<PathBuf>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl ExternalWatcher {
    pub fn new(app: AppHandle) -> Result<Self> {
        Self::with_sink(move |owner, hint| { let _ = app.emit_to(owner, "external-file-change", hint); })
    }
    fn with_sink(sink: impl Fn(&str, Hint) + Send + 'static) -> Result<Self> {
        let targets = Arc::new(Mutex::new(Targets::default()));
        let observed = targets.clone();
        let (tx, rx) = mpsc::sync_channel(256);
        let overflow = Arc::new(AtomicBool::new(false));
        let full = overflow.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            // Do not let read-only activity fill the bounded channel and turn
            // its overflow fallback into another full-document check cycle.
            if event.as_ref().is_ok_and(|event| matches!(event.kind, notify::EventKind::Access(_))) { return; }
            if tx.try_send(event).is_err() { full.store(true, Ordering::Release); }
        }).map_err(|e| FileError::new("watch", &e.to_string()))?;
        let worker = std::thread::spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut paths = HashSet::new();
                let mut error = None;
                let deadline = Instant::now() + Duration::from_millis(180);
                let mut next = Some(first);
                loop {
                    if let Some(event) = next.take() {
                        if collect_event(event, &mut paths, &mut error) { overflow.store(true, Ordering::Release); }
                    }
                    match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                        Ok(event) if Instant::now() < deadline => next = Some(event),
                        Ok(event) => { // Preserve the boundary event rather than dropping it.
                            if collect_event(event, &mut paths, &mut error) { overflow.store(true, Ordering::Release); }
                            break;
                        }
                        Err(_) => break,
                    }
                }
                let all = overflow.swap(false, Ordering::AcqRel) || error.is_some();
                let deliveries: Vec<_> = observed.lock().unwrap().owners.iter().map(|(owner,(generation, files))| {
                    let tokens = files.iter().filter(|(_,p)| all || paths.iter().any(|changed| changed == *p || p.starts_with(changed)))
                        .map(|(token,_)| token.clone()).collect::<Vec<_>>();
                    (owner.clone(), Hint { generation: *generation, tokens, error: error.clone() })
                }).collect();
                for (owner, hint) in deliveries { if !hint.tokens.is_empty() || hint.error.is_some() { sink(&owner, hint); } }
            }
        });
        Ok(Self { watcher: Some(watcher), targets, directories: HashSet::new(), worker: Some(worker) })
    }
    pub fn set(&mut self, owner: &str, generation: u64, files: HashMap<String, PathBuf>) -> Result<WatchStatus> {
        self.targets.lock().unwrap().owners.insert(owner.into(), (generation, files));
        self.reconcile()?;
        let targets = self.targets.lock().unwrap();
        Ok(WatchStatus { watcher_count: usize::from(!self.directories.is_empty()), directory_count: self.directories.len(), file_count: targets.owners.values().map(|(_,f)|f.len()).sum() })
    }
    pub fn release(&mut self, owner: &str, token: Option<&str>) {
        {
            let mut targets = self.targets.lock().unwrap();
            if let Some(token) = token { if let Some((_,files)) = targets.owners.get_mut(owner) { files.remove(token); } }
            else { targets.owners.remove(owner); }
        }
        let _ = self.reconcile();
    }
    fn reconcile(&mut self) -> Result<()> {
        let wanted: HashSet<_> = self.targets.lock().unwrap().owners.values().flat_map(|(_,f)| f.values()).filter_map(|p|p.parent().map(PathBuf::from)).collect();
        let watcher = self.watcher.as_mut().unwrap();
        for path in self.directories.difference(&wanted) { let _ = watcher.unwatch(path); }
        self.directories.retain(|p|wanted.contains(p));
        for path in wanted.difference(&self.directories).cloned().collect::<Vec<_>>() {
            watcher.watch(&path, RecursiveMode::NonRecursive).map_err(|e| FileError::new("watch", &format!("实时监测不可用，将在窗口获得焦点时检查：{e}")))?;
            self.directories.insert(path);
        }
        Ok(())
    }
}
impl Drop for ExternalWatcher {
    fn drop(&mut self) { self.watcher.take(); if let Some(worker) = self.worker.take() { let _ = worker.join(); } }
}
