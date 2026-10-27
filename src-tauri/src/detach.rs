//! Detaching a tab into a new native window.
//!
//! Moving a document between windows is a two-phase handoff:
//!
//! 1. `begin` reserves a window label and stores the document payload (Prepare).
//! 2. the new window pulls the payload exactly once via `adopt` (Adopt).
//! 3. `commit` drops the reservation after the target confirmed it (Commit).
//!
//! Every failure path leaves the source window's document untouched: nothing is
//! removed from the source until the target window has adopted the payload and
//! the frontend reports the tab as committed. Reservations expire so a crashed
//! or closed target cannot leak a document or a window label forever.

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

/// Concurrent pending handoffs. Each one holds one document body in memory.
pub const MAX_HANDOFFS: usize = 4;
/// A handoff that is never adopted (target window closed, crash) is dropped.
pub const HANDOFF_TTL: Duration = Duration::from_secs(120);
/// Largest document body that may be carried through a handoff.
pub const MAX_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetachPayload {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub media: Option<serde_json::Value>,
    #[serde(default)]
    pub class_info: Option<serde_json::Value>,
    #[serde(default)]
    pub media_view: Option<serde_json::Value>,
    pub document_id: String,
    pub name: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub file_token: Option<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default = "default_encoding")]
    pub encoding: String,
    #[serde(default)]
    pub bom: bool,
    #[serde(default = "default_eol")]
    pub eol: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub dirty: bool,
    #[serde(default)]
    pub markdown_mode: Option<String>,
    #[serde(default)]
    pub anchor: i64,
    #[serde(default)]
    pub head: i64,
    #[serde(default)]
    pub scroll_top: f64,
    #[serde(default)]
    pub scroll_left: f64,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub external: Option<String>,
}

fn default_encoding() -> String {
    "UTF-8".into()
}
fn default_eol() -> String {
    "LF".into()
}

