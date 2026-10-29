//! Independently implemented persistent AVL sequence. Nodes contain byte spans,
//! never file bodies. History roots share unchanged nodes and disk extents.
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(super) enum Store {
    Base,
    Added,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub(super) struct Span {
    pub store: Store,
    pub offset: u64,
    pub len: u64,
}
#[derive(Debug)]
enum Kind {
    Leaf(Span),
    Fork(Tree, Tree),
}
#[derive(Debug)]
pub(super) struct Node {
    len: u64,
    height: u32,
    kind: Kind,
}
pub(super) type Tree = Option<Arc<Node>>;
pub(super) fn len(t: &Tree) -> u64 {
    t.as_ref().map_or(0, |n| n.len)
}
fn height(t: &Tree) -> u32 {
    t.as_ref().map_or(0, |n| n.height)
}
pub(super) fn leaf(span: Span) -> Tree {
    (span.len > 0).then(|| {
        Arc::new(Node {
            len: span.len,
            height: 1,
            kind: Kind::Leaf(span),
        })
    })
}
fn fork(a: Tree, b: Tree) -> Tree {
    if a.is_none() {
        return b;
    }
    if b.is_none() {
        return a;
    }
    Some(Arc::new(Node {
        len: len(&a) + len(&b),
        height: 1 + height(&a).max(height(&b)),
        kind: Kind::Fork(a, b),
    }))
}
fn children(t: &Tree) -> (Tree, Tree) {
    match &t.as_ref().expect("nonempty AVL branch").kind {
        Kind::Fork(a, b) => (a.clone(), b.clone()),
        Kind::Leaf(_) => unreachable!("a tall tree is a branch"),
    }
}
fn balance(a: Tree, b: Tree) -> Tree {
    if height(&a) > height(&b) + 1 {
        let (aa, ab) = children(&a);
        if height(&aa) >= height(&ab) {
            return fork(aa, fork(ab, b));
        }
        let (aba, abb) = children(&ab);
        return fork(fork(aa, aba), fork(abb, b));
    }
    if height(&b) > height(&a) + 1 {
        let (ba, bb) = children(&b);
        if height(&bb) >= height(&ba) {
            return fork(fork(a, ba), bb);
        }
        let (baa, bab) = children(&ba);
        return fork(fork(a, baa), fork(bab, bb));
    }
    fork(a, b)
}
pub(super) fn join(a: Tree, b: Tree) -> Tree {
    if height(&a) > height(&b) + 1 {
        let (aa, ab) = children(&a);
        balance(aa, join(ab, b))
    } else if height(&b) > height(&a) + 1 {
        let (ba, bb) = children(&b);
        balance(join(a, ba), bb)
    } else {
        fork(a, b)
    }
}
pub(super) fn split(t: &Tree, at: u64) -> (Tree, Tree) {
    assert!(at <= len(t));
    let Some(n) = t else {
        return (None, None);
    };
    if at == 0 {
        return (None, t.clone());
    }
    if at == n.len {
        return (t.clone(), None);
    }
    match &n.kind {
        Kind::Leaf(s) => (
            leaf(Span { len: at, ..*s }),
            leaf(Span {
                offset: s.offset + at,
                len: s.len - at,
                ..*s
            }),
        ),
        Kind::Fork(a, b) => {
            if at < len(a) {
                let (x, y) = split(a, at);
                (x, join(y, b.clone()))
            } else {
                let (x, y) = split(b, at - len(a));
                (join(a.clone(), x), y)
            }
        }
    }
}
pub(super) fn replace(t: &Tree, from: u64, to: u64, inserted: Tree) -> Tree {
    let (a, rest) = split(t, from);
    let (_, b) = split(&rest, to - from);
    join(join(a, inserted), b)
}
// O(log pieces + intersecting pieces), with no Vec of all document spans.
pub(super) fn visit<E>(
    t: &Tree,
    from: u64,
    to: u64,
    f: &mut impl FnMut(Span) -> Result<(), E>,
) -> Result<(), E> {
    if from == to {
        return Ok(());
    }
    let n = t.as_ref().expect("validated nonempty range");
    match &n.kind {
        Kind::Leaf(s) => f(Span {
            offset: s.offset + from,
            len: to - from,
            ..*s
        }),
        Kind::Fork(a, b) => {
            let mid = len(a);
            if from < mid {
                visit(a, from, to.min(mid), f)?;
            }
            if to > mid {
                visit(b, from.saturating_sub(mid), to - mid, f)?;
            }
            Ok(())
        }
    }
}
pub(super) fn spans(t: &Tree) -> Vec<Span> {
    let mut out = Vec::new();
    visit(t, 0, len(t), &mut |s| {
        out.push(s);
        Ok::<_, ()>(())
    })
    .unwrap();
    out
}
pub(super) fn from_spans(spans: &[Span]) -> Tree {
    if spans.is_empty() {
        None
    } else if spans.len() == 1 {
        leaf(spans[0])
    } else {
        let at = spans.len() / 2;
        fork(from_spans(&spans[..at]), from_spans(&spans[at..]))
    }
}
#[cfg(test)]
pub(super) fn validate(t: &Tree) -> (u64, u32) {
    let Some(n) = t else { return (0, 0) };
    match &n.kind {
        Kind::Leaf(s) => {
            assert_eq!(n.height, 1);
            assert_eq!(n.len, s.len);
        }
        Kind::Fork(a, b) => {
            let (al, ah) = validate(a);
            let (bl, bh) = validate(b);
            assert!(ah.abs_diff(bh) <= 1);
            assert_eq!(n.len, al + bl);
            assert_eq!(n.height, 1 + ah.max(bh));
        }
    }
    (n.len, n.height)
}
