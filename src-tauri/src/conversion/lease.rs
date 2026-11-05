use super::{Result, TIMEOUT};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

pub const LEASE_TTL: Duration = Duration::from_secs(600);
pub const MAX_LEASES: usize = 8;
pub const MAX_PARALLEL: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Html,
    Png,
    Pdf,
    Docx,
    Markdown,
    ReadHtml,
    ReadDocx,
}
impl Purpose {
    pub fn write(format: &str) -> Result<Self> {
        match format {
            "html" | "html-plain" => Ok(Self::Html),
            "png" => Ok(Self::Png),
            "pdf" => Ok(Self::Pdf),
            "docx" => Ok(Self::Docx),
            "markdown" => Ok(Self::Markdown),
            _ => Err("不支持的导出格式".into()),
        }
    }
    pub fn read(format: &str) -> Result<Self> {
        match format {
            "html" => Ok(Self::ReadHtml),
            "docx" => Ok(Self::ReadDocx),
            _ => Err("不支持的导入格式".into()),
        }
    }
    fn is_read(self) -> bool {
        matches!(self, Self::ReadHtml | Self::ReadDocx)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub token: String,
    pub path: String,
}

#[derive(Default)]
pub struct Owner {
    pub(crate) alive: AtomicBool,
    dialog: AtomicBool,
    // No global lock during commits, conversion or a dialog.
    pub(crate) commit: Mutex<()>,
}
#[derive(Clone)]
pub(crate) struct Lease {
    pub owner: Arc<Owner>,
    pub path: PathBuf,
    pub expected: Option<String>,
    pub purpose: Purpose,
    pub expires: Instant,
    pub cancelled: Arc<AtomicBool>,
    used: bool,
}
struct PreparedDocument {
    source: Lease,
    document: super::docx::ast::NativeDocument,
}
#[derive(serde::Serialize)]
pub struct PreparedImport {
    pub token: String,
    pub path: String,
    pub warnings: Vec<super::docx::ast::Warning>,
    pub stats: super::docx::ast::Stats,
}
#[derive(Default)]
struct Registry {
    owners: HashMap<String, Arc<Owner>>,
    leases: HashMap<String, Lease>,
    prepared: HashMap<String, PreparedDocument>,
    active: HashMap<String, usize>,
    targets: std::collections::HashSet<crate::session::PathKey>,
}
#[derive(Default, Clone)]
pub struct ConversionStore(Arc<Mutex<Registry>>);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
pub fn random_id() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|e| format!("生成授权失败: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub struct DialogPermit {
    owner: Arc<Owner>,
}
impl Drop for DialogPermit {
    fn drop(&mut self) {
        self.owner.dialog.store(false, Ordering::Release);
    }
}
impl ConversionStore {
    pub fn register(&self, label: &str) {
        lock(&self.0).owners.entry(label.into()).or_insert_with(|| {
            Arc::new(Owner {
                alive: AtomicBool::new(true),
                ..Owner::default()
            })
        });
    }
    pub fn close(&self, label: &str) {
        let owner = lock(&self.0).owners.get(label).cloned();
        if let Some(owner) = owner {
            owner.alive.store(false, Ordering::Release);
            let _commit = lock(&owner.commit);
            let mut r = lock(&self.0);
            r.owners.remove(label);
            r.prepared
                .retain(|_, draft| !Arc::ptr_eq(&draft.source.owner, &owner));
            r.leases.retain(|_, l| {
                if Arc::ptr_eq(&l.owner, &owner) {
                    l.cancelled.store(true, Ordering::Release);
                    false
                } else {
                    true
                }
            });
        }
    }
    pub fn dialog(&self, label: &str) -> Result<DialogPermit> {
        let owner = lock(&self.0)
            .owners
            .get(label)
            .cloned()
            .ok_or("窗口转换授权已关闭")?;
        if !owner.alive.load(Ordering::Acquire) || owner.dialog.swap(true, Ordering::AcqRel) {
            return Err("此窗口已有文件选择对话框或已关闭".into());
        }
        Ok(DialogPermit { owner })
    }
    /// Only native dialog adapters call this. No IPC accepts a path to mint a lease.
    pub fn selected(
        &self,
        permit: &DialogPermit,
        path: Option<PathBuf>,
        purpose: Purpose,
    ) -> Result<Option<Selection>> {
        let Some(path) = path else { return Ok(None) };
        let path =
            crate::files::checked_path(&path, !purpose.is_read()).map_err(|e| e.to_string())?;
        // Freeze the actual directory spelling, reject subsequent ancestor links.
        let path =
            crate::workspace::guard::validate_under_root(path.parent().ok_or("缺少父目录")?, &path)
                .map_err(|e| e.to_string())?;
        let expected = crate::files::disk_version(&path).map_err(|e| e.to_string())?;
        let _commit = lock(&permit.owner.commit);
        if !permit.owner.alive.load(Ordering::Acquire) {
            return Err("选择文件期间窗口已关闭".into());
        }
        let mut r = lock(&self.0);
        r.leases.retain(|_, l| {
            let keep = l.expires > Instant::now() && !l.cancelled.load(Ordering::Acquire);
            if !keep {
                l.cancelled.store(true, Ordering::Release)
            }
            keep
        });
        if r.leases
            .values()
            .filter(|l| Arc::ptr_eq(&l.owner, &permit.owner))
            .count()
            >= MAX_LEASES
        {
            return Err("此窗口转换授权已达 8 个，请取消后重试".into());
        }
        let token = random_id()?;
        let display = path.to_string_lossy().into_owned();
        r.leases.insert(
            token.clone(),
            Lease {
                owner: permit.owner.clone(),
                path,
                expected,
                purpose,
                expires: Instant::now() + LEASE_TTL,
                cancelled: Arc::new(AtomicBool::new(false)),
                used: false,
            },
        );
        Ok(Some(Selection {
            token,
            path: display,
        }))
    }
    pub fn begin_import(
        &self,
        label: &str,
        draft_token: &str,
        target_token: &str,
    ) -> Result<(Operation, super::docx::ast::NativeDocument)> {
        let draft = {
            let mut registry = lock(&self.0);
            let owner = registry.owners.get(label).ok_or("窗口已关闭")?;
            let draft = registry
                .prepared
                .get(draft_token)
                .ok_or("导入预解析已释放或过期，请重新选择 Word")?;
            if !Arc::ptr_eq(owner, &draft.source.owner) || draft.source.expires <= Instant::now() {
                return Err("导入预解析不属于此窗口或已过期".into());
            }
            registry.prepared.remove(draft_token).unwrap()
        };
        let mut operation = self.begin(label, &[(target_token, Purpose::Markdown)])?;
        operation.leases.insert(0, draft.source);
        Ok((operation, draft.document))
    }
    pub fn release(&self, label: &str, token: &str) {
        {
            let mut r = lock(&self.0);
            if r.prepared.get(token).is_some_and(|d| {
                r.owners
                    .get(label)
                    .is_some_and(|o| Arc::ptr_eq(o, &d.source.owner))
            }) {
                r.prepared.remove(token);
            }
        }
        let lease = {
            let r = lock(&self.0);
            r.leases
                .get(token)
                .filter(|l| {
                    r.owners
                        .get(label)
                        .is_some_and(|o| Arc::ptr_eq(o, &l.owner))
                })
                .cloned()
        };
        if let Some(lease) = lease {
            lease.cancelled.store(true, Ordering::Release);
            let _commit = lock(&lease.owner.commit);
            lock(&self.0).leases.remove(token);
        }
    }
    pub fn begin(&self, label: &str, requests: &[(&str, Purpose)]) -> Result<Operation> {
        let mut r = lock(&self.0);
        let owner = r.owners.get(label).cloned().ok_or("窗口已关闭")?;
        if !owner.alive.load(Ordering::Acquire) {
            return Err("窗口已关闭".into());
        }
        if r.active.values().sum::<usize>() >= MAX_PARALLEL
            || r.active.get(label).copied().unwrap_or(0) > 0
        {
            return Err("转换繁忙（每窗口 1 个、全局 2 个），请稍后重试".into());
        }
        let mut leases = Vec::new();
        for (token, purpose) in requests {
            let l = r.leases.get(*token).ok_or("无效或已释放的转换授权")?;
            if !Arc::ptr_eq(&l.owner, &owner)
                || l.purpose != *purpose
                || l.used
                || l.cancelled.load(Ordering::Acquire)
                || l.expires <= Instant::now()
            {
                return Err("转换授权不属于此窗口/格式、已使用或已过期".into());
            }
            leases.push(l.clone());
        }
        let targets: Vec<_> = leases
            .iter()
            .filter(|l| !l.purpose.is_read())
            .map(|l| crate::session::PathKey::of(&l.path))
            .collect();
        if targets.iter().any(|p| r.targets.contains(p)) {
            return Err("该目标已有转换正在提交，请稍后重新选择".into());
        }
        for (token, _) in requests {
            r.leases.get_mut(*token).unwrap().used = true;
        }
        r.active.insert(label.into(), 1);
        r.targets.extend(targets);
        Ok(Operation {
            store: self.clone(),
            label: label.into(),
            owner,
            tokens: requests.iter().map(|(t, _)| (*t).into()).collect(),
            leases,
            deadline: Instant::now() + TIMEOUT,
        })
    }
}

pub struct Operation {
    store: ConversionStore,
    label: String,
    owner: Arc<Owner>,
    tokens: Vec<String>,
    pub(crate) leases: Vec<Lease>,
    pub(crate) deadline: Instant,
}
impl Operation {
    pub fn stage_import(
        &self,
        document: super::docx::ast::NativeDocument,
    ) -> Result<PreparedImport> {
        self.verify(0)?;
        let token = random_id()?;
        let reply = PreparedImport {
            token: token.clone(),
            path: self.path(0).to_string_lossy().into_owned(),
            warnings: document.warnings.clone(),
            stats: document.stats.clone(),
        };
        let mut r = lock(&self.store.0);
        r.prepared.retain(|_, d| {
            d.source.expires > Instant::now()
                && d.source.owner.alive.load(Ordering::Acquire)
                && !d.source.cancelled.load(Ordering::Acquire)
        });
        if r.prepared.len() >= MAX_PARALLEL {
            return Err("预解析缓存已达上限，请取消其他导入后重试".into());
        }
        self.check()?;
        r.prepared.insert(
            token,
            PreparedDocument {
                source: self.leases[0].clone(),
                document,
            },
        );
        Ok(reply)
    }
    pub fn check(&self) -> Result<()> {
        if Instant::now() >= self.deadline {
            return Err("转换超时（90 秒）".into());
        }
        if !self.owner.alive.load(Ordering::Acquire)
            || self
                .leases
                .iter()
                .any(|l| l.expires <= Instant::now() || l.cancelled.load(Ordering::Acquire))
        {
            return Err("转换已取消、窗口已关闭或授权已过期".into());
        }
        Ok(())
    }
    pub(crate) fn path(&self, index: usize) -> &Path {
        &self.leases[index].path
    }
    pub(crate) fn verify(&self, index: usize) -> Result<()> {
        self.check()?;
        let l = &self.leases[index];
        let actual = crate::workspace::guard::validate_under_root(
            l.path.parent().ok_or("无效授权路径")?,
            &l.path,
        )
        .map_err(|e| e.to_string())?;
        if actual != l.path
            || crate::files::checked_path(&l.path, !l.purpose.is_read())
                .map_err(|e| e.to_string())?
                != l.path
            || crate::files::disk_version(&l.path).map_err(|e| e.to_string())? != l.expected
        {
            return Err("目标或来源已被外部修改，已阻止转换；请重新选择".into());
        }
        Ok(())
    }
    pub(crate) fn commit(&self, index: usize, bytes: &[u8]) -> Result<()> {
        if bytes.len() > super::MAX_OUTPUT {
            return Err("转换输出超过 16 MiB".into());
        }
        let _commit = lock(&self.owner.commit);
        self.verify(index)?;
        crate::files::atomic::write_conversion_checked(
            self.path(index),
            bytes,
            self.leases[index].expected.as_deref(),
            || {
                self.verify(index)
                    .map_err(|e| crate::files::FileError::new("conversion", &e))
            },
        )
        .map_err(|e| e.to_string())
    }
}
impl Drop for Operation {
    fn drop(&mut self) {
        let mut r = lock(&self.store.0);
        for token in &self.tokens {
            r.leases.remove(token);
        }
        for lease in &self.leases {
            if !lease.purpose.is_read() {
                r.targets.remove(&crate::session::PathKey::of(&lease.path));
            }
        }
        r.active.remove(&self.label);
    }
}

#[cfg(test)]
mod native_import_tests {
    use super::*;
    use crate::conversion::{commit_import, docx::ast::*};
    fn document() -> NativeDocument {
        NativeDocument {
            blocks: vec![Block::Paragraph(vec![
                Inline::Text("中文 😀".into(), Format::default()),
                Inline::Image {
                    asset: "image-1.png".into(),
                    alt: "image".into(),
                    width: Some(100),
                    height: Some(40),
                },
            ])],
            footnotes: vec![],
            assets: vec![("image-1.png".into(), vec![1, 2, 3])],
            warnings: vec![],
            stats: Stats::default(),
        }
    }
    fn selection(store: &ConversionStore, owner: &str, path: &Path, purpose: Purpose) -> Selection {
        let permit = store.dialog(owner).unwrap();
        store
            .selected(&permit, Some(path.into()), purpose)
            .unwrap()
            .unwrap()
    }
    fn draft(store: &ConversionStore, owner: &str, source: &Path) -> PreparedImport {
        let selected = selection(store, owner, source, Purpose::ReadDocx);
        let op = store
            .begin(owner, &[(&selected.token, Purpose::ReadDocx)])
            .unwrap();
        op.stage_import(document()).unwrap()
    }
    #[test]
    fn prepared_import_is_window_bound_single_use_and_closes() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("input.docx");
        std::fs::write(&source, "original").unwrap();
        let target = dir.path().join("output.md");
        let store = ConversionStore::default();
        store.register("a");
        store.register("b");
        let prepared = draft(&store, "a", &source);
        let selected = selection(&store, "a", &target, Purpose::Markdown);
        store.release("b", &prepared.token);
        assert!(store
            .begin_import("b", &prepared.token, &selected.token)
            .is_err());
        let (op, doc) = store
            .begin_import("a", &prepared.token, &selected.token)
            .unwrap();
        assert!(store
            .begin_import("a", &prepared.token, &selected.token)
            .is_err());
        commit_import(&op, doc).unwrap();
        drop(op);
        let output = std::fs::read_to_string(&target).unwrap();
        assert!(output.contains("中文 😀"));
        let base = dir.path().join("output.assets");
        let batches = std::fs::read_dir(&base).unwrap().collect::<Vec<_>>();
        assert_eq!(batches.len(), 1);
        assert_eq!(
            std::fs::read(batches[0].as_ref().unwrap().path().join("image-1.png")).unwrap(),
            vec![1, 2, 3]
        );
        let prepared = draft(&store, "a", &source);
        store.close("a");
        assert!(!lock(&store.0).prepared.contains_key(&prepared.token));
        store.register("a");
        let next = selection(&store, "a", &target, Purpose::Markdown);
        assert!(store
            .begin_import("a", &prepared.token, &next.token)
            .is_err());
    }
    #[test]
    fn cancellation_source_and_target_conflicts_preserve_existing_files() {
        for mode in ["cancel", "source", "target"] {
            let dir = tempfile::tempdir().unwrap();
            let source = dir.path().join("input.docx");
            let target = dir.path().join("output.md");
            std::fs::write(&source, "original").unwrap();
            std::fs::write(&target, "old target").unwrap();
            let existing = dir.path().join("output.assets");
            std::fs::create_dir(&existing).unwrap();
            std::fs::write(existing.join("user.png"), "user image").unwrap();
            let store = ConversionStore::default();
            store.register("a");
            let prepared = draft(&store, "a", &source);
            let selected = selection(&store, "a", &target, Purpose::Markdown);
            let (op, doc) = store
                .begin_import("a", &prepared.token, &selected.token)
                .unwrap();
            match mode {
                "cancel" => store.release("a", &selected.token),
                "source" => std::fs::write(&source, "changed source").unwrap(),
                _ => std::fs::write(&target, "changed target").unwrap(),
            };
            assert!(commit_import(&op, doc).is_err());
            assert_eq!(
                std::fs::read_to_string(&target).unwrap(),
                if mode == "target" {
                    "changed target"
                } else {
                    "old target"
                }
            );
            assert_eq!(
                std::fs::read_to_string(existing.join("user.png")).unwrap(),
                "user image"
            );
            assert_eq!(std::fs::read_dir(existing).unwrap().count(), 1);
        }
    }
    #[test]
    fn partial_asset_failure_rolls_back_own_batch_only() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("input.docx");
        let target = dir.path().join("output.md");
        std::fs::write(&source, "source").unwrap();
        std::fs::write(&target, "keep").unwrap();
        let store = ConversionStore::default();
        store.register("a");
        let prepared = draft(&store, "a", &source);
        let selected = selection(&store, "a", &target, Purpose::Markdown);
        let (op, mut doc) = store
            .begin_import("a", &prepared.token, &selected.token)
            .unwrap();
        doc.assets.push(("../unsafe".into(), vec![0]));
        assert!(commit_import(&op, doc).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        assert!(!dir.path().join("output.assets").exists());
    }
    #[test]
    fn repeated_import_has_independent_assets_and_expired_drafts_fail() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("input.docx");
        let target = dir.path().join("output.md");
        std::fs::write(&source, "source").unwrap();
        let store = ConversionStore::default();
        store.register("a");
        for _ in 0..2 {
            let prepared = draft(&store, "a", &source);
            let selected = selection(&store, "a", &target, Purpose::Markdown);
            let (op, doc) = store
                .begin_import("a", &prepared.token, &selected.token)
                .unwrap();
            commit_import(&op, doc).unwrap();
        }
        assert_eq!(
            std::fs::read_dir(dir.path().join("output.assets"))
                .unwrap()
                .count(),
            2
        );
        let prepared = draft(&store, "a", &source);
        lock(&store.0)
            .prepared
            .get_mut(&prepared.token)
            .unwrap()
            .source
            .expires = Instant::now() - Duration::from_secs(1);
        let selected = selection(&store, "a", &target, Purpose::Markdown);
        assert!(store
            .begin_import("a", &prepared.token, &selected.token)
            .is_err());
    }
}
