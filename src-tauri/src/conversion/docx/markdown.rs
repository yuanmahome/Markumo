use super::{
    super::{Result, MAX_TEXT},
    ast::*,
};

fn text(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        if "\\`*_{}[]<>#|!+-=.~$".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}
fn html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
fn code(value: &str) -> String {
    let n = value.split(|c| c != '`').map(str::len).max().unwrap_or(0) + 1;
    let fence = "`".repeat(n);
    let pad = if value.starts_with(['`', ' ']) || value.ends_with(['`', ' ']) {
        " "
    } else {
        ""
    };
    format!("{fence}{pad}{value}{pad}{fence}")
}
pub fn uri_path(value: &str) -> String {
    value
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"/-_.~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn destination(value: &str) -> String {
    value
        .replace(' ', "%20")
        .replace('<', "%3C")
        .replace('>', "%3E")
        .replace('|', "%7C")
        .replace('\\', "%5C")
        .replace('\n', "%0A")
        .replace('\r', "%0D")
}
fn inlines(values: &[Inline], assets: &str, as_html: bool) -> String {
    let mut output = String::new();
    for value in values {
        let rendered = match value {
            Inline::Text(value, format) => {
                let trimmed = value.trim_matches(char::is_whitespace);
                let mut s = if as_html {
                    html(value)
                } else if format.code {
                    code(trimmed)
                } else {
                    text(trimmed)
                };
                if as_html {
                    for (on, tag) in [
                        (format.code, "code"),
                        (format.strike, "del"),
                        (format.italic, "em"),
                        (format.bold, "strong"),
                    ] {
                        if on {
                            s = format!("<{tag}>{s}</{tag}>");
                        }
                    }
                } else {
                    for (on, delimiter) in [
                        (format.strike, "~~"),
                        (format.italic, "*"),
                        (format.bold, "**"),
                    ] {
                        if on && !s.is_empty() {
                            s = format!("{delimiter}{s}{delimiter}");
                        }
                    }
                }
                if !as_html {
                    if trimmed.is_empty() {
                        s = value.clone();
                    } else {
                        let start =
                            value.len() - value.trim_start_matches(char::is_whitespace).len();
                        s = format!(
                            "{}{}{}",
                            &value[..start],
                            s,
                            &value[start + trimmed.len()..]
                        );
                    }
                }
                s
            }
            Inline::Break => {
                if as_html {
                    "<br>".into()
                } else {
                    "  \n".into()
                }
            }
            Inline::Tab => "&#9;".into(),
            Inline::Link { target, content } => {
                let body = inlines(content, assets, as_html);
                if as_html {
                    format!("<a href=\"{}\">{body}</a>", html(&destination(target)))
                } else {
                    format!("[{body}](<{}>)", destination(target))
                }
            }
            Inline::Image {
                asset,
                alt,
                width,
                height,
            } => {
                let src = if asset.starts_with("https://") || asset.starts_with("http://") {
                    asset.clone()
                } else {
                    uri_path(&format!("{assets}/{asset}"))
                };
                if as_html || width.is_some() || height.is_some() {
                    format!(
                        "<img src=\"{}\" alt=\"{}\"{}{}>",
                        html(&src),
                        html(alt),
                        width.map(|n| format!(" width=\"{n}\"")).unwrap_or_default(),
                        height
                            .map(|n| format!(" height=\"{n}\""))
                            .unwrap_or_default()
                    )
                } else {
                    format!("![{}](<{}>)", text(alt), src)
                }
            }
            Inline::Footnote(id) => {
                if as_html {
                    format!("<sup>[{}]</sup>", html(id))
                } else {
                    format!("[^{id}]")
                }
            }
            Inline::Unsupported(s) => {
                if as_html {
                    html(s)
                } else {
                    text(s)
                }
            }
        };
        output.push_str(&rendered);
    }
    output
}
fn cell_markdown(cell: &Cell, assets: &str) -> Option<String> {
    if cell.colspan != 1 || cell.rowspan != 1 || cell.continuation || cell.blocks.len() > 1 {
        return None;
    }
    match cell.blocks.first() {
        Some(Block::Paragraph(values))
            if !values
                .iter()
                .any(|v| matches!(v,Inline::Text(s,f) if f.code&&s.contains('|'))) =>
        {
            Some(
                inlines(values, assets, false)
                    .replace("  \n", "<br>")
                    .replace('\n', "<br>"),
            )
        }
        None => Some(String::new()),
        _ => None,
    }
}
fn blocks_html(blocks: &[Block], assets: &str) -> String {
    blocks
        .iter()
        .map(|b| match b {
            Block::Paragraph(v) => format!("<p>{}</p>", inlines(v, assets, true)),
            Block::Heading(level, v) => {
                format!("<h{level}>{}</h{level}>", inlines(v, assets, true))
            }
            Block::Code(s) => format!("<pre><code>{}</code></pre>", html(s)),
            Block::Quote(v) => format!("<blockquote>{}</blockquote>", blocks_html(v, assets)),
            Block::Rule => "<hr>".into(),
            Block::List {
                ordered,
                start,
                items,
            } => {
                let tag = if *ordered { "ol" } else { "ul" };
                format!(
                    "<{tag} start=\"{start}\">{}</{tag}>",
                    items
                        .iter()
                        .map(|i| format!("<li>{}</li>", blocks_html(&i.blocks, assets)))
                        .collect::<String>()
                )
            }
            Block::Table(rows) => table_html(rows, assets),
            Block::Unsupported(s) => format!("<p>{}</p>", html(s)),
        })
        .collect()
}
fn table_html(rows: &[Vec<Cell>], assets: &str) -> String {
    let mut s = String::from("<table>\n");
    for row in rows {
        s.push_str("<tr>");
        for cell in row.iter().filter(|c| !c.continuation) {
            let align = match cell.align.as_str() {
                "center" => "center",
                "right" => "right",
                _ => "left",
            };
            s.push_str(&format!(
                "<td colspan=\"{}\" rowspan=\"{}\" style=\"text-align:{align}\">{}</td>",
                cell.colspan,
                cell.rowspan,
                blocks_html(&cell.blocks, assets)
            ));
        }
        s.push_str("</tr>\n");
    }
    s.push_str("</table>");
    s
}
fn blocks(values: &[Block], assets: &str) -> String {
    values
        .iter()
        .map(|b| match b {
            Block::Paragraph(v) => inlines(v, assets, false),
            Block::Heading(level, v) => format!(
                "{} {}",
                "#".repeat(*level as usize),
                inlines(v, assets, false)
            ),
            Block::Quote(v) => blocks(v, assets)
                .lines()
                .map(|l| format!("> {l}"))
                .collect::<Vec<_>>()
                .join("\n"),
            Block::Code(s) => {
                let n = s
                    .split(|c| c != '`')
                    .map(str::len)
                    .max()
                    .unwrap_or(0)
                    .max(2)
                    + 1;
                let fence = "`".repeat(n);
                format!("{fence}\n{s}\n{fence}")
            }
            Block::Rule => "---".into(),
            Block::Unsupported(s) => text(s),
            Block::List {
                ordered,
                start,
                items,
            } => items
                .iter()
                .enumerate()
                .map(|(i, item)| {
                    let marker = if *ordered {
                        format!("{}. ", start.saturating_add(i as u32))
                    } else {
                        "- ".into()
                    };
                    let content = blocks(&item.blocks, assets);
                    let indent = " ".repeat(marker.len());
                    let mut lines = content.lines();
                    let first = lines.next().unwrap_or("");
                    format!(
                        "{marker}{first}{}",
                        lines.map(|l| format!("\n{indent}{l}")).collect::<String>()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Block::Table(rows) => {
                let simple = rows
                    .iter()
                    .map(|row| {
                        row.iter()
                            .map(|cell| cell_markdown(cell, assets))
                            .collect::<Option<Vec<_>>>()
                    })
                    .collect::<Option<Vec<_>>>();
                if let Some(cells) = simple.filter(|c| {
                    !c.is_empty()
                        && c.iter().all(|r| r.len() == c[0].len())
                        && !c[0].is_empty()
                        && rows.iter().all(|row| {
                            row.iter()
                                .zip(&rows[0])
                                .all(|(cell, header)| cell.align == header.align)
                        })
                }) {
                    let line = |r: &Vec<String>| format!("| {} |", r.join(" | "));
                    let rules = rows[0]
                        .iter()
                        .map(|cell| match cell.align.as_str() {
                            "center" => ":---:",
                            "right" => "---:",
                            _ => ":---",
                        })
                        .map(str::to_owned)
                        .collect();
                    std::iter::once(line(&cells[0]))
                        .chain(std::iter::once(line(&rules)))
                        .chain(cells[1..].iter().map(line))
                        .collect::<Vec<_>>()
                        .join("\n")
                } else {
                    table_html(rows, assets)
                }
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
pub fn serialize(document: &NativeDocument, assets: &str) -> Result<String> {
    let mut result = blocks(&document.blocks, assets);
    for (id, content) in &document.footnotes {
        let content = blocks(content, assets);
        let mut lines = content.lines();
        result.push_str(&format!("\n\n[^{id}]: {}", lines.next().unwrap_or("")));
        for line in lines {
            result.push_str(&format!("\n    {line}"));
        }
    }
    result.push('\n');
    if result.len() > MAX_TEXT {
        return Err("导入 Markdown 超过 16 MiB".into());
    }
    Ok(result)
}
