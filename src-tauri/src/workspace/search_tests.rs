use super::{preview, replace, search::*};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
fn query(text: &str) -> SearchQuery {
    serde_json::from_value(json!({"search_id":"test","query":text,"is_case_sensitive":false,"is_whole_word":false,"is_regex":false,"max_results":1000})).unwrap()
}
fn tempdir() -> tempfile::TempDir {
    let parent = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-results/search/rust");
    fs::create_dir_all(&parent).unwrap();
    let parent = parent.canonicalize().unwrap();
    let directory = tempfile::Builder::new()
        .prefix("search-")
        .tempdir_in(&parent)
        .unwrap();
    assert!(directory
        .path()
        .canonicalize()
        .unwrap()
        .starts_with(&parent));
    directory
}
fn fixture(files: &[(&str, &[u8])]) -> tempfile::TempDir {
    let dir = tempdir();
    for (name, body) in files {
        let path = dir.path().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap()
    }
    dir
}
fn search(roots: &[PathBuf], q: &SearchQuery) -> (SearchSummary, Vec<SearchMatch>) {
    let mut hits = Vec::new();
    let result = WorkspaceSearcher::execute_search_detailed(
        roots,
        q,
        Arc::new(AtomicBool::new(false)),
        |batch| hits.extend(batch),
    )
    .unwrap();
    (result, hits)
}
fn root(path: &Path) -> Vec<PathBuf> {
    vec![path.canonicalize().unwrap()]
}

