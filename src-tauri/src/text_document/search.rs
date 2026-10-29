//! Streaming literal matching. No document-sized result list/string.
use super::{invalid, SearchResult, IO_BYTES};
use std::io::{self, Write};
fn prefix(query: &str) -> io::Result<(Vec<u8>, Vec<usize>)> {
    if query.is_empty() || query.len() > IO_BYTES {
        return Err(invalid("原型仅支持 1..65536 字节的非空字面查询"));
    }
    let bytes = query.as_bytes().to_vec();
    let mut prefix = vec![0; bytes.len()];
    let mut matched = 0;
    for i in 1..bytes.len() {
        while matched > 0 && bytes[i] != bytes[matched] {
            matched = prefix[matched - 1];
        }
        if bytes[i] == bytes[matched] {
            matched += 1;
        }
        prefix[i] = matched;
    }
    Ok((bytes, prefix))
}
pub(super) struct Matcher {
    query: Vec<u8>,
    prefix: Vec<usize>,
    matched: usize,
    offset: u64,
    start: u64,
    limit: usize,
    result: SearchResult,
}
impl Matcher {
    pub fn new(query: &str, start: u64, limit: usize) -> io::Result<Self> {
        if limit > 1024 {
            return Err(invalid("搜索页最多 1024 项"));
        }
        let (query, prefix) = prefix(query)?;
        Ok(Self {
            query,
            prefix,
            matched: 0,
            offset: 0,
            start,
            limit,
            result: SearchResult {
                count: 0,
                matches: Vec::new(),
            },
        })
    }
    pub fn result(self) -> SearchResult {
        self.result
    }
}
impl Write for Matcher {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for &byte in bytes {
            while self.matched > 0 && byte != self.query[self.matched] {
                self.matched = self.prefix[self.matched - 1];
            }
            if byte == self.query[self.matched] {
                self.matched += 1;
            }
            self.offset += 1;
            if self.matched == self.query.len() {
                let from = self.offset - self.query.len() as u64;
                self.result.count += 1;
                if from >= self.start && self.result.matches.len() < self.limit {
                    self.result.matches.push((from, self.offset));
                }
                self.matched = 0; // same non-overlapping semantics as replace-all
            }
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) struct Replacer<W: Write> {
    query: Vec<u8>,
    prefix: Vec<usize>,
    replacement: Vec<u8>,
    matched: usize,
    count: u64,
    writer: W,
}
impl<W: Write> Replacer<W> {
    pub fn new(query: &str, replacement: &str, writer: W) -> io::Result<Self> {
        let (query, prefix) = prefix(query)?;
        Ok(Self {
            query,
            prefix,
            replacement: replacement.as_bytes().to_vec(),
            matched: 0,
            count: 0,
            writer,
        })
    }
    pub fn finish(mut self) -> io::Result<u64> {
        self.writer.write_all(&self.query[..self.matched])?;
        self.writer.flush()?;
        Ok(self.count)
    }
}
impl<W: Write> Write for Replacer<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        for &byte in bytes {
            while self.matched > 0 && byte != self.query[self.matched] {
                let next = self.prefix[self.matched - 1];
                self.writer.write_all(&self.query[..self.matched - next])?;
                self.matched = next;
            }
            if byte == self.query[self.matched] {
                self.matched += 1;
            } else {
                self.writer.write_all(&[byte])?;
            }
            if self.matched == self.query.len() {
                self.writer.write_all(&self.replacement)?;
                self.count += 1;
                self.matched = 0;
            }
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}
