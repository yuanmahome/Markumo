use super::*;
fn cancel() -> AtomicBool {
    AtomicBool::new(false)
}
fn body(session: &mut Session) -> String {
    session
        .window(session.revision(), 0, WINDOW_BYTES)
        .unwrap()
        .text
}

#[test]
fn disk_backed_utf8_bom_mixed_endings_history_recovery_and_save_copy() {
    let workspace = tempfile::tempdir().unwrap();
    let source = workspace.path().join("source.txt");
    let original = "中文😀\r\nsecond\rthird\nfourth";
    fs::write(
        &source,
        [b"\xef\xbb\xbf".as_slice(), original.as_bytes()].concat(),
    )
    .unwrap();
    let mut doc = Session::open(&source, workspace.path(), &cancel()).unwrap();
    assert_eq!(body(&mut doc), original);
    doc.edit(
        0,
        &[Edit {
            from: 6,
            to: 10,
            insert: "组合e\u{301}",
        }],
    )
    .unwrap();
    let edited = original.replacen("😀", "组合e\u{301}", 1);
    assert_eq!(body(&mut doc), edited);
    assert!(doc
        .edit(
            0,
            &[Edit {
                from: 0,
                to: 0,
                insert: "stale"
            }]
        )
        .is_err());
    assert!(doc
        .edit(
            1,
            &[Edit {
                from: 1,
                to: 2,
                insert: "split scalar"
            }]
        )
        .is_err());
    doc.undo(1).unwrap();
    assert_eq!(body(&mut doc), original);
    doc.redo(2).unwrap();
    assert_eq!(body(&mut doc), edited);
    doc.checkpoint(&cancel()).unwrap();
    let directory = doc.directory().to_path_buf();
    drop(doc);
    let mut restored = Session::restore(&directory, &cancel()).unwrap();
    assert_eq!(restored.revision(), 3);
    assert!(restored.can_undo());
    assert_eq!(body(&mut restored), edited);
    let output = workspace.path().join("saved.txt");
    restored.save_copy(&output, 3, &cancel()).unwrap();
    assert_eq!(
        fs::read(&output).unwrap(),
        [b"\xef\xbb\xbf".as_slice(), edited.as_bytes()].concat()
    );
    assert!(restored.save_copy(&source, 3, &cancel()).is_err());
    fs::write(&source, "external replacement").unwrap();
    assert!(restored.external_changed(&cancel()).unwrap());
    assert_eq!(body(&mut restored), edited);
    restored.undo(3).unwrap();
    assert_eq!(body(&mut restored), original);
    restored.discard().unwrap();
    assert!(!directory.exists());
}
#[test]
fn seeded_avl_differential_edits_and_all_undo_roots() {
    let workspace = tempfile::tempdir().unwrap();
    let source = workspace.path().join("differential.txt");
    fs::write(&source, "开始\r\nEnd😀").unwrap();
    let mut doc = Session::open(&source, workspace.path(), &cancel()).unwrap();
    let mut models = vec!["开始\r\nEnd😀".to_string()];
    let mut random = 0x12345678u64;
    for i in 0..2000 {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let model = models.last().unwrap();
        let positions = model
            .char_indices()
            .map(|(i, _)| i)
            .chain(std::iter::once(model.len()))
            .collect::<Vec<_>>();
        let a = random as usize % positions.len();
        let b = (random >> 32) as usize % positions.len();
        let from = positions[a.min(b)];
        let to = positions[a.max(b)];
        let insert = ["中😀", "\r\n", "e\u{301}", "", "line\rnext\n"][i % 5];
        let next = format!("{}{}{}", &model[..from], insert, &model[to..]);
        doc.edit(
            doc.revision(),
            &[Edit {
                from: from as u64,
                to: to as u64,
                insert,
            }],
        )
        .unwrap();
        assert_eq!(body(&mut doc), next, "iteration {i}");
        pieces::validate(doc.tree());
        models.push(next);
    }
    for expected in models[..models.len() - 1].iter().rev() {
        doc.undo(doc.revision()).unwrap();
        assert_eq!(&body(&mut doc), expected);
    }
    for expected in &models[1..] {
        doc.redo(doc.revision()).unwrap();
        assert_eq!(&body(&mut doc), expected);
    }
    doc.discard().unwrap();
}
#[test]
fn append_only_avl_remains_balanced_and_window_is_bounded() {
    let mut root = None;
    for i in 0..20000 {
        root = pieces::join(
            root,
            pieces::leaf(Span {
                store: Store::Added,
                offset: i,
                len: 1,
            }),
        );
    }
    let (len, height) = pieces::validate(&root);
    assert_eq!(len, 20000);
    assert!(height < 24);
    for i in (0..20000).step_by(197) {
        let (a, b) = pieces::split(&root, i);
        pieces::validate(&a);
        pieces::validate(&b);
        assert_eq!(pieces::len(&a) + pieces::len(&b), 20000);
    }
}
#[test]
fn unsupported_encoding_cancel_invalid_batch_and_corrupt_recovery_are_safe() {
    let workspace = tempfile::tempdir().unwrap();
    let source = workspace.path().join("source.txt");
    fs::write(&source, [0xff, 0xfe, 0x41, 0x00]).unwrap();
    assert!(Session::open(&source, workspace.path(), &cancel()).is_err());
    fs::write(&source, "中文😀\r\nvalid").unwrap();
    assert!(Session::open(&source, workspace.path(), &AtomicBool::new(true)).is_err());
    let mut doc = Session::open(&source, workspace.path(), &cancel()).unwrap();
    assert!(doc
        .edit(
            0,
            &[
                Edit {
                    from: 0,
                    to: 0,
                    insert: "good"
                },
                Edit {
                    from: 1,
                    to: 2,
                    insert: "bad"
                }
            ]
        )
        .is_err());
    assert_eq!(doc.revision(), 0);
    let out = workspace.path().join("cancelled.txt");
    assert!(doc.save_copy(&out, 0, &AtomicBool::new(true)).is_err());
    assert!(!out.exists());
    doc.edit(
        0,
        &[Edit {
            from: 0,
            to: 0,
            insert: "durable",
        }],
    )
    .unwrap();
    doc.checkpoint(&cancel()).unwrap();
    let dir = doc.directory().to_path_buf();
    doc.edit(
        1,
        &[Edit {
            from: 0,
            to: 0,
            insert: "not checkpointed",
        }],
    )
    .unwrap();
    drop(doc);
    let mut restored = Session::restore(&dir, &cancel()).unwrap();
    assert!(body(&mut restored).starts_with("durable中文"));
    restored.checkpoint(&cancel()).unwrap();
    drop(restored);
    let mut base = OpenOptions::new()
        .write(true)
        .open(dir.join("base"))
        .unwrap();
    base.write_all(b"X").unwrap();
    drop(base);
    assert!(Session::restore(&dir, &cancel()).is_err());
    assert!(dir.join("checkpoint.json").exists());
}
#[test]
fn real_100_mib_file_edit_stream_save_reopen_and_external_baseline() {
    let workspace = tempfile::tempdir().unwrap();
    let source = workspace.path().join("100m.txt");
    let mut file = File::create(&source).unwrap();
    let block = b"0123456789abcdef\r\n".repeat(4096);
    let length = 100u64 * 1024 * 1024;
    let mut left = length;
    while left > 0 {
        let n = (left as usize).min(block.len());
        file.write_all(&block[..n]).unwrap();
        left -= n as u64;
    }
    drop(file);
    let mut doc = Session::open(&source, workspace.path(), &cancel()).unwrap();
    assert_eq!(doc.byte_length(), length);
    for at in [0, length / 2, length - 10] {
        let win = doc.window(doc.revision(), at, IO_BYTES).unwrap();
        assert!(win.text.len() <= IO_BYTES);
        doc.edit(
            doc.revision(),
            &[Edit {
                from: at,
                to: at,
                insert: "中😀\r\n",
            }],
        )
        .unwrap();
    }
    assert!(doc.window(doc.revision(), 0, WINDOW_BYTES + 1).is_err());
    let output = workspace.path().join("saved.txt");
    doc.save_copy(&output, doc.revision(), &cancel()).unwrap();
    assert_eq!(
        fs::metadata(&output).unwrap().len(),
        length + 3 * "中😀\r\n".len() as u64
    );
    let mut reopened = Session::open(&output, workspace.path(), &cancel()).unwrap();
    assert!(body(&mut reopened).starts_with("中😀\r\n012345"));
    assert_eq!(doc.byte_length(), reopened.byte_length());
    assert!(!doc.external_changed(&cancel()).unwrap());
    doc.checkpoint(&cancel()).unwrap();
    let directory = doc.directory().to_path_buf();
    let rev = doc.revision();
    drop(doc);
    let mut restored = Session::restore(&directory, &cancel()).unwrap();
    assert_eq!(restored.revision(), rev);
    let copy = workspace.path().join("recovered.txt");
    restored.save_copy(&copy, rev, &cancel()).unwrap();
    assert_eq!(
        file_hash(&copy, &cancel()).unwrap(),
        file_hash(&output, &cancel()).unwrap()
    );
    reopened.discard().unwrap();
    restored.discard().unwrap();
}

