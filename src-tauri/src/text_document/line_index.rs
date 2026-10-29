//! Sparse revision-local checkpoints. UTF-16 columns match CM's coordinate unit;
//! storage and pieces remain UTF-8 bytes, including original CR/CRLF separators.
use super::invalid;
use serde::Serialize;
use std::io::{self, Write};
pub(super) const MAX_POINTS: u64 = 2048;
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Position {
    pub byte: u64,
    pub line: u64,
    pub column: u64,
    #[serde(skip)]
    pub(super) cr: bool,
}
impl Default for Position {
    fn default() -> Self {
        Self {
            byte: 0,
            line: 1,
            column: 1,
            cr: false,
        }
    }
}
pub(super) struct Index {
    pub points: Vec<Position>,
    pub end: Position,
}
pub(super) struct Scanner {
    pub position: Position,
    tail: Vec<u8>,
    stride: u64,
    next: u64,
    pub points: Vec<Position>,
}
impl Scanner {
    pub fn new(length: u64) -> Self {
        let stride = length.div_ceil(MAX_POINTS).max(1024 * 1024);
        Self {
            position: Position::default(),
            tail: Vec::new(),
            stride,
            next: stride,
            points: vec![Position::default()],
        }
    }
    pub fn at(position: Position) -> Self {
        Self {
            position,
            tail: Vec::new(),
            stride: u64::MAX,
            next: u64::MAX,
            points: Vec::new(),
        }
    }
    pub fn finish(self) -> io::Result<Index> {
        if !self.tail.is_empty() {
            return Err(invalid("定位范围切开 UTF-8 字符"));
        }
        Ok(Index {
            points: self.points,
            end: self.position,
        })
    }
    fn scan(&mut self, text: &str) {
        for ch in text.chars() {
            self.position.byte += ch.len_utf8() as u64;
            match ch {
                '\r' => {
                    self.position.line += 1;
                    self.position.column = 1;
                    self.position.cr = true;
                }
                '\n' => {
                    if !self.position.cr {
                        self.position.line += 1;
                    }
                    self.position.column = 1;
                    self.position.cr = false;
                }
                _ => {
                    self.position.column += ch.len_utf16() as u64;
                    self.position.cr = false;
                }
            }
            if self.position.byte >= self.next {
                self.points.push(self.position);
                self.next = self.next.saturating_add(self.stride);
            }
        }
    }
}
impl Write for Scanner {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let mut combined = std::mem::take(&mut self.tail);
        combined.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&combined) {
            Ok(_) => combined.len(),
            Err(e) if e.error_len().is_none() => e.valid_up_to(),
            Err(_) => return Err(invalid("索引发现非法 UTF-8")),
        };
        self.scan(std::str::from_utf8(&combined[..valid]).map_err(|_| invalid("非法 UTF-8"))?);
        self.tail.extend_from_slice(&combined[valid..]);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) struct LineFinder {
    pub at: Position,
    target: u64,
    pub found: Option<u64>,
}
impl LineFinder {
    pub fn new(at: Position, target: u64) -> Self {
        Self {
            at,
            target,
            found: None,
        }
    }
}
impl Write for LineFinder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for &byte in bytes {
            if self.at.cr && byte != b'\n' {
                self.at.cr = false;
                if self.at.line == self.target {
                    self.found = Some(self.at.byte);
                    return Err(io::ErrorKind::WouldBlock.into());
                }
            }
            self.at.byte += 1;
            if byte == b'\r' {
                self.at.line += 1;
                self.at.cr = true;
            } else if byte == b'\n' {
                if !self.at.cr {
                    self.at.line += 1;
                }
                self.at.cr = false;
                if self.at.line == self.target {
                    self.found = Some(self.at.byte);
                    return Err(io::ErrorKind::WouldBlock.into());
                }
            }
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