#[test]
fn case_whole_word_and_multiple_matches() {
    let dir = fixture(&[("a.txt", b"hello Hello hello_ hello\n")]);
    let roots = root(dir.path());
    let mut q = query("hello");
    assert_eq!(search(&roots, &q).1.len(), 4);
    q.is_case_sensitive = true;
    assert_eq!(search(&roots, &q).1.len(), 3);
    q.is_whole_word = true;
    let hits = search(&roots, &q).1;
    assert_eq!(hits.len(), 2);
    assert_ne!(hits[0].id, hits[1].id);
}
#[test]
fn regex_validation_and_captures() {
    let dir = fixture(&[("a.txt", b"old12 old34")]);
    let mut q = query(r"old(\d+)");
    q.is_regex = true;
    assert_eq!(search(&root(dir.path()), &q).1.len(), 2);
    let changes =
        replace::edits("old12 old34", &q, "new${1}", 1000, &AtomicBool::new(false)).unwrap();
    assert_eq!(changes[1].insert, "new34");
    q.query = "(?<=x)y".into();
    assert!(compile_query(&q).is_err());
    q.query = "[".into();
    assert!(compile_query(&q).is_err());
}
#[test]
fn unicode_utf16_columns_and_snippets() {
    let dir = fixture(&[("a.txt", "😀é 中文 中文".as_bytes())]);
    let hits = search(&root(dir.path()), &query("中文")).1;
    assert_eq!((hits[0].column_number, hits[1].column_number), (5, 8));
    assert_eq!(hits[0].match_length, 2);
    assert_eq!(
        &hits[0].line_text.encode_utf16().collect::<Vec<_>>()
            [hits[0].snippet_column..hits[0].snippet_column + 2],
        &"中文".encode_utf16().collect::<Vec<_>>()
    );
}
#[test]
fn utf8_utf16_and_all_line_endings() {
    for encoding in ["UTF-8", "UTF-16LE", "UTF-16BE"] {
        for eol in ["\n", "\r\n", "\r"] {
            let body = format!("start{eol}中文{eol}end");
            let bytes = crate::files::codec::encode(&body, encoding, encoding != "UTF-8").unwrap();
            let dir = fixture(&[("a.txt", &bytes)]);
            let hits = search(&root(dir.path()), &query("中文")).1;
            assert_eq!(hits.len(), 1, "{encoding}/{eol:?}");
            assert_eq!(hits[0].line_number, 2);
        }
    }
}
#[test]
fn legacy_text_uses_same_file_codec() {
    let body = "中文 needle";
    let bytes = crate::files::codec::encode(body, "GB18030", false).unwrap();
    let dir = fixture(&[("legacy.txt", &bytes)]);
    assert_eq!(search(&root(dir.path()), &query("needle")).1.len(), 1);
}
#[test]
fn long_line_hit_is_visible_and_not_the_first_kilobyte() {
    let body = format!("{}needle{}", "x".repeat(300_000), "z".repeat(100_000));
    let dir = fixture(&[("a.txt", body.as_bytes())]);
    let hit = search(&root(dir.path()), &query("needle")).1.remove(0);
    assert_eq!(hit.column_number, 300001);
    assert!(hit.line_text.contains("needle"));
    assert!(hit.line_text.chars().count() <= 500);
}
#[test]
fn media_binary_and_size_budget() {
    let dir = fixture(&[
        ("binary.dat", b"needle\0binary"),
        ("image.pdf", b"%PDF-1.7 needle"),
        ("normal.txt", b"needle"),
    ]);
    let big = fs::File::create(dir.path().join("big.txt")).unwrap();
    big.set_len(10 * 1024 * 1024 + 1).unwrap();
    let (summary, hits) = search(&root(dir.path()), &query("needle"));
    assert_eq!(hits.len(), 1);
    assert!(summary.skipped >= 2);
}
#[test]
fn multiple_roots_and_directory_authorization() {
    let a = fixture(&[("src/a.txt", b"needle"), ("other/a.txt", b"needle")]);
    let b = fixture(&[("b.txt", b"needle")]);
    let mut roots = root(a.path());
    roots.extend(root(b.path()));
    assert_eq!(search(&roots, &query("needle")).1.len(), 3);
    let mut q = query("needle");
    q.scope = "directory".into();
    q.directory = Some(a.path().join("src").to_string_lossy().into());
    assert_eq!(search(&roots, &q).1.len(), 1);
    q.directory = Some(std::env::temp_dir().to_string_lossy().into());
    assert!(WorkspaceSearcher::execute_search_detailed(
        &roots,
        &q,
        Arc::new(AtomicBool::new(false)),
        |_| {}
    )
    .is_err());
}
#[test]
fn glob_filter_happens_before_hit_limit() {
    let dir = fixture(&[
        ("noise.txt", b"needle needle needle"),
        ("src/a.rs", b"needle"),
        ("src/generated/b.rs", b"needle"),
        ("src/a.ts", b"needle"),
    ]);
    let mut q = query("needle");
    q.max_results = Some(1);
    q.include_globs = vec!["src/**/*.{rs,ts}".into()];
    q.exclude_globs = vec!["**/generated/**".into(), "*.ts".into()];
    let (summary, hits) = search(&root(dir.path()), &q);
    assert_eq!(hits.len(), 1);
    assert!(hits[0].path.ends_with("a.rs"));
    assert!(summary.limited);
    q.include_globs = vec!["[".into()];
    assert!(FileFilters::new(&q).is_err());
}
#[test]
fn ignored_search_never_bypasses_replace_guard() {
    let dir = fixture(&[
        (".gitignore", b"ignored/**\n"),
        ("ignored/a.txt", b"needle"),
        ("a.txt", b"needle"),
    ]);
    let roots = root(dir.path());
    let mut q = query("needle");
    assert_eq!(search(&roots, &q).1.len(), 1);
    q.include_ignored = true;
    assert_eq!(search(&roots, &q).1.len(), 2);
    assert!(replace::allowed_path(&roots, &dir.path().join("ignored/a.txt"), &q).is_err());
}
#[test]
fn cancellation_and_reused_ids() {
    let dir = fixture(&[("many.txt", "needle\n".repeat(3000).as_bytes())]);
    let token = Arc::new(AtomicBool::new(false));
    let cancel = token.clone();
    let summary = WorkspaceSearcher::execute_search_detailed(
        &root(dir.path()),
        &query("needle"),
        token,
        move |_| cancel.store(true, Ordering::Relaxed),
    )
    .unwrap();
    assert!(summary.canceled);
    assert!(summary.total < 1000);
    let manager = SearchManager::default();
    let old = manager.create_token("a:id");
    let current = manager.create_token("a:id");
    assert!(old.load(Ordering::Relaxed));
    manager.cleanup("a:id", &old);
    manager.cancel("a:id");
    assert!(current.load(Ordering::Relaxed));
    let first = manager.shared_token("preview:owner");
    let second = manager.shared_token("preview:owner");
    assert!(Arc::ptr_eq(&first, &second));
    manager.cancel("preview:owner");
    assert!(first.load(Ordering::Relaxed) && second.load(Ordering::Relaxed));
    assert!(!manager
        .shared_token("preview:owner")
        .load(Ordering::Relaxed));
}
#[test]
fn cap_is_explicitly_incomplete() {
    let dir = fixture(&[("a.txt", "needle ".repeat(1100).as_bytes())]);
    let (summary, hits) = search(&root(dir.path()), &query("needle"));
    assert_eq!(hits.len(), 1000);
    assert_eq!(summary.total, 1000);
    assert!(summary.limited);
    assert!(summary.reason.is_some());
}
#[test]
fn opened_scope_searches_unsaved_and_drafts_without_workspace() {
    let mut q = query("unsaved");
    q.scope = "opened".into();
    q.buffers=serde_json::from_value(json!([{"path":"untitled-1","document_id":"untitled-1","relative_path":"草稿.md","text":"unsaved unsaved"},{"path":"outside.java","document_id":"file-a","text":"unsaved"}])).unwrap();
    let (_, hits) = search(&[], &q);
    assert_eq!(hits.len(), 3);
    assert_eq!(hits[0].relative_path, "草稿.md");
    assert_eq!(hits[0].document_id.as_deref(), Some("untitled-1"));
    let preview =
        replace::preview(&[], &q, "changed", &[], Arc::new(AtomicBool::new(false))).unwrap();
    assert_eq!(preview.files.len(), 2);
    assert!(preview.files.iter().all(|f| f.buffer));
    assert_eq!(preview.files[0].edits[0].insert, "changed");
}
#[test]
fn buffer_overrides_disk_and_readonly_buffers_are_not_replaced() {
    let dir = fixture(&[("a.txt", b"saved")]);
    let mut q = query("unsaved");
    q.buffers = serde_json::from_value(
        json!([{"path":dir.path().join("a.txt"),"document_id":"doc","text":"unsaved"}]),
    )
    .unwrap();
    assert_eq!(search(&root(dir.path()), &q).1.len(), 1);
    q.scope = "opened".into();
    q.buffers[0].read_only = true;
    let preview = replace::preview(&[], &q, "x", &[], Arc::new(AtomicBool::new(false))).unwrap();
    assert!(preview.files.is_empty());
    assert!(!preview.skipped.is_empty());
}
#[test]
fn safe_selected_replace_preserves_encoding_eol_and_detects_external_change() {
    for encoding in ["UTF-8", "UTF-16LE", "UTF-16BE"] {
        let source = "old12 old34\r\nold56\rold78\n";
        let bytes = crate::files::codec::encode(source, encoding, encoding != "UTF-8").unwrap();
        let dir = fixture(&[("a.txt", &bytes)]);
        let roots = root(dir.path());
        let mut q = query(r"old(\d+)");
        q.is_regex = true;
        let preview =
            replace::preview(&roots, &q, "new${1}", &[], Arc::new(AtomicBool::new(false))).unwrap();
        let file = &preview.files[0];
        let request = replace::ReplaceApply {
            query: q,
            replacement: "new${1}".into(),
            path: file.path.clone(),
            version: file.version.clone(),
            selected: vec![1],
        };
        assert_eq!(replace::apply(&roots, &request).unwrap(), 1);
        let output = fs::read(dir.path().join("a.txt")).unwrap();
        assert_eq!(
            output,
            crate::files::codec::encode(
                "old12 new34\r\nold56\rold78\n",
                encoding,
                encoding != "UTF-8"
            )
            .unwrap()
        );
        assert!(replace::apply(&roots, &request).is_err());
    }
}
#[test]
fn delete_replacement_and_cancel_preview() {
    let dir = fixture(&[("a.txt", b"remove keep")]);
    let roots = root(dir.path());
    let q = query("remove");
    let token = Arc::new(AtomicBool::new(false));
    let preview = replace::preview(&roots, &q, "", &[], token).unwrap();
    let file = &preview.files[0];
    replace::apply(
        &roots,
        &replace::ReplaceApply {
            query: q.clone(),
            replacement: String::new(),
            path: file.path.clone(),
            version: file.version.clone(),
            selected: vec![0],
        },
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(dir.path().join("a.txt")).unwrap(),
        " keep"
    );
    let canceled = replace::preview(&roots, &q, "x", &[], Arc::new(AtomicBool::new(true))).unwrap();
    assert!(canceled.canceled);
    assert!(canceled.files.is_empty());
}
#[test]
fn readonly_disk_replace_is_refused() {
    let dir = fixture(&[("a.txt", b"needle")]);
    let path = dir.path().join("a.txt");
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&path, permissions).unwrap();
    let preview = replace::preview(
        &root(dir.path()),
        &query("needle"),
        "x",
        &[path.to_string_lossy().into()],
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert!(preview.files.is_empty());
    assert!(!preview.skipped.is_empty());
    let mut permissions = fs::metadata(&path).unwrap().permissions();
    permissions.set_readonly(false);
    fs::set_permissions(&path, permissions).unwrap();
}
#[test]
fn preview_context_bounds_and_stale_content() {
    let body = (1..=100)
        .map(|line| format!("row {line} needle\n"))
        .collect::<String>();
    let dir = fixture(&[("a.txt", body.as_bytes())]);
    let roots = root(dir.path());
    let hit = search(&roots, &query("needle"))
        .1
        .into_iter()
        .find(|hit| hit.line_number == 50)
        .unwrap();
    let request = preview::PreviewRequest {
        path: hit.path,
        version: hit.version,
        line: 50,
        column: hit.column_number,
        length: 6,
        query: query("needle"),
    };
    let mut cache = preview::PreviewCache::default();
    let result = cache.read("window", &roots, &request).unwrap();
    assert!(result.start_line <= 40);
    assert!(result.text.contains("row 60"));
    assert!(result.text.len() <= 256 * 1024);
    assert_eq!(
        &result.text[result.selection_from..result.selection_to],
        "needle"
    );
    fs::write(dir.path().join("a.txt"), "external change").unwrap();
    assert!(cache.read("window", &roots, &request).is_err());
    cache.clear("window");
}
#[test]
fn bounded_preview_does_not_fake_regex_anchors_on_long_line() {
    let body = format!("{}needle{}", "x".repeat(300_000), "z".repeat(300_000));
    let mut q = query("^x|needle");
    q.is_regex = true;
    let request = preview::PreviewRequest {
        path: "a.txt".into(),
        version: "test".into(),
        line: 1,
        column: 300001,
        length: 6,
        query: q,
    };
    let result = preview::window(&body, &request).unwrap();
    assert!(result.truncated);
    assert_eq!(result.hits.len(), 1);
    assert!(result.text.len() <= 256 * 1024);
}
#[test]
fn thousands_of_files_are_bounded_without_an_index() {
    let dir = tempdir();
    for index in 0..2100 {
        fs::write(dir.path().join(format!("{index}.txt")), "needle").unwrap();
    }
    let started = std::time::Instant::now();
    let (summary, hits) = search(&root(dir.path()), &query("needle"));
    assert_eq!(hits.len(), 1000);
    assert!(summary.limited);
    assert!(started.elapsed().as_secs() < 10);
}