#[test]
fn stream_search_replace_chunk_boundaries_unicode_and_undo() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join("search.txt");
    let source = format!(
        "{}中文😀\r\nabababax aba 中😀tail",
        "x".repeat(IO_BYTES - 2)
    );
    fs::write(&path, &source).unwrap();
    let mut doc = Session::open(&path, workspace.path(), &cancel()).unwrap();
    for query in ["中文😀", "aba", "abax", "中😀", "xxx", "x中", "tail"] {
        let found = doc
            .search(doc.revision(), query, 0, 1024, &cancel())
            .unwrap();
        assert_eq!(found.count, source.matches(query).count() as u64);
        for (a, b) in found.matches {
            assert_eq!(&source[a as usize..b as usize], query);
        }
        let revision = doc.revision();
        doc.replace_all(revision, query, "换e\u{301}\r\n", &cancel())
            .unwrap();
        assert_eq!(body(&mut doc), source.replace(query, "换e\u{301}\r\n"));
        doc.undo(doc.revision()).unwrap();
        assert_eq!(body(&mut doc), source);
    }
    let revision = doc.revision();
    assert!(doc
        .replace_all(revision, "x", "z", &AtomicBool::new(true))
        .is_err());
    assert_eq!(doc.revision(), revision);
    assert_eq!(body(&mut doc), source);
    assert!(doc.search(revision, "", 0, 1, &cancel()).is_err());
    assert!(doc.search(revision, "x", 0, 1025, &cancel()).is_err());
    doc.discard().unwrap();
}