impl DetachPayload {
    /// Rejects payloads the target could never restore faithfully.
    pub fn validate(&self) -> Result<(), String> {
        if self
            .kind
            .as_deref()
            .is_some_and(|kind| !matches!(kind, "text" | "javaClass" | "image" | "pdf"))
        {
            return Err("不支持的移交文档类型".into());
        }
        for metadata in [&self.media, &self.class_info, &self.media_view]
            .into_iter()
            .flatten()
        {
            if metadata.to_string().len() > 256 * 1024 {
                return Err("移交元数据超过预算".into());
            }
        }
        if self.document_id.trim().is_empty() {
            return Err("移交的文档缺少标识".into());
        }
        if self.name.trim().is_empty() {
            return Err("移交的文档缺少文件名".into());
        }
        if self.text.len() > MAX_PAYLOAD_BYTES {
            return Err("移交的文档超过 32 MiB，无法移动到新窗口".into());
        }
        if !matches!(
            self.encoding.as_str(),
            "" | "UTF-8"
                | "UTF-8 BOM"
                | "GBK"
                | "GB18030"
                | "Big5"
                | "UTF-16LE"
                | "UTF-16BE"
                | "Shift_JIS"
                | "EUC-KR"
                | "windows-1252"
                | "ISO-8859-1"
                | "Hex"
                | "Binary"
        ) {
            return Err("移交的文档编码不受支持".into());
        }
        if !matches!(self.eol.as_str(), "" | "LF" | "CRLF" | "CR" | "Mixed") {
            return Err("移交的文档换行格式不受支持".into());
        }
        if let Some(mode) = &self.markdown_mode {
            if !matches!(mode.as_str(), "source" | "live" | "split") {
                return Err("移交的 Markdown 模式不受支持".into());
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
pub struct Handoff {
    pub id: String,
    pub label: String,
    pub source: String,
    pub payload: DetachPayload,
    pub created: Instant,
    /// Set once the target window took the body. Kept until `commit` so the
    /// source only drops its tab after the target confirmed.
    pub adopted: bool,
}

#[derive(Debug, Default)]
pub struct DetachRegistry {
    pub handoffs: Vec<Handoff>,
    pub seq: u64,
    completed: Vec<(String, String, String, Instant)>,
}

impl DetachRegistry {
    fn purge(&mut self, now: Instant) {
        self.completed
            .retain(|(_, _, _, created)| now.duration_since(*created) < HANDOFF_TTL);
        self.handoffs
            .retain(|handoff| handoff.adopted || now.duration_since(handoff.created) < HANDOFF_TTL);
    }

    /// Prepare: reserve a fresh window label and park the payload.
    ///
    /// `window_exists` is consulted so a label is never reused while a live
    /// window still owns it (a closed window frees its label).
    pub fn begin(
        &mut self,
        source: &str,
        payload: DetachPayload,
        now: Instant,
        window_count: usize,
        max_windows: usize,
        window_exists: &dyn Fn(&str) -> bool,
    ) -> Result<String, String> {
        payload.validate()?;
        self.purge(now);
        if window_count >= max_windows {
            return Err(format!(
                "最多同时打开 {max_windows} 个窗口，请先关闭其他窗口再移动标签。"
            ));
        }
        if self.handoffs.len() >= MAX_HANDOFFS {
            return Err("待接收的窗口过多，请稍后再试。".into());
        }
        // A document can only travel once: a second drag of the same document
        // must not race the first handoff.
        if self
            .handoffs
            .iter()
            .any(|handoff| handoff.payload.document_id == payload.document_id)
        {
            return Err("该文档正在移动到另一个窗口".into());
        }
        let mut label;
        loop {
            self.seq += 1;
            label = format!("detached-{}", self.seq);
            if !window_exists(&label) && !self.handoffs.iter().any(|h| h.label == label) {
                break;
            }
        }
        let id = format!("handoff-{}", self.seq);
        self.handoffs.push(Handoff {
            id: id.clone(),
            label: label.clone(),
            source: source.into(),
            payload,
            created: now,
            adopted: false,
        });
        Ok(label)
    }

    pub fn begin_for_target(
        &mut self,
        source: &str,
        target: &str,
        payload: DetachPayload,
        now: Instant,
    ) -> Result<String, String> {
        payload.validate()?;
        self.purge(now);
        if self.handoffs.len() >= MAX_HANDOFFS {
            return Err("待接收的窗口过多，请稍后再试。".into());
        }
        if self
            .handoffs
            .iter()
            .any(|handoff| handoff.payload.document_id == payload.document_id)
        {
            return Err("该文档正在移动到另一个窗口".into());
        }
        self.seq += 1;
        let id = format!("handoff-{}", self.seq);
        self.handoffs.push(Handoff {
            id: id.clone(),
            label: target.into(),
            source: source.into(),
            payload,
            created: now,
            adopted: false,
        });
        Ok(id)
    }

    pub fn payload_for_label(&self, label: &str) -> Option<&DetachPayload> {
        self.handoffs
            .iter()
            .find(|handoff| handoff.label == label)
            .map(|handoff| &handoff.payload)
    }

    pub fn id_for_label(&self, label: &str) -> Option<String> {
        self.handoffs
            .iter()
            .find(|handoff| handoff.label == label)
            .map(|handoff| handoff.id.clone())
    }

    /// Adopt: the target window takes the body. Exactly once per handoff.
    pub fn adopt(&mut self, label: &str) -> Result<DetachPayload, String> {
        let id = self.id_for_label(label).ok_or("没有等待接收的文档")?;
        self.adopt_id(&id, label)
    }
    pub fn adopt_id(&mut self, id: &str, label: &str) -> Result<DetachPayload, String> {
        let handoff = self
            .handoffs
            .iter_mut()
            .find(|handoff| handoff.label == label && handoff.id == id)
            .ok_or("没有等待接收的文档")?;
        // A reload of the target window must not adopt the same body twice: the
        // document already lives in that window at this point.
        if handoff.adopted {
            return Err("该文档已被接收".into());
        }
        handoff.adopted = true;
        Ok(handoff.payload.clone())
    }

    /// Source label and document id for a committed handoff, if it still exists.
    pub fn handoff_source(&self, id: &str) -> Option<(String, String)> {
        self.handoffs
            .iter()
            .find(|handoff| handoff.id == id)
            .map(|handoff| (handoff.source.clone(), handoff.payload.document_id.clone()))
    }

    /// Commit: the source may now drop its tab. Returns `(source, documentId)`.
    pub fn commit(&mut self, id: &str) -> Option<(String, String)> {
        let index = self
            .handoffs
            .iter()
            .position(|handoff| handoff.id == id && handoff.adopted)?;
        let handoff = self.handoffs.remove(index);
        self.completed.push((
            handoff.id.clone(),
            handoff.source.clone(),
            handoff.label.clone(),
            Instant::now(),
        ));
        if self.completed.len() > 64 {
            self.completed.remove(0);
        }
        Some((handoff.source, handoff.payload.document_id))
    }

    /// Rollback: forget a handoff without touching any document.
    pub fn rollback(&mut self, id: &str) {
        self.handoffs.retain(|handoff| handoff.id != id);
    }
    pub fn status(&mut self, id: &str, source: &str) -> &'static str {
        self.purge(Instant::now());
        if self.completed.iter().any(|(completed, owner, target, _)| {
            completed == id && (owner == source || target == source)
        }) {
            "committed"
        } else if self
            .handoffs
            .iter()
            .any(|h| h.id == id && h.source == source)
        {
            "pending"
        } else {
            "canceled"
        }
    }

    /// Drop every handoff that references a window that is gone.
    pub fn forget_window(&mut self, label: &str) {
        self.completed.retain(|(_, source, _, _)| source != label);
        self.handoffs
            .retain(|handoff| handoff.label != label && handoff.source != label);
    }

    pub fn is_empty(&self) -> bool {
        self.handoffs.is_empty()
    }
}

/// One monitor work area in the same coordinate space as the request.
#[derive(Clone, Copy, Debug)]
pub struct WorkArea {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl WorkArea {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
    fn distance(&self, x: f64, y: f64) -> f64 {
        let cx = x.clamp(self.x, self.x + self.width);
        let cy = y.clamp(self.y, self.y + self.height);
        (cx - x).powi(2) + (cy - y).powi(2)
    }
}

/// Window title bar must stay reachable, so a detached window is allowed to hang
/// off the right/bottom edge but never off the top/left of its monitor.
pub const MIN_VISIBLE_WINDOW: f64 = 120.0;

/// Chooses a visible top-left corner for a detached window.
///
/// The drop point is in the same space as `areas`; the returned position keeps
/// the whole title bar on screen and prefers the monitor the user dropped on.
pub fn clamp_window_origin(
    drop_x: f64,
    drop_y: f64,
    width: f64,
    height: f64,
    areas: &[WorkArea],
) -> (f64, f64) {
    let width = width.max(MIN_VISIBLE_WINDOW);
    let height = height.max(MIN_VISIBLE_WINDOW);
    let area = areas
        .iter()
        .find(|area| area.contains(drop_x, drop_y))
        .or_else(|| {
            areas.iter().min_by(|a, b| {
                a.distance(drop_x, drop_y)
                    .partial_cmp(&b.distance(drop_x, drop_y))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        });
    let Some(area) = area else {
        // No monitor information: trust the caller but never go negative.
        return (drop_x.max(0.0), drop_y.max(0.0));
    };
    let max_x = area.x + area.width - width;
    let max_y = area.y + area.height - height;
    let x = if max_x >= area.x {
        drop_x.clamp(area.x, max_x)
    } else {
        area.x
    };
    let y = if max_y >= area.y {
        drop_y.clamp(area.y, max_y)
    } else {
        area.y
    };
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn body(id: &str) -> DetachPayload {
        DetachPayload {
            document_id: id.into(),
            name: "文件.md".into(),
            text: "未保存\r\n正文\n".into(),
            eol: "Mixed".into(),
            ..Default::default()
        }
    }
    #[test]
    fn no_commit_before_adoption_and_exact_target() {
        let mut registry = DetachRegistry::default();
        let id = registry
            .begin_for_target("source", "target", body("a"), Instant::now())
            .unwrap();
        assert!(registry.commit(&id).is_none());
        assert!(registry.adopt_id(&id, "other").is_err());
        assert_eq!(
            registry.adopt_id(&id, "target").unwrap().text,
            "未保存\r\n正文\n"
        );
        assert!(registry.adopt_id(&id, "target").is_err());
        assert_eq!(registry.commit(&id), Some(("source".into(), "a".into())));
        assert_eq!(registry.status(&id, "source"), "committed");
        assert_eq!(registry.status(&id, "target"), "committed");
        assert_eq!(registry.status(&id, "other"), "canceled");
        assert!(registry.handoffs.is_empty());
    }
    #[test]
    fn multiple_target_adoptions_are_keyed_by_id() {
        let mut registry = DetachRegistry::default();
        let a = registry
            .begin_for_target("source", "target", body("a"), Instant::now())
            .unwrap();
        let b = registry
            .begin_for_target("source", "target", body("b"), Instant::now())
            .unwrap();
        assert_eq!(registry.adopt_id(&b, "target").unwrap().document_id, "b");
        assert_eq!(registry.adopt_id(&a, "target").unwrap().document_id, "a");
        registry.rollback(&a);
        assert_eq!(registry.status(&a, "source"), "canceled");
        assert_eq!(registry.handoffs.len(), 1);
    }
    #[test]
    fn bounded_receipts_and_closed_window_cleanup() {
        let mut registry = DetachRegistry::default();
        for n in 0..100 {
            let id = registry
                .begin_for_target("source", "target", body(&n.to_string()), Instant::now())
                .unwrap();
            registry.adopt_id(&id, "target").unwrap();
            registry.commit(&id).unwrap();
        }
        assert!(registry.completed.len() <= 64);
        registry.forget_window("source");
        assert!(registry.completed.is_empty());
        assert!(registry.is_empty());
    }
    #[test]
    fn pending_body_budget_and_expiry_keep_source_safe() {
        let mut registry = DetachRegistry::default();
        let now = Instant::now();
        let old = registry
            .begin_for_target(
                "a",
                "b",
                body("a"),
                now - HANDOFF_TTL - Duration::from_secs(1),
            )
            .unwrap();
        let new = registry.begin_for_target("a", "b", body("b"), now).unwrap();
        assert_eq!(registry.status(&old, "a"), "canceled");
        assert_eq!(registry.status(&new, "a"), "pending");
        let mut oversized = body("large");
        oversized.text = "x".repeat(MAX_PAYLOAD_BYTES + 1);
        assert!(oversized.validate().is_err());
    }
    #[test]
    fn physical_monitor_positions_support_negative_origins() {
        let areas = [
            WorkArea {
                x: -1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            WorkArea {
                x: 0.0,
                y: 0.0,
                width: 2560.0,
                height: 1440.0,
            },
        ];
        assert_eq!(
            clamp_window_origin(-1800.0, 100.0, 1200.0, 780.0, &areas),
            (-1800.0, 100.0)
        );
        assert_eq!(
            clamp_window_origin(2500.0, 1400.0, 1200.0, 780.0, &areas),
            (1360.0, 660.0)
        );
    }
}
