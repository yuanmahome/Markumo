use super::*;
use std::io::{Cursor, Write};
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
fn archive(parts: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (path, data) in parts {
        writer
            .start_file(
                path,
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        writer.write_all(&data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn xml(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}
fn rel(id: &str, kind: &str, target: &str, external: bool) -> String {
    format!(
        r#"<Relationship Id="{id}" Type="{R}/{kind}" Target="{target}"{}/ >"#,
        if external {
            r#" TargetMode="External""#
        } else {
            ""
        }
    )
    .replace("/ >", "/>")
}
fn parts(body: &str, relationships: &str, extra: Vec<(&str, Vec<u8>)>) -> Vec<(String, Vec<u8>)> {
    let mut out = vec![
        (
            "[Content_Types].xml".into(),
            xml(
                r#"<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/custom/main.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#,
            ),
        ),
        (
            "_rels/.rels".into(),
            xml(&format!(
                r#"<Relationships xmlns="{PKG}">{}</Relationships>"#,
                rel("root", "officeDocument", "custom/main.xml", false)
            )),
        ),
        (
            "custom/main.xml".into(),
            xml(&format!(
                r#"<w:document xmlns:w="{W}" xmlns:r="{R}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>{body}</w:body></w:document>"#
            )),
        ),
        (
            "custom/_rels/main.xml.rels".into(),
            xml(&format!(
                r#"<Relationships xmlns="{PKG}">{relationships}</Relationships>"#
            )),
        ),
    ];
    out.extend(extra.into_iter().map(|(p, b)| (p.into(), b)));
    out
}
fn doc(body: &str, relationships: &str, extra: Vec<(&str, Vec<u8>)>) -> NativeDocument {
    parse(&archive(parts(body, relationships, extra)), &|| Ok(())).unwrap()
}
fn md(d: &NativeDocument) -> String {
    markdown::serialize(d, "测试.assets/import-1").unwrap()
}
fn p(s: &str) -> String {
    format!("<w:p><w:r><w:t>{s}</w:t></w:r></w:p>")
}
#[test]
fn opc_relationships_namespaces_unicode_and_entities() {
    let bytes = archive(parts(
        &p("中文 English 😀 &amp; &#x1F680; &lt;tag&gt;"),
        "",
        vec![],
    ));
    let result = parse(&bytes, &|| Ok(())).unwrap();
    assert_eq!(result.stats.paragraphs, 1);
    assert!(md(&result).contains("中文 English 😀 & 🚀 \\<tag\\>"));
    let mut alternate = parts(&p("前缀无关"), "", vec![]);
    let s = String::from_utf8(alternate[2].1.clone())
        .unwrap()
        .replace("xmlns:w=", "xmlns:word=")
        .replace("w:", "word:");
    alternate[2].1 = xml(&s);
    assert!(md(&parse(&archive(alternate), &|| Ok(())).unwrap()).contains("前缀无关"));
}
#[test]
fn styles_inheritance_overrides_headings_and_character_styles() {
    let styles = format!(
        r#"<w:styles xmlns:w="{W}"><w:docDefaults><w:rPrDefault><w:rPr><w:b w:val="0"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:styleId="Base"><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/></w:rPr></w:style><w:style w:styleId="Child"><w:basedOn w:val="Base"/></w:style><w:style w:styleId="Em"><w:rPr><w:i/></w:rPr></w:style><w:style w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>"#
    );
    let body = r#"<w:p><w:pPr><w:pStyle w:val="Child"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Em"/></w:rPr><w:t>粗斜体 </w:t></w:r><w:r><w:rPr><w:b w:val="false"/><w:strike/></w:rPr><w:t>删除</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>"#;
    let d = doc(
        body,
        &rel("st", "styles", "styles.xml", false),
        vec![("custom/styles.xml", xml(&styles))],
    );
    let m = md(&d);
    assert!(m.contains("### ***粗斜体*** ~~删除~~"), "{m}");
    assert!(m.contains("# 标题"));
    assert_eq!(d.stats.headings, 2);
}
#[test]
fn style_cycles_fail_explicitly() {
    let styles = format!(
        r#"<w:styles xmlns:w="{W}"><w:style w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:styleId="B"><w:basedOn w:val="A"/></w:style></w:styles>"#
    );
    let body = r#"<w:p><w:pPr><w:pStyle w:val="A"/></w:pPr></w:p>"#;
    assert!(parse(
        &archive(parts(
            body,
            &rel("s", "styles", "s.xml", false),
            vec![("custom/s.xml", xml(&styles))]
        )),
        &|| Ok(())
    )
    .is_err());
}
#[test]
fn numbering_nested_lists_and_start_override() {
    let numbering = format!(
        r#"<w:numbering xmlns:w="{W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/></w:lvlOverride></w:num></w:numbering>"#
    );
    let item = |depth, text| {
        format!(
            r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="{depth}"/><w:numId w:val="7"/></w:numPr></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"#
        )
    };
    let body = [item(0, "第四"), item(1, "子项"), item(0, "第五")].join("");
    let d = doc(
        &body,
        &rel("n", "numbering", "n.xml", false),
        vec![("custom/n.xml", xml(&numbering))],
    );
    let m = md(&d);
    assert!(m.contains("4. 第四\n   \n   - 子项\n5. 第五"), "{m}");
    assert_eq!(d.stats.list_items, 3);
}
#[test]
fn native_writer_code_quote_rule_and_literal_markdown() {
    let body = r#"<w:p><w:pPr><w:shd w:fill="F6F8FA"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>let x = 1;</w:t><w:br/><w:tab/><w:t>中文😀</w:t></w:r></w:p><w:p><w:pPr><w:pBdr><w:left/></w:pBdr></w:pPr><w:r><w:t>引用</w:t></w:r></w:p><w:p><w:pPr><w:pBdr><w:bottom/></w:pBdr></w:pPr></w:p>"#;
    let d = doc(&format!("{body}{}", p("- 1. $x$ ~~literal~~")), "", vec![]);
    let m = md(&d);
    assert!(m.contains("```\nlet x = 1;\n\t中文😀\n```"), "{m}");
    assert!(m.contains("> 引用"));
    assert!(m.contains("\n---\n"));
    assert!(m.contains("\\- 1\\. \\$x\\$"));
}
#[test]
fn hyperlinks_relative_external_and_dangerous_schemes() {
    let body = r#"<w:p><w:hyperlink r:id="good"><w:r><w:t>链接</w:t></w:r></w:hyperlink><w:hyperlink r:id="relative"><w:r><w:t>相对</w:t></w:r></w:hyperlink><w:hyperlink r:id="bad"><w:r><w:t>危险文字</w:t></w:r></w:hyperlink></w:p>"#;
    let rels = rel(
        "good",
        "hyperlink",
        "https://example.com/a?q=1&amp;b=2",
        true,
    ) + &rel("relative", "hyperlink", "../a.md", true)
        + &rel("bad", "hyperlink", "javascript:alert(1)", true);
    let d = doc(body, &rels, vec![]);
    let m = md(&d);
    assert!(m.contains("https://example.com/a?q=1&b=2"));
    assert!(m.contains("../a.md"));
    assert!(!m.contains("javascript:"));
    assert!(m.contains("危险文字"));
    assert!(d.warnings.iter().any(|w| w.kind == "link"));
}
#[test]
fn embedded_images_extract_once_and_preserve_aspect() {
    let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    png.extend(600u32.to_be_bytes());
    png.extend(240u32.to_be_bytes());
    png.extend([8, 2, 0, 0, 0]);
    let image = r#"<w:p><w:r><w:drawing><wp:inline><wp:extent cx="2857500"/><wp:docPr descr="示例 &amp; image"/><a:blip r:embed="pic"/></wp:inline></w:drawing></w:r></w:p>"#;
    let d = doc(
        &(image.to_owned() + image),
        &rel("pic", "image", "media/pic.png", false),
        vec![("custom/media/pic.png", png.clone())],
    );
    assert_eq!(d.assets.len(), 1);
    assert_eq!(d.assets[0].1, png);
    assert_eq!(d.stats.images, 2);
    let m = md(&d);
    assert!(m.contains("width=\"300\" height=\"120\""), "{m}");
    assert!(m.contains("%E6%B5%8B%E8%AF%95.assets/import-1/image-1.png"));
}
#[test]
fn missing_and_external_images_are_diagnosed_without_network() {
    let image =
        |id| format!(r#"<w:p><w:r><w:drawing><a:blip r:embed="{id}"/></w:drawing></w:r></w:p>"#);
    let d = doc(
        &(image("missing") + &image("remote")),
        &rel(
            "remote",
            "image",
            "https://127.0.0.1:1/no-download.png",
            true,
        ),
        vec![],
    );
    assert!(d.assets.is_empty());
    assert!(md(&d).contains("缺失图片"));
    assert!(d
        .warnings
        .iter()
        .any(|w| w.message.contains("没有自动下载")));
}
#[test]
fn simple_table_alignment_and_complex_merged_nested_html() {
    let cell = |s| format!("<w:tc>{}</w:tc>", p(s));
    let simple = format!(
        "<w:tbl><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>",
        cell("A"),
        cell("B"),
        cell("中文"),
        cell("😀")
    );
    let d = doc(&simple, "", vec![]);
    assert!(md(&d).contains("| A | B |\n| :--- | :--- |"));
    let complex = format!(
        r#"<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge w:val="restart"/></w:tcPr>{}</w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr>{simple}</w:tc></w:tr></w:tbl>"#,
        p("合并")
    );
    let d = doc(&complex, "", vec![]);
    let m = md(&d);
    assert!(m.contains("colspan=\"2\" rowspan=\"2\""), "{m}");
    assert_eq!(m.matches("<table>").count(), 2);
    assert!(d.warnings.iter().any(|w| w.kind == "table"));
}
#[test]
fn footnotes_endnotes_math_headers_and_revisions_preserve_content() {
    let body = r#"<w:p><w:r><w:t>正文</w:t><w:footnoteReference w:id="1"/><w:endnoteReference w:id="2"/></w:r><m:oMath><m:r><m:t>x+y</m:t></m:r></m:oMath><w:del><w:r><w:delText>删掉的文字</w:delText></w:r></w:del></w:p>"#;
    let notes = format!(
        r#"<w:footnotes xmlns:w="{W}"><w:footnote w:type="separator" w:id="0"/><w:footnote w:id="1">{}</w:footnote></w:footnotes>"#,
        p("脚注😀")
    );
    let end = format!(
        r#"<w:endnotes xmlns:w="{W}"><w:endnote w:id="2">{}</w:endnote></w:endnotes>"#,
        p("尾注")
    );
    let header = format!(r#"<w:hdr xmlns:w="{W}">{}</w:hdr>"#, p("页眉文字"));
    let rels = rel("f", "footnotes", "f.xml", false)
        + &rel("e", "endnotes", "e.xml", false)
        + &rel("h", "header", "h.xml", false);
    let d = doc(
        body,
        &rels,
        vec![
            ("custom/f.xml", xml(&notes)),
            ("custom/e.xml", xml(&end)),
            ("custom/h.xml", xml(&header)),
        ],
    );
    let m = md(&d);
    for s in [
        "[^fn1]",
        "[^en2]",
        "脚注😀",
        "尾注",
        "x\\+y",
        "删掉的文字",
        "页眉文字",
    ] {
        assert!(m.contains(s), "{s}: {m}");
    }
    for kind in ["math", "revision", "layout"] {
        assert!(d.warnings.iter().any(|w| w.kind == kind));
    }
}
#[test]
fn smartart_preserves_relationship_text() {
    let body = r#"<w:p><w:r><w:drawing><a:graphic><a:graphicData r:dm="d"/></a:graphic></w:drawing></w:r></w:p>"#;
    let data = r#"<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>SmartArt 文字</a:t></a:graphic>"#;
    let d = doc(
        body,
        &rel("d", "diagramData", "data.xml", false),
        vec![("custom/data.xml", xml(data))],
    );
    assert!(md(&d).contains("SmartArt 文字"));
    assert!(d.warnings.iter().any(|w| w.kind == "object"));
}
#[test]
fn malformed_encrypted_truncated_and_wrong_office_types_fail() {
    for bytes in [
        Vec::new(),
        b"not a zip".to_vec(),
        vec![0xd0, 0xcf, 0x11, 0xe0],
    ] {
        assert!(parse(&bytes, &|| Ok(())).is_err());
    }
    let b = archive(parts(&p("ok"), "", vec![]));
    assert!(parse(&b[..b.len() / 2], &|| Ok(())).is_err());
    let mut all = parts("", "", vec![]);
    all[0].1 = xml(&String::from_utf8(all[0].1.clone()).unwrap().replace(
        "wordprocessingml.document.main+xml",
        "ms-word.document.macroEnabled.main+xml",
    ));
    assert!(parse(&archive(all), &|| Ok(())).is_err());
}
#[test]
fn zip_slip_duplicates_and_resource_limits_fail() {
    for name in [
        "../outside",
        "C:/evil",
        "evil\\file",
        "aux.txt",
        "a/../evil",
    ] {
        let mut all = parts("", "", vec![]);
        all.push((name.into(), vec![1]));
        assert!(parse(&archive(all), &|| Ok(())).is_err(), "{name}");
    }
    let mut duplicate = parts("", "", vec![]);
    duplicate.push(("CUSTOM/MAIN.XML".into(), vec![]));
    assert!(parse(&archive(duplicate), &|| Ok(())).is_err());
    let mut bomb = parts("", "", vec![]);
    bomb.push(("huge.bin".into(), vec![0; 16 * 1024 * 1024 + 1]));
    assert!(parse(&archive(bomb), &|| Ok(())).is_err());
    let entries = (0..4097).map(|n| (format!("x{n}"), vec![])).collect();
    assert!(Package::read(&archive(entries), &|| Ok(())).is_err());
}
#[test]
fn opc_traversal_and_duplicate_relationships_fail() {
    for target in [
        "../../outside.xml",
        "%2e%2e/%2e%2e/outside",
        "file:///C:/outside.xml",
        "a%5cb",
        "http://evil/x",
        "%xx",
    ] {
        assert!(
            package::resolve("custom/main.xml", target).is_err(),
            "{target}"
        );
    }
    assert_eq!(
        package::resolve("custom/main.xml", "../media/a%20b.png").unwrap(),
        "media/a b.png"
    );
    let rels = rel("same", "image", "a.png", false) + &rel("same", "image", "b.png", false);
    assert!(parse(&archive(parts("", &rels, vec![])), &|| Ok(())).is_err());
    assert!(parse(
        &archive(parts(
            "",
            &rel("s", "styles", "https://example.com/styles.xml", true),
            vec![]
        )),
        &|| Ok(())
    )
    .is_err());
}
#[test]
fn xml_entities_depth_size_nodes_and_cancellation_are_bounded() {
    for input in [
        "<!DOCTYPE root [<!ENTITY x SYSTEM 'file:///C:/secret'>]><root>&x;</root>",
        "<root>&undefined;</root>",
        "<root><x></root>",
    ] {
        assert!(xml::parse(input.as_bytes(), &|| Ok(()), &mut 0).is_err());
    }
    let deep = format!("{}{}", "<x>".repeat(100), "</x>".repeat(100));
    assert!(xml::parse(deep.as_bytes(), &|| Ok(()), &mut 0).is_err());
    assert!(xml::parse(&vec![b' '; 8 * 1024 * 1024 + 1], &|| Ok(()), &mut 0).is_err());
    let many = format!("<root>{}</root>", "<x/>".repeat(250_001));
    assert!(xml::parse(many.as_bytes(), &|| Ok(()), &mut 0).is_err());
    let bytes = archive(parts(&p("test"), "", vec![]));
    let count = std::cell::Cell::new(0);
    let result = parse(&bytes, &|| {
        let n = count.get() + 1;
        count.set(n);
        if n > 5 {
            Err("cancelled".into())
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert_eq!(count.get(), 6);
}
#[test]
fn large_document_semantics_are_not_flattened() {
    let body = (0..5000)
        .map(|i| p(&format!("第{i}段 中文 English 😀")))
        .collect::<String>();
    let d = doc(&body, "", vec![]);
    assert_eq!(d.stats.paragraphs, 5000);
    assert!(md(&d).contains("第4999段"));
}
#[test]
fn import_existing_real_fixture_when_requested() {
    let Ok(directory) = std::env::var("MARKUMO_DOCX_FIXTURES") else {
        return;
    };
    for entry in std::fs::read_dir(&directory).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|s| s != "docx") {
            continue;
        }
        let started = std::time::Instant::now();
        let d = parse(&std::fs::read(&path).unwrap(), &|| Ok(())).unwrap();
        let assets = path.with_extension("imported.assets");
        let content =
            markdown::serialize(&d, assets.file_name().unwrap().to_str().unwrap()).unwrap();
        std::fs::write(path.with_extension("imported.md"), content).unwrap();
        std::fs::create_dir_all(&assets).unwrap();
        for (name, bytes) in &d.assets {
            std::fs::write(assets.join(name), bytes).unwrap();
        }
        println!(
            "{}: {} ms; stats={}; warnings={}",
            path.display(),
            started.elapsed().as_millis(),
            serde_json::to_string(&d.stats).unwrap(),
            serde_json::to_string(&d.warnings).unwrap()
        );
    }
}

#[test]
fn nesting_keeps_depth_across_distinct_word_numbering_instances() {
    let item = |id: &str, depth: u8, text: &str| Item {
        block: Block::Paragraph(vec![Inline::Text(text.into(), Format::default())]),
        list: Some((id.into(), depth, true, 1)),
    };
    let blocks = grouped(vec![
        item("outer", 0, "父项"),
        item("inner", 1, "子项"),
        item("outer", 0, "下一项"),
    ]);
    assert_eq!(blocks.len(), 1);
    let Block::List { items, .. } = &blocks[0] else {
        panic!("expected outer list")
    };
    assert_eq!(items.len(), 2);
    assert!(matches!(&items[0].blocks[1], Block::List { .. }));
}

#[test]
fn invalid_note_labels_and_duplicate_semantic_parts_are_rejected() {
    let body = r#"<w:p><w:r><w:footnoteReference w:id="bad]label"/></w:r></w:p>"#;
    assert!(parse(&archive(parts(body, "", vec![])), &|| Ok(())).is_err());
    let styles = format!(r#"<w:styles xmlns:w="{W}"/>"#);
    let rels = rel("s1", "styles", "s.xml", false) + &rel("s2", "styles", "s.xml", false);
    assert!(parse(
        &archive(parts("", &rels, vec![("custom/s.xml", xml(&styles))])),
        &|| Ok(())
    )
    .is_err());
}
#[test]
fn differing_table_cell_alignment_uses_html_without_losing_alignment() {
    let cell = |align, text| {
        format!(
            r#"<w:tc><w:p><w:pPr><w:jc w:val="{align}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>"#
        )
    };
    let body = format!(
        "<w:tbl><w:tr>{}</w:tr><w:tr>{}</w:tr></w:tbl>",
        cell("left", "head"),
        cell("right", "body")
    );
    let m = md(&doc(&body, "", vec![]));
    assert!(m.contains("text-align:left"));
    assert!(m.contains("text-align:right"));
}