#[test]
fn same_named_roots_are_distinct_and_outside_preview_is_denied() {
    let a = fixture(&[("same/a.txt", b"needle")]);
    let b = fixture(&[("same/b.txt", b"needle")]);
    let roots = vec![
        a.path().join("same").canonicalize().unwrap(),
        b.path().join("same").canonicalize().unwrap(),
    ];
    let (_, hits) = search(&roots, &query("needle"));
    assert_eq!(hits.len(), 2);
    assert!(hits
        .iter()
        .all(|hit| hit.relative_path.len() > "same/a.txt".len()));
    let q = query("needle");
    assert!(super::replace::preview(
        &root(a.path()),
        &q,
        "changed",
        &[b.path().join("same/b.txt").to_string_lossy().into_owned()],
        Arc::new(AtomicBool::new(false))
    )
    .unwrap()
    .files
    .is_empty());
    let hit = &hits[1];
    let request = super::preview::PreviewRequest {
        path: b.path().join("same/b.txt").to_string_lossy().into_owned(),
        version: hit.version.clone(),
        line: 1,
        column: 1,
        length: 6,
        query: q,
    };
    assert!(super::preview::PreviewCache::default()
        .read("test", &root(a.path()), &request)
        .is_err());
    assert_eq!(fs::read(b.path().join("same/b.txt")).unwrap(), b"needle");
}
