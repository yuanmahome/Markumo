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
#[derive(Default)]
struct Registry {
    owners: HashMap<String, Arc<Owner>>,
    leases: HashMap<String, Lease>,
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
    pub fn release(&self, label: &str, token: &str) {
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
