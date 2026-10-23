use super::*;
use std::{
    cell::Cell,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

thread_local! {static FAIL_COPY:Cell<bool>=const{Cell::new(false)};}
pub(super) fn copy_fault() -> bool {
    FAIL_COPY.with(Cell::get)
}

fn store() -> ConversionStore {
    let s = ConversionStore::default();
    s.register("a");
    s.register("b");
    s.register("c");
    s
}
fn select(s: &ConversionStore, owner: &str, path: &Path, purpose: Purpose) -> Selection {
    let permit = s.dialog(owner).unwrap();
    s.selected(&permit, Some(path.into()), purpose)
        .unwrap()
        .unwrap()
}
fn begin(s: &ConversionStore, selection: &Selection, purpose: Purpose) -> Operation {
    s.begin("a", &[(&selection.token, purpose)]).unwrap()
}
fn png() -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ioAAAAASUVORK5CYII=").unwrap()
}
fn docx(extra: Option<(&str, &[u8])>) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in [
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("word/document.xml", b"<document/>".as_slice()),
    ]
    .into_iter()
    .chain(extra)
    {
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}
fn tree(image: Option<&str>) -> serde_json::Value {
    let blocks = match image {
        Some(source) => {
            serde_json::json!([{"t":"Para","c":[{"t":"Image","c":[["",[],[]],[],[source,""]]}]}])
        }
        None => serde_json::json!([]),
    };
    serde_json::json!({"pandoc-api-version":[1,23,1],"meta":{},"blocks":blocks})
}
struct FakeRunner {
    fail: bool,
    image: Option<String>,
}
impl Runner for FakeRunner {
    fn run(&self, cmd: &mut Command, _op: &Operation, _work: &Path) -> Result<()> {
        let args: Vec<_> = cmd
            .get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect();
        assert!(args.iter().any(|s| s == "--sandbox"));
        assert!(!args.iter().any(|s| s == "--extract-media"));
        let value = |flag: &str| -> String {
            args[args.iter().position(|s| s == flag).unwrap() + 1].clone()
        };
        let output = PathBuf::from(value("-o"));
        if self.fail {
            fs::write(output, b"partial output").unwrap();
            return Err("injected Pandoc failure".into());
        }
        match value("-t").as_str() {
            "json" => fs::write(output, tree(self.image.as_deref()).to_string()).unwrap(),
            "docx" => fs::write(output, docx(None)).unwrap(),
            "gfm" => {
                let input = PathBuf::from(args.last().unwrap());
                let ast: serde_json::Value =
                    serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
                let source = ast
                    .pointer("/blocks/0/c/0/c/2/0")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                fs::write(output, format!("# Imported\n\n![image]({source})\n")).unwrap();
            }
            _ => panic!("unexpected converter"),
        }
        Ok(())
    }
}