#[test]
fn expanding_replace_budget_and_stale_checkpoint_leave_text_and_previous_checkpoint_intact() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tiny.txt");
    fs::write(&path, "x".repeat(64)).unwrap();
    let mut doc = Session::open(&path, root.path(), &cancel()).unwrap();
    doc.checkpoint(&cancel()).unwrap();
    let directory = doc.directory().to_path_buf();
    assert!(doc
        .replace_all(0, "x", &"z".repeat(1024 * 1024), &cancel())
        .is_err());
    assert_eq!(doc.revision(), 0);
    assert_eq!(body(&mut doc), "x".repeat(64));
    assert!(doc.checkpoint_at(1, &cancel()).is_err());
    drop(doc);
    let mut restored = Session::restore(&directory, &cancel()).unwrap();
    assert_eq!(body(&mut restored), "x".repeat(64));
    restored.discard().unwrap();
}

#[test]
fn background_cancel_does_not_commit_partial_replace_or_keep_task_files() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("cancel.txt");
    fs::write(&source, "a".repeat(8 * 1024 * 1024)).unwrap();
    let mut doc = Session::open(&source, root.path(), &cancel()).unwrap();
    let flag = AtomicBool::new(false);
    std::thread::scope(|scope| {
        scope.spawn(|| {
            std::thread::sleep(std::time::Duration::from_millis(3));
            flag.store(true, Ordering::Relaxed);
        });
        let error = doc.replace_all(0, "aa", "xyz", &flag).unwrap_err();
        assert!(error.to_string().contains("任务已取消"));
    });
    assert_eq!(doc.revision(), 0);
    assert_eq!(doc.byte_length(), 8 * 1024 * 1024);
    assert_eq!(doc.added.metadata().unwrap().len(), 0);
    assert_eq!(fs::read_dir(doc.directory()).unwrap().count(), 2);
    doc.discard().unwrap();
}

#[test]
fn sparse_line_index_crlf_unicode_columns_rebuild_after_edit_and_history() {
    let workspace = tempfile::tempdir().unwrap();
    let path = workspace.path().join("lines.txt");
    let source = format!(
        "中😀e\u{301}\r\nsecond\rthird\nfourth\r\n{}end",
        "中😀\r\n".repeat(200000)
    );
    fs::write(&path, &source).unwrap();
    let mut doc = Session::open(&path, workspace.path(), &cancel()).unwrap();
    let mut starts = vec![0];
    let bytes = source.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'\r' {
            at += 1;
            if bytes.get(at) == Some(&b'\n') {
                at += 1;
            }
            starts.push(at as u64);
        } else if bytes[at] == b'\n' {
            at += 1;
            starts.push(at as u64);
        } else {
            at += 1;
        }
    }
    for i in (0..starts.len())
        .step_by(5000)
        .chain([0, 1, 2, 3, starts.len() - 1])
    {
        let found = doc.line_start(0, i as u64 + 1, &cancel()).unwrap();
        assert_eq!(found, starts[i]);
        let point = doc.position(0, found, &cancel()).unwrap();
        assert_eq!((point.line, point.column), (i as u64 + 1, 1));
    }
    let position = doc
        .position(0, "中😀e\u{301}".len() as u64, &cancel())
        .unwrap();
    assert_eq!((position.line, position.column), (1, 6));
    assert!(doc.index.as_ref().unwrap().points.len() as u64 <= line_index::MAX_POINTS + 2);
    assert!(doc.position(0, 1, &cancel()).is_err());
    let cr = "中😀e\u{301}".len() as u64;
    let window = doc.window(0, cr + 1, 64).unwrap();
    assert_eq!(window.start_byte, cr + 2);
    assert!(!window.text.starts_with('\n'));
    doc.edit(
        0,
        &[Edit {
            from: 0,
            to: 0,
            insert: "new\n",
        }],
    )
    .unwrap();
    assert!(doc.index.is_none());
    assert_eq!(doc.line_start(1, 2, &cancel()).unwrap(), 4);
    doc.undo(1).unwrap();
    assert_eq!(doc.line_start(2, 2, &cancel()).unwrap(), starts[1]);
    doc.discard().unwrap();
}
