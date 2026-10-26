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
        if self.document_id.trim().is_empty() {
            return Err("移交的文档缺少标识".into());
        }
        if self.name.trim().is_empty() {
            return Err("移交的文档缺少文件名".into());
        }
        if self.text.len() > MAX_PAYLOAD_BYTES {
            return Err("移交的文档超过 32 MiB，无法移动到新窗口".into());
        }
        if !matches!(self.encoding.as_str(), "" | "UTF-8" | "UTF-8 BOM" | "GBK" | "GB18030" | "Big5" | "UTF-16LE" | "UTF-16BE" | "Shift_JIS" | "EUC-KR" | "windows-1252" | "ISO-8859-1" | "Hex") {
            return Err("移交的文档编码不受支持".into());
        }
        if !matches!(self.eol.as_str(), "" | "LF" | "CRLF" | "CR") {
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
}

impl DetachRegistry {
    fn purge(&mut self, now: Instant) {
        self.handoffs
            .retain(|handoff| now.duration_since(handoff.created) < HANDOFF_TTL);
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
        let handoff = self
            .handoffs
            .iter_mut()
            .find(|handoff| handoff.label == label)
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
        let index = self.handoffs.iter().position(|handoff| handoff.id == id)?;
        let handoff = self.handoffs.remove(index);
        Some((handoff.source, handoff.payload.document_id))
    }

    /// Rollback: forget a handoff without touching any document.
    pub fn rollback(&mut self, id: &str) {
        self.handoffs.retain(|handoff| handoff.id != id);
    }

    /// Drop every handoff that references a window that is gone.
    pub fn forget_window(&mut self, label: &str) {
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