#[test]
fn unauthorized_paths_forged_cross_window_and_cross_format_tokens_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let a = select(&s, "a", &dir.path().join("a.html"), Purpose::Html);
    assert!(s
        .begin(
            "a",
            &[(
                dir.path().join("other.html").to_str().unwrap(),
                Purpose::Html
            )]
        )
        .is_err());
    assert!(s.begin("a", &[("forged", Purpose::Html)]).is_err());
    assert!(s.begin("b", &[(&a.token, Purpose::Html)]).is_err());
    for p in [
        Purpose::Png,
        Purpose::Pdf,
        Purpose::Docx,
        Purpose::Markdown,
        Purpose::ReadHtml,
        Purpose::ReadDocx,
    ] {
        assert!(s.begin("a", &[(&a.token, p)]).is_err());
    }
    s.release("b", &a.token);
    let op = begin(&s, &a, Purpose::Html);
    save_binary(&op, b"<html>allowed</html>").unwrap();
    assert!(!dir.path().join("other.html").exists());
    assert_eq!(fs::read(&a.path).unwrap(), b"<html>allowed</html>");
    drop(op);
    assert!(s.begin("a", &[(&a.token, Purpose::Html)]).is_err());
}
#[test]
fn expiry_release_close_and_late_dialog_results_revoke_authority() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let path = dir.path().join("a.html");
    let a = select(&s, "a", &path, Purpose::Html);
    s.expire(&a.token);
    assert!(s.begin("a", &[(&a.token, Purpose::Html)]).is_err());
    let a = select(&s, "a", &path, Purpose::Html);
    s.release("a", &a.token);
    assert!(s.begin("a", &[(&a.token, Purpose::Html)]).is_err());
    let a = select(&s, "a", &path, Purpose::Html);
    let op = begin(&s, &a, Purpose::Html);
    s.release("a", &a.token);
    assert!(save_binary(&op, b"x").is_err());
    drop(op);
    let a = select(&s, "a", &path, Purpose::Html);
    let op = begin(&s, &a, Purpose::Html);
    let dialog = s.dialog("a").unwrap();
    s.close("a");
    assert!(save_binary(&op, b"x").is_err());
    assert!(s
        .selected(&dialog, Some(path.clone()), Purpose::Html)
        .is_err());
    assert!(s.begin("a", &[(&a.token, Purpose::Html)]).is_err());
    assert!(!path.exists());
}
#[test]
fn cancellation_has_no_lease_and_counts_and_concurrency_are_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    for _ in 0..12 {
        let permit = s.dialog("a").unwrap();
        assert!(s.selected(&permit, None, Purpose::Html).unwrap().is_none());
        assert!(s.dialog("a").is_err());
    }
    let mut selected = Vec::new();
    for i in 0..MAX_LEASES {
        selected.push(select(
            &s,
            "a",
            &dir.path().join(format!("{i}.html")),
            Purpose::Html,
        ));
    }
    let permit = s.dialog("a").unwrap();
    assert!(s
        .selected(
            &permit,
            Some(dir.path().join("overflow.html")),
            Purpose::Html
        )
        .is_err());
    drop(permit);
    let op = begin(&s, &selected[0], Purpose::Html);
    assert!(s
        .begin("a", &[(&selected[1].token, Purpose::Html)])
        .is_err());
    let b = select(&s, "b", &dir.path().join("b.html"), Purpose::Html);
    let op_b = s.begin("b", &[(&b.token, Purpose::Html)]).unwrap();
    let c = select(&s, "c", &dir.path().join("c.html"), Purpose::Html);
    assert!(s.begin("c", &[(&c.token, Purpose::Html)]).is_err());
    drop(op_b);
    assert!(s.begin("c", &[(&c.token, Purpose::Html)]).is_ok());
    drop(op);
}
#[test]
fn copy_failure_must_not_be_reported_as_success() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let target = dir.path().join("old.html");
    fs::write(&target, b"original").unwrap();
    let lease = select(&s, "a", &target, Purpose::Html);
    let mut permissions = fs::metadata(&target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    let result = save_binary(&begin(&s, &lease, Purpose::Html), b"replacement");
    assert!(result.is_err());
    assert_eq!(fs::read(&target).unwrap(), b"original");
    #[cfg(windows)]
    #[allow(clippy::permissions_set_readonly_false)]
    {
        let mut p = fs::metadata(&target).unwrap().permissions();
        p.set_readonly(false);
        fs::set_permissions(&target, p).unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
#[test]
fn temp_write_fsync_rename_and_external_race_fail_without_false_success() {
    use crate::files::atomic::fault;
    for point in [
        fault::TEMP_CREATE,
        fault::TEMP_WRITE,
        fault::TEMP_SYNC,
        fault::REPLACE,
        fault::RACE_EXISTING,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let s = store();
        let target = dir.path().join("old.html");
        fs::write(&target, b"original").unwrap();
        let lease = select(&s, "a", &target, Purpose::Html);
        fault::set(point);
        let result = save_binary(&begin(&s, &lease, Purpose::Html), b"replacement");
        fault::clear();
        assert!(result.is_err(), "fault {point}");
        // Windows excludes writers while staging; Unix detects the changed version.
        let changed = point == fault::RACE_EXISTING && cfg!(unix);
        assert_eq!(
            fs::read(&target).unwrap(),
            if changed {
                b"external during staging".as_slice()
            } else {
                b"original".as_slice()
            }
        );
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "temporary file leaked"
        );
    }
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let target = dir.path().join("new.html");
    let lease = select(&s, "a", &target, Purpose::Html);
    fault::set(fault::RACE_TARGET);
    let result = save_binary(&begin(&s, &lease, Purpose::Html), b"replacement");
    fault::clear();
    assert!(result.is_err());
    assert_eq!(fs::read(target).unwrap(), b"intruder");
}
#[test]
fn changed_deleted_and_directory_targets_are_not_overwritten() {
    for mode in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let s = store();
        let path = dir.path().join("a.html");
        fs::write(&path, b"original").unwrap();
        let lease = select(&s, "a", &path, Purpose::Html);
        match mode {
            0 => fs::write(&path, b"external").unwrap(),
            1 => fs::remove_file(&path).unwrap(),
            _ => {
                fs::remove_file(&path).unwrap();
                fs::create_dir(&path).unwrap();
            }
        }
        assert!(save_binary(&begin(&s, &lease, Purpose::Html), b"new").is_err());
        if mode == 0 {
            assert_eq!(fs::read(path).unwrap(), b"external");
        }
    }
}
#[test]
fn oversize_ipc_rejected_in_deserializer_without_filling_entire_vector() {
    use serde::{
        de::value::{Error, SeqDeserializer, StrDeserializer},
        Deserialize,
    };
    let counter = Cell::new(0usize);
    let iter = (0..MAX_OUTPUT + 100).map(|_| {
        counter.set(counter.get() + 1);
        42u8
    });
    assert!(BinaryBytes::deserialize(SeqDeserializer::<_, Error>::new(iter)).is_err());
    assert_eq!(counter.get(), MAX_OUTPUT + 1);
    let oversized = "x".repeat(MAX_TEXT + 1);
    assert!(InputText::deserialize(StrDeserializer::<Error>::new(&oversized)).is_err());
}
#[test]
fn valid_html_png_and_html_import_use_native_pipeline() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    for (format, bytes) in [
        (Purpose::Html, b"<h1>hello</h1>".to_vec()),
        (Purpose::Png, png()),
    ] {
        let lease = select(&s, "a", &dir.path().join(format!("{format:?}")), format);
        save_binary(&begin(&s, &lease, format), &bytes).unwrap();
        assert_eq!(fs::read(&lease.path).unwrap(), bytes);
    }
    let path = dir.path().join("import.html");
    fs::write(&path, b"<h1>import</h1>").unwrap();
    let lease = select(&s, "a", &path, Purpose::ReadHtml);
    assert_eq!(
        read_html(&begin(&s, &lease, Purpose::ReadHtml)).unwrap(),
        "<h1>import</h1>"
    );
}
#[test]
fn pandoc_failure_and_invalid_docx_output_preserve_old_target() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let target = dir.path().join("old.docx");
    fs::write(&target, b"old docx").unwrap();
    let lease = select(&s, "a", &target, Purpose::Docx);
    assert!(export_docx(
        &begin(&s, &lease, Purpose::Docx),
        "# test",
        Path::new("fake"),
        &FakeRunner {
            fail: true,
            image: None
        },
        |_| panic!()
    )
    .is_err());
    assert_eq!(fs::read(&target).unwrap(), b"old docx");
    assert!(validate_docx(b"PK invalid archive").is_err());
}
#[test]
fn remote_images_never_contact_loopback() {
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let hits = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(AtomicBool::new(false));
    let server = {
        let hits = hits.clone();
        let stop = stop.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        hits.fetch_add(1, Ordering::SeqCst);
                        let mut request = [0u8; 2048];
                        let _ = stream.read(&mut request);
                        let body = png();
                        let _ = write!(
                            stream,
                            "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                            body.len()
                        );
                        let _ = stream.write_all(&body);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(std::time::Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        })
    };
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let target = dir.path().join("remote.docx");
    let lease = select(&s, "a", &target, Purpose::Docx);
    let image = format!("http://127.0.0.1:{port}/pixel.png");
    let result = export_docx(
        &begin(&s, &lease, Purpose::Docx),
        "# remote",
        Path::new("fake"),
        &FakeRunner {
            fail: false,
            image: Some(image),
        },
        |_| panic!("remote URL must not be treated as a local path"),
    );
    stop.store(true, Ordering::Release);
    server.join().unwrap();
    assert!(result.is_err(), "loopback image fetch must be refused");
    assert_eq!(
        hits.load(Ordering::SeqCst),
        0,
        "no request may reach the loopback service"
    );
    assert!(!target.exists(), "failed export must not create a target");
}
#[test]
fn docx_member_traversal_and_assets_symlink_are_rejected() {
    for name in [
        "../escape",
        "/absolute",
        "word/../../secret",
        "word/media/C:foo",
        "word\\media\\x",
        "word/media/aux.png",
    ] {
        assert!(safe_member(name).is_err(), "{name}");
    }
    assert!(validate_docx(&docx(Some(("../escape", b"x")))).is_err());
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let outside = root.join("outside");
    fs::create_dir(&outside).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, root.join("result.assets")).unwrap();
    #[cfg(windows)]
    {
        let status = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("result.assets"))
            .arg(&outside)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(status.success());
    }
    let source = root.join("source.docx");
    fs::write(&source, docx(Some(("word/media/image.png", &png())))).unwrap();
    let s = store();
    let read = select(&s, "a", &source, Purpose::ReadDocx);
    let write = select(&s, "a", &root.join("result.md"), Purpose::Markdown);
    let op = s
        .begin(
            "a",
            &[
                (&read.token, Purpose::ReadDocx),
                (&write.token, Purpose::Markdown),
            ],
        )
        .unwrap();
    assert!(import_docx(
        &op,
        Path::new("fake"),
        &FakeRunner {
            fail: false,
            image: Some("media/image.png".into())
        }
    )
    .is_err());
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}
#[test]
fn docx_import_copy_or_markdown_commit_failure_cleans_only_new_assets() {
    for copy_fail in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source.docx");
        fs::write(&source, docx(Some(("word/media/image.png", &png())))).unwrap();
        let target = dir.path().join("result.md");
        fs::write(&target, b"old markdown").unwrap();
        let base = dir.path().join("result.assets");
        fs::create_dir(&base).unwrap();
        fs::write(base.join("old.png"), b"old image").unwrap();
        let s = store();
        let read = select(&s, "a", &source, Purpose::ReadDocx);
        let write = select(&s, "a", &target, Purpose::Markdown);
        let op = s
            .begin(
                "a",
                &[
                    (&read.token, Purpose::ReadDocx),
                    (&write.token, Purpose::Markdown),
                ],
            )
            .unwrap();
        FAIL_COPY.with(|c| c.set(copy_fail));
        if !copy_fail {
            crate::files::atomic::fault::set(crate::files::atomic::fault::TEMP_SYNC);
        }
        let result = import_docx(
            &op,
            Path::new("fake"),
            &FakeRunner {
                fail: false,
                image: Some("media/image.png".into()),
            },
        );
        FAIL_COPY.with(|c| c.set(false));
        crate::files::atomic::fault::clear();
        assert!(result.is_err());
        assert_eq!(fs::read(&target).unwrap(), b"old markdown");
        assert_eq!(fs::read(base.join("old.png")).unwrap(), b"old image");
        assert_eq!(fs::read_dir(base).unwrap().count(), 1);
    }
}
#[test]
fn docx_import_stages_resources_and_commits_markdown_last() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.docx");
    fs::write(&source, docx(Some(("word/media/image.png", &png())))).unwrap();
    let s = store();
    let read = select(&s, "a", &source, Purpose::ReadDocx);
    let write = select(&s, "a", &dir.path().join("result.md"), Purpose::Markdown);
    let op = s
        .begin(
            "a",
            &[
                (&read.token, Purpose::ReadDocx),
                (&write.token, Purpose::Markdown),
            ],
        )
        .unwrap();
    let markdown = import_docx(
        &op,
        Path::new("fake"),
        &FakeRunner {
            fail: false,
            image: Some("media/image.png".into()),
        },
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&write.path).unwrap(), markdown);
    let relative = markdown
        .split("![image](")
        .nth(1)
        .unwrap()
        .split(')')
        .next()
        .unwrap();
    assert_eq!(fs::read(dir.path().join(relative)).unwrap(), png());
}
#[test]
fn pdf_failure_timeout_cancel_and_invalid_output_drop_renderer_resources() {
    for mode in 0..5 {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("old.pdf");
        fs::write(&target, b"old pdf").unwrap();
        let s = store();
        let lease = select(&s, "a", &target, Purpose::Pdf);
        let mut op = begin(&s, &lease, Purpose::Pdf);
        let destroyed = Arc::new(AtomicUsize::new(0));
        let cleanup = destroyed.clone();
        let mut temporary = None;
        let result = export_pdf(&op, |output| {
            temporary = Some(output.to_path_buf());
            let _cleanup = Cleanup::new(move || {
                cleanup.fetch_add(1, Ordering::SeqCst);
            });
            fs::write(output, b"partial PDF").unwrap();
            match mode {
                0 => Err("print failed".into()),
                1 => Err("timeout".into()),
                2 => {
                    s.close("a");
                    Ok(())
                }
                3 => {
                    s.release("a", &lease.token);
                    Ok(())
                }
                _ => Ok(()),
            }
        });
        assert!(result.is_err());
        assert_eq!(destroyed.load(Ordering::SeqCst), 1);
        assert!(!temporary.unwrap().exists());
        assert_eq!(fs::read(target).unwrap(), b"old pdf");
        op.deadline = std::time::Instant::now() - std::time::Duration::from_secs(1);
        assert!(op.check().is_err());
    }
}
#[test]
fn pdf_valid_output_commits_and_csp_blocks_local_resources_without_css_changes() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let lease = select(&s, "a", &dir.path().join("valid.pdf"), Purpose::Pdf);
    export_pdf(&begin(&s, &lease, Purpose::Pdf), |output| {
        fs::write(output, b"%PDF-1.7\nminimal\n%%EOF\n").map_err(|e| e.to_string())
    })
    .unwrap();
    validate_pdf(&fs::read(lease.path).unwrap()).unwrap();
    let html = "<!doctype html><style>@page{size:A4}</style><h1>hello</h1>";
    let secured = print_html(html).unwrap();
    assert!(secured.ends_with(html));
    assert!(secured.starts_with("<!doctype html><meta http-equiv=\"Content-Security-Policy\""));
    assert!(secured.contains("script-src 'none'"));
}

#[test]
fn real_pandoc_docx_round_trip_with_embedded_and_authorized_local_images() {
    let Some(exe) = crate::commands::conversion::find_pandoc_path() else {
        eprintln!("UNVERIFIED: Pandoc unavailable; native Fake tests still run");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let target = dir.path().join("real.docx");
    let lease = select(&s, "a", &target, Purpose::Docx);
    export_docx(
        &begin(&s, &lease, Purpose::Docx),
        "# 实际 Word 转换\n\n![pixel](pixel.png)\n\nhello",
        &exe,
        &NativeRunner,
        |name| {
            assert_eq!(name, "pixel.png");
            Ok(png())
        },
    )
    .unwrap();
    let source = select(&s, "a", &target, Purpose::ReadDocx);
    let output = select(&s, "a", &dir.path().join("real.md"), Purpose::Markdown);
    let op = s
        .begin(
            "a",
            &[
                (&source.token, Purpose::ReadDocx),
                (&output.token, Purpose::Markdown),
            ],
        )
        .unwrap();
    let markdown = import_docx(&op, &exe, &NativeRunner).unwrap();
    assert!(markdown.contains("实际 Word 转换"));
    assert!(markdown.contains("real.assets/import-"));
    assert!(markdown.contains("hello"));
    let media: Vec<_> = fs::read_dir(dir.path().join("real.assets"))
        .unwrap()
        .collect();
    assert_eq!(media.len(), 1);
}

#[test]
fn real_child_process_timeout_is_killed_and_reaped() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let lease = select(&s, "a", &dir.path().join("out.docx"), Purpose::Docx);
    let mut op = begin(&s, &lease, Purpose::Docx);
    op.deadline = std::time::Instant::now() + std::time::Duration::from_millis(150);
    #[cfg(windows)]
    let mut cmd = {
        let mut c = pandoc_command("powershell");
        c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sleep");
        c.arg("30");
        c
    };
    let start = std::time::Instant::now();
    let result = NativeRunner.run(&mut cmd, &op, dir.path());
    assert!(result.unwrap_err().contains("超时"));
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn word_local_images_require_the_real_document_scope() {
    let Some(exe) = crate::commands::conversion::find_pandoc_path() else {
        eprintln!("UNVERIFIED: Pandoc unavailable; image FileService tests still run separately");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let document_dir = root.join("docs");
    fs::create_dir(&document_dir).unwrap();
    let document = document_dir.join("source.md");
    fs::write(&document, "# source").unwrap();
    let outside = root.join("private.png");
    fs::write(&outside, png()).unwrap();
    let mut files = crate::files::FileService::default();
    files.set_owner("a");
    let opened = files.open_selected(document, None).unwrap();
    let token = opened.metadata.token;
    let s = store();
    let target = root.join("out.docx");
    let lease = select(&s, "a", &target, Purpose::Docx);
    let error = export_docx(
        &begin(&s, &lease, Purpose::Docx),
        &format!(
            "![private]({})",
            outside.to_string_lossy().replace('\\', "/")
        ),
        &exe,
        &NativeRunner,
        |relative| {
            files
                .markdown_image(&token, relative, &[], true)
                .map_err(|e| e.to_string())
        },
    )
    .unwrap_err();
    assert!(error.contains("授权") || error.contains("范围"));
    assert!(!target.exists());
    files.set_owner("b");
    assert!(files.markdown_image(&token, "local.png", &[], true).is_err());
}

#[test]
fn two_windows_cannot_convert_to_the_same_target_concurrently() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let path = dir.path().join("shared.html");
    let a = select(&s, "a", &path, Purpose::Html);
    let b = select(&s, "b", &path, Purpose::Html);
    let op = begin(&s, &a, Purpose::Html);
    assert!(s
        .begin("b", &[(&b.token, Purpose::Html)])
        .err()
        .unwrap()
        .contains("目标"));
    save_binary(&op, b"a").unwrap();
    drop(op);
    let op_b = s.begin("b", &[(&b.token, Purpose::Html)]).unwrap();
    assert!(save_binary(&op_b, b"b").is_err());
    assert_eq!(fs::read(path).unwrap(), b"a");
}

#[test]
fn closing_marks_owner_dead_before_waiting_for_an_existing_commit() {
    let dir = tempfile::tempdir().unwrap();
    let s = store();
    let lease = select(&s, "a", &dir.path().join("out.html"), Purpose::Html);
    let op = begin(&s, &lease, Purpose::Html);
    let owner = op.leases[0].owner.clone();
    let held = owner.commit.lock().unwrap();
    let closing = s.clone();
    let thread = std::thread::spawn(move || closing.close("a"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while owner.alive.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
        std::thread::yield_now();
    }
    let denied = op.check().is_err();
    drop(held);
    thread.join().unwrap();
    assert!(denied);
}
