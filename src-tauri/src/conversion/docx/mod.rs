//! Bounded OPC/WordprocessingML reader. No applications, scripts or network IO.
pub mod ast;
pub mod markdown;
mod package;
#[cfg(test)]
mod tests;
mod xml;
use super::{Result, MAX_MEDIA_FILES};
use ast::*;
use package::{Package, Relationships};
use std::collections::{HashMap, HashSet};
use xml::Element;

#[derive(Clone, Default)]
struct Props {
    bold: Option<bool>,
    italic: Option<bool>,
    strike: Option<bool>,
    code: Option<bool>,
    heading: Option<u8>,
    quote: Option<bool>,
    align: Option<String>,
    numbering: Option<(String, u8)>,
}
impl Props {
    fn merge(&mut self, other: &Self) {
        macro_rules! merge { ($($field:ident),*) => { $(if other.$field.is_some() { self.$field = other.$field.clone(); })* }; }
        merge!(bold, italic, strike, code, heading, quote, align, numbering);
    }
    fn format(&self) -> Format {
        Format {
            bold: self.bold.unwrap_or(false),
            italic: self.italic.unwrap_or(false),
            strike: self.strike.unwrap_or(false),
            code: self.code.unwrap_or(false),
        }
    }
}
fn on(node: &Element) -> bool {
    !matches!(node.attr("w:val"), "0" | "false" | "off")
}
fn properties(node: Option<&Element>) -> Props {
    let mut p = Props::default();
    let Some(node) = node else { return p };
    for child in &node.children {
        match child.name.as_str() {
            "w:b" | "w:bCs" => p.bold = Some(on(child)),
            "w:i" | "w:iCs" => p.italic = Some(on(child)),
            "w:strike" | "w:dstrike" => p.strike = Some(on(child)),
            "w:outlineLvl" => {
                p.heading =
                    child
                        .attr("w:val")
                        .parse::<u8>()
                        .ok()
                        .map(|n| if n < 6 { n + 1 } else { 0 })
            }
            "w:jc" => p.align = Some(child.attr("w:val").into()),
            "w:pBdr" if child.child("w:left").is_some() => p.quote = Some(true),
            "w:numPr" => {
                let id = child.val("w:numId");
                if !id.is_empty() {
                    p.numbering = Some((
                        id.into(),
                        child.val("w:ilvl").parse::<u8>().unwrap_or(0).min(8),
                    ));
                }
            }
            "w:rFonts" => {
                let name = format!(
                    "{} {} {}",
                    child.attr("w:ascii"),
                    child.attr("w:hAnsi"),
                    child.attr("w:cs")
                )
                .to_lowercase();
                if [
                    "consolas",
                    "courier",
                    "monospace",
                    "source code",
                    "cascadia",
                ]
                .iter()
                .any(|v| name.contains(v))
                {
                    p.code = Some(true);
                }
            }
            _ => {}
        }
    }
    p
}
#[derive(Default)]
struct Styles {
    entries: HashMap<String, (String, Props)>,
    defaults: Props,
    normal: String,
}
impl Styles {
    fn read(root: &Element) -> Result<Self> {
        let mut result = Self::default();
        if let Some(defaults) = root.child("w:docDefaults") {
            result.defaults.merge(&properties(
                defaults
                    .child("w:rPrDefault")
                    .and_then(|e| e.child("w:rPr")),
            ));
            result.defaults.merge(&properties(
                defaults
                    .child("w:pPrDefault")
                    .and_then(|e| e.child("w:pPr")),
            ));
        }
        for style in root.children.iter().filter(|e| e.name == "w:style") {
            let id = style.attr("w:styleId");
            if id.is_empty() {
                continue;
            }
            let mut p = properties(style.child("w:pPr"));
            p.merge(&properties(style.child("w:rPr")));
            let name = format!("{id} {}", style.val("w:name")).to_lowercase();
            if p.heading.is_none() {
                if id.eq_ignore_ascii_case("Title")
                    || style.val("w:name").eq_ignore_ascii_case("title")
                {
                    p.heading = Some(1);
                }
                for level in 1..=6 {
                    if name.contains(&format!("heading{level}"))
                        || name.contains(&format!("heading {level}"))
                        || name.contains(&format!("标题 {level}"))
                    {
                        p.heading = Some(level);
                        break;
                    }
                }
            }
            if name.contains("quote") || name.contains("引用") {
                p.quote = Some(true);
            }
            if ["code", "sourcecode", "preformatted", "代码"]
                .iter()
                .any(|n| name.contains(n))
            {
                p.code = Some(true);
            }
            if style.attr("w:default") == "1" && style.attr("w:type") == "paragraph" {
                result.normal = id.into();
            }
            if result
                .entries
                .insert(id.into(), (style.val("w:basedOn").into(), p))
                .is_some()
            {
                return Err("DOCX 样式 Id 重复".into());
            }
        }
        Ok(result)
    }
    fn resolve(&self, id: &str) -> Result<Props> {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut at = id;
        while let Some((base, p)) = self.entries.get(at) {
            if !seen.insert(at) || chain.len() >= 32 {
                return Err("DOCX 样式继承存在循环或超过 32 层".into());
            }
            chain.push(p);
            at = base;
        }
        let mut result = Props::default();
        for p in chain.into_iter().rev() {
            result.merge(p);
        }
        Ok(result)
    }
}
#[derive(Clone)]
struct Level {
    ordered: bool,
    start: u32,
    format: String,
}
#[derive(Default)]
struct Numbering {
    levels: HashMap<(String, u8), Level>,
    instances: HashMap<String, String>,
    overrides: HashMap<(String, u8), Level>,
}
impl Numbering {
    fn read(root: &Element) -> Self {
        let mut out = Self::default();
        let read_level = |e: &Element| Level {
            ordered: e.val("w:numFmt") != "bullet",
            start: e.val("w:start").parse().unwrap_or(1),
            format: e.val("w:numFmt").into(),
        };
        for e in &root.children {
            if e.name == "w:abstractNum" {
                for level in e.children.iter().filter(|e| e.name == "w:lvl") {
                    out.levels.insert(
                        (
                            e.attr("w:abstractNumId").into(),
                            level.attr("w:ilvl").parse().unwrap_or(0),
                        ),
                        read_level(level),
                    );
                }
            } else if e.name == "w:num" {
                out.instances
                    .insert(e.attr("w:numId").into(), e.val("w:abstractNumId").into());
            }
        }
        for e in root.children.iter().filter(|e| e.name == "w:num") {
            for over in e.children.iter().filter(|e| e.name == "w:lvlOverride") {
                let level = over.attr("w:ilvl").parse().unwrap_or(0);
                let id = e.attr("w:numId").to_owned();
                let mut value = over
                    .child("w:lvl")
                    .map(read_level)
                    .or_else(|| {
                        out.instances
                            .get(&id)
                            .and_then(|a| out.levels.get(&(a.clone(), level)))
                            .cloned()
                    })
                    .unwrap_or(Level {
                        ordered: true,
                        start: 1,
                        format: "decimal".into(),
                    });
                if let Ok(start) = over.val("w:startOverride").parse() {
                    value.start = start;
                }
                out.overrides.insert((id, level), value);
            }
        }
        out
    }
    fn level(&self, id: &str, level: u8) -> Option<Level> {
        self.overrides
            .get(&(id.into(), level))
            .or_else(|| {
                self.instances
                    .get(id)
                    .and_then(|a| self.levels.get(&(a.clone(), level)))
            })
            .cloned()
    }
}
struct Item {
    block: Block,
    list: Option<(String, u8, bool, u32)>,
}
fn group(
    items: &mut std::iter::Peekable<std::vec::IntoIter<Item>>,
    id: &str,
    depth: u8,
    ordered: bool,
    start: u32,
) -> Block {
    let mut entries: Vec<ListItem> = Vec::new();
    while let Some((next_id, level, next_ordered, ordinal)) =
        items.peek().and_then(|item| item.list.clone())
    {
        if level < depth || (level == depth && next_id != id) {
            break;
        }
        if level > depth {
            let nested = group(items, &next_id, level, next_ordered, ordinal);
            if let Some(last) = entries.last_mut() {
                last.blocks.push(nested);
            } else {
                entries.push(ListItem {
                    blocks: vec![nested],
                });
            }
        } else {
            if next_ordered != ordered {
                break;
            }
            entries.push(ListItem {
                blocks: vec![items.next().unwrap().block],
            });
        }
    }
    Block::List {
        ordered,
        start,
        items: entries,
    }
}
fn grouped(items: Vec<Item>) -> Vec<Block> {
    let mut input = items.into_iter().peekable();
    let mut result = Vec::new();
    while let Some(item) = input.peek() {
        if let Some((id, depth, ordered, start)) = item.list.clone() {
            result.push(group(&mut input, &id, depth, ordered, start));
        } else {
            result.push(input.next().unwrap().block);
        }
    }
    result
}
struct Parser<'a, F: Fn() -> Result<()>> {
    package: Package,
    check: &'a F,
    styles: Styles,
    numbering: Numbering,
    counters: HashMap<(String, u8), u32>,
    assets: Vec<(String, Vec<u8>)>,
    asset_names: HashMap<String, String>,
    warnings: Vec<Warning>,
    stats: Stats,
    note_refs: HashSet<String>,
}
impl<F: Fn() -> Result<()>> Parser<'_, F> {
    fn warn(&mut self, kind: &str, message: &str) {
        if self.warnings.len() < 128
            && !self
                .warnings
                .iter()
                .any(|w| w.kind == kind && w.message == message)
        {
            self.warnings.push(Warning {
                kind: kind.into(),
                message: message.into(),
            });
        }
    }
    fn paragraph_props(&self, p: &Element) -> Result<Props> {
        let ppr = p.child("w:pPr");
        let id = ppr
            .map(|e| e.val("w:pStyle"))
            .filter(|s| !s.is_empty())
            .unwrap_or(&self.styles.normal);
        let mut props = self.styles.defaults.clone();
        props.merge(&self.styles.resolve(id)?);
        props.merge(&properties(ppr));
        props.merge(&properties(ppr.and_then(|e| e.child("w:rPr"))));
        Ok(props)
    }
    fn blocks(&mut self, container: &Element, rels: &Relationships) -> Result<Vec<Block>> {
        let mut items = Vec::new();
        for e in &container.children {
            (self.check)()?;
            match e.name.as_str() {
                "w:p" => {
                    let props = self.paragraph_props(e)?;
                    let inline = self.inline(e, rels, &props)?;
                    let shaded_code = e.child("w:pPr").and_then(|p| p.child("w:shd")).is_some()
                        && inline.iter().any(
                            |v| matches!(v,Inline::Text(s,f) if !s.trim().is_empty() && f.code),
                        )
                        && inline.iter().all(|v| {
                            matches!(
                                v,
                                Inline::Text(_, Format { code: true, .. })
                                    | Inline::Break
                                    | Inline::Tab
                            )
                        });
                    let block = if props.code.unwrap_or(false) || shaded_code {
                        Block::Code(plain(&inline))
                    } else if let Some(level) = props.heading.filter(|n| *n > 0) {
                        self.stats.headings += 1;
                        Block::Heading(level, inline)
                    } else if inline.is_empty() && e.find("w:pBdr").is_some() {
                        Block::Rule
                    } else {
                        self.stats.paragraphs += 1;
                        Block::Paragraph(inline)
                    };
                    let block = if props.quote.unwrap_or(false) {
                        Block::Quote(vec![block])
                    } else {
                        block
                    };
                    let list =
                        if let Some((id, depth)) = props.numbering.filter(|(id, _)| id != "0") {
                            let spec = self.numbering.level(&id, depth).unwrap_or_else(|| {
                                self.warn("list", "列表编号定义缺失，按十进制列表保留层级。");
                                Level {
                                    ordered: true,
                                    start: 1,
                                    format: "decimal".into(),
                                }
                            });
                            if spec.ordered && spec.format != "decimal" {
                                self.warn(
                                    "list",
                                    "Word 特殊编号样式已转换为十进制，保留起始编号与层级。",
                                );
                            }
                            self.counters
                                .retain(|(key, level), _| key != &id || *level <= depth);
                            let ordinal = *self
                                .counters
                                .entry((id.clone(), depth))
                                .and_modify(|n| *n = n.saturating_add(1))
                                .or_insert(spec.start);
                            self.stats.list_items += 1;
                            Some((id, depth, spec.ordered, ordinal))
                        } else {
                            None
                        };
                    items.push(Item { block, list });
                }
                "w:tbl" => {
                    let table = self.table(e, rels)?;
                    items.push(Item {
                        block: Block::Table(table),
                        list: None,
                    });
                }
                "w:sectPr" => {}
                "w:del" => {
                    self.warn("revision", "修订记录不能无损转换；删除内容以标记文字保留。");
                    items.push(Item {
                        block: Block::Unsupported(format!("〔修订删除〕{}", extract_text(e))),
                        list: None,
                    });
                }
                "w:sdt" => {
                    self.warn("content", "内容控件已展开为正文，控件行为未保留。");
                    if let Some(content) = e.child("w:sdtContent") {
                        for block in self.blocks(content, rels)? {
                            items.push(Item { block, list: None });
                        }
                    }
                }
                "m:oMathPara" | "m:oMath" => {
                    self.warn(
                        "math",
                        "OMML 公式尚未转换为可编辑 LaTeX，已保留可提取的公式文字。",
                    );
                    items.push(Item {
                        block: Block::Unsupported(format!("〔公式未转换〕{}", extract_text(e))),
                        list: None,
                    });
                }
                _ => {
                    if e.name == "w:ins" {
                        self.warn("revision", "修订插入按当前正文导入，修订元数据未保留。");
                    }
                    for block in self.blocks(e, rels)? {
                        items.push(Item { block, list: None });
                    }
                }
            }
        }
        Ok(grouped(items))
    }
    fn inline(&mut self, e: &Element, rels: &Relationships, props: &Props) -> Result<Vec<Inline>> {
        let mut result = Vec::new();
        for child in &e.children {
            (self.check)()?;
            match child.name.as_str() {
                "w:pPr" | "w:rPr" | "w:bookmarkStart" | "w:bookmarkEnd" => {}
                "w:r" => {
                    let mut run = props.clone();
                    if let Some(rpr) = child.child("w:rPr") {
                        let style = rpr.val("w:rStyle");
                        if !style.is_empty() {
                            run.merge(&self.styles.resolve(style)?);
                        }
                        run.merge(&properties(Some(rpr)));
                    }
                    result.extend(self.inline(child, rels, &run)?);
                }
                "w:t" => result.push(Inline::Text(child.text.clone(), props.format())),
                "w:br" | "w:cr" => {
                    if !child.attr("w:type").is_empty() && child.attr("w:type") != "textWrapping" {
                        self.warn("layout", "分页或分栏符已降级为换行。");
                    }
                    result.push(Inline::Break);
                }
                "w:tab" => result.push(Inline::Tab),
                "w:noBreakHyphen" => result.push(Inline::Text("‑".into(), props.format())),
                "w:softHyphen" => result.push(Inline::Text("\u{00ad}".into(), props.format())),
                "w:sym" => {
                    self.warn(
                        "symbol",
                        "符号字体不能保证相同字形，保留 Unicode 编码并请核对原文。",
                    );
                    let text = u32::from_str_radix(child.attr("w:char"), 16)
                        .ok()
                        .and_then(char::from_u32)
                        .map(|c| c.to_string())
                        .unwrap_or_else(|| "〔符号未转换〕".into());
                    result.push(Inline::Text(text, props.format()));
                }
                "w:hyperlink" => {
                    let content = self.inline(child, rels, props)?;
                    let target = if !child.attr("r:id").is_empty() {
                        rels.get(child.attr("r:id"))
                            .filter(|r| r.kind.ends_with("/hyperlink"))
                            .map(|r| r.target.clone())
                    } else if !child.attr("w:anchor").is_empty() {
                        self.warn(
                            "link",
                            "Word 书签链接已保留目标名称；请核对 Markdown 内部锚点。",
                        );
                        Some(format!("#{}", child.attr("w:anchor")))
                    } else {
                        None
                    };
                    if let Some(target) = target.filter(|s| safe_link(s)) {
                        if !target.contains(':') && !target.starts_with('#') {
                            self.warn(
                                "link",
                                "相对超链接按原地址保留；保存到其他目录后请核对目标。",
                            );
                        }
                        result.push(Inline::Link { target, content });
                    } else {
                        self.warn("link", "无效、缺失或危险的超链接已移除链接行为，文字保留。");
                        result.extend(content);
                    }
                }
                "w:drawing" | "w:pict" => result.extend(self.drawing(child, rels)?),
                "w:footnoteReference" | "w:endnoteReference" => {
                    let number = child
                        .attr("w:id")
                        .parse::<u32>()
                        .map_err(|_| "DOCX 脚注引用编号无效")?;
                    let id = format!(
                        "{}{}",
                        if child.name == "w:footnoteReference" {
                            "fn"
                        } else {
                            "en"
                        },
                        number
                    );
                    self.note_refs.insert(id.clone());
                    result.push(Inline::Footnote(id));
                }
                "w:footnoteRef" | "w:endnoteRef" => {}
                "w:fldChar" | "w:instrText" | "w:fldSimple" => {
                    self.warn("field", "Word 域仅保留显示结果，不执行或保留域指令。");
                    if child.name == "w:fldSimple" {
                        result.extend(self.inline(child, rels, props)?);
                    }
                }
                "m:oMath" | "m:oMathPara" => {
                    self.warn(
                        "math",
                        "OMML 公式尚未转换为可编辑 LaTeX，已保留可提取的公式文字。",
                    );
                    result.push(Inline::Unsupported(format!(
                        "〔公式未转换：{}〕",
                        extract_text(child)
                    )));
                }
                "w:object" => {
                    self.warn("object", "嵌入式对象不会执行；保留可提取文字或预览图片。");
                    let mut content = self.inline(child, rels, props)?;
                    if content.is_empty() {
                        content.push(Inline::Unsupported(format!(
                            "〔嵌入对象〕{}",
                            extract_text(child)
                        )));
                    }
                    result.extend(content);
                }
                "w:del" => {
                    self.warn("revision", "修订删除内容以标记文字保留，修订元数据未保留。");
                    result.push(Inline::Unsupported(format!(
                        "〔修订删除〕{}",
                        extract_text(child)
                    )));
                }
                "w:delText" => result.push(Inline::Unsupported(child.text.clone())),
                "w:commentReference" | "w:commentRangeStart" | "w:commentRangeEnd" => self.warn(
                    "comment",
                    "批注不能转换为 Markdown 批注；批注部件文字另附诊断内容。",
                ),
                "mc:AlternateContent" => {
                    let branch = child
                        .child("mc:Choice")
                        .filter(|e| e.find("a:blip").is_some())
                        .or_else(|| child.child("mc:Fallback"))
                        .or_else(|| child.children.first());
                    if let Some(branch) = branch {
                        result.extend(self.inline(branch, rels, props)?);
                    }
                }
                "w:txbxContent" => {
                    self.warn("content", "文本框已展开为正文文字，布局未保留。");
                    result.push(Inline::Unsupported(extract_text(child)));
                }
                _ => result.extend(self.inline(child, rels, props)?),
            }
        }
        let mut merged: Vec<Inline> = Vec::new();
        for value in result {
            if let Inline::Text(text, format) = &value {
                if let Some(Inline::Text(previous, old)) = merged.last_mut() {
                    if old == format {
                        previous.push_str(text);
                        continue;
                    }
                }
            }
            merged.push(value);
        }
        Ok(merged)
    }
    fn drawing(&mut self, e: &Element, rels: &Relationships) -> Result<Vec<Inline>> {
        let blip = e.find("a:blip").or_else(|| e.find("v:imagedata"));
        let alt = e
            .find("wp:docPr")
            .map(|e| e.attr("descr"))
            .filter(|s| !s.is_empty())
            .unwrap_or("图片")
            .to_owned();
        let Some(blip) = blip else {
            self.warn(
                "object",
                "图形、SmartArt 或文本框未找到可读取的内嵌图片，已保留文字或占位。",
            );
            let mut fallback = extract_text(e);
            let mut ids = Vec::new();
            relationship_ids(e, &mut ids);
            for id in ids {
                if let Some(rel) = rels
                    .get(&id)
                    .filter(|r| !r.external && r.kind.ends_with("/diagramData"))
                {
                    let data = self.package.xml(&rel.target, self.check)?;
                    fallback.push_str(&extract_text(&data));
                }
            }
            return Ok(vec![Inline::Unsupported(format!(
                "〔未转换图形〕{fallback}"
            ))]);
        };
        let id = [blip.attr("r:embed"), blip.attr("r:id"), blip.attr("r:link")]
            .into_iter()
            .find(|v| !v.is_empty())
            .unwrap_or("");
        let Some(rel) = rels.get(id) else {
            self.warn("image", "图片关系缺失，已保留占位文字。");
            return Ok(vec![Inline::Unsupported(format!("〔缺失图片：{alt}〕"))]);
        };
        if !rel.kind.ends_with("/image") {
            self.warn("image", "图片关系类型不正确，未读取目标。");
            return Ok(vec![Inline::Unsupported(alt)]);
        }
        if e.find("wp:anchor").is_some() {
            self.warn("layout", "浮动图片已放置在对应文字位置，环绕布局未保留。");
        }
        if e.find("a:srcRect").is_some() {
            self.warn(
                "image",
                "Word 图片裁剪尚未应用；保留完整原图和文档尺寸，请核对显示范围。",
            );
        }
        let extent = e.find("wp:extent");
        let size = |key: &str| {
            extent
                .and_then(|e| e.attr(key).parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v > 0.0)
                .map(|v| (v / 9525.0).round().clamp(1.0, 20000.0) as u32)
        };
        let (mut width, mut height) = (size("cx"), size("cy"));
        let asset = if rel.external {
            self.warn(
                "image",
                "外部图片地址已保留但没有自动下载；在编辑器中加载仍需授权。",
            );
            if !rel.target.starts_with("https://") && !rel.target.starts_with("http://") {
                return Ok(vec![Inline::Unsupported(format!("〔外部图片：{alt}〕"))]);
            }
            rel.target.clone()
        } else if let Some(name) = self.asset_names.get(&rel.target) {
            name.clone()
        } else {
            let Some(bytes) = self.package.parts.get(&rel.target) else {
                self.warn("image", "图片资源缺失，已保留占位文字。");
                return Ok(vec![Inline::Unsupported(format!("〔缺失图片：{alt}〕"))]);
            };
            let extension = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
                "png"
            } else if bytes.starts_with(b"\xff\xd8\xff") {
                "jpg"
            } else if bytes.starts_with(b"GIF8") {
                "gif"
            } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
                "webp"
            } else if bytes.starts_with(b"BM") {
                "bmp"
            } else {
                self.warn(
                    "image",
                    "不支持的图片格式（如 WMF/EMF/SVG/TIFF），未伪造转换结果；原 DOCX 保留。",
                );
                return Ok(vec![Inline::Unsupported(format!(
                    "〔不支持的图片：{alt}〕"
                ))]);
            };
            if self.assets.len() >= MAX_MEDIA_FILES {
                return Err("导入图片超过 256 个".into());
            }
            if let Some((w, h)) = crate::files::images::dimensions(bytes) {
                if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 64_000_000 {
                    return Err("DOCX 图片解码像素超过安全预算".into());
                }
                match (width, height) {
                    (Some(v), None) => {
                        height = Some(
                            ((f64::from(v) * f64::from(h) / f64::from(w)).round() as u32).max(1),
                        )
                    }
                    (None, Some(v)) => {
                        width = Some(
                            ((f64::from(v) * f64::from(w) / f64::from(h)).round() as u32).max(1),
                        )
                    }
                    _ => {}
                }
            } else {
                self.warn("image", "图片尺寸未能识别，保留资源并使用文档提供的尺寸。");
            }
            let name = format!("image-{}.{extension}", self.assets.len() + 1);
            let bytes = self.package.parts.remove(&rel.target).unwrap();
            self.asset_names.insert(rel.target.clone(), name.clone());
            self.assets.push((name.clone(), bytes));
            name
        };
        self.stats.images += 1;
        Ok(vec![Inline::Image {
            asset,
            alt,
            width,
            height,
        }])
    }
    fn table(&mut self, e: &Element, rels: &Relationships) -> Result<Vec<Vec<Cell>>> {
        self.stats.tables += 1;
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut active: HashMap<usize, (usize, usize)> = HashMap::new();
        for row in e.children.iter().filter(|e| e.name == "w:tr") {
            let mut cells = Vec::new();
            let mut column = 0;
            for cell in row.children.iter().filter(|e| e.name == "w:tc") {
                let tcpr = cell.child("w:tcPr");
                let colspan = tcpr
                    .map(|e| e.val("w:gridSpan"))
                    .unwrap_or("")
                    .parse::<usize>()
                    .unwrap_or(1)
                    .clamp(1, 64);
                let merge = tcpr.and_then(|e| e.child("w:vMerge"));
                let mut continuation = merge.is_some_and(|e| e.attr("w:val") != "restart");
                let blocks = self.blocks(cell, rels)?;
                let align = cell
                    .child("w:p")
                    .map(|e| self.paragraph_props(e))
                    .transpose()?
                    .and_then(|p| p.align)
                    .unwrap_or_default();
                if colspan > 1
                    || merge.is_some()
                    || blocks.iter().any(|b| matches!(b, Block::Table(_)))
                {
                    self.warn(
                        "table",
                        "合并单元格或嵌套表格使用受控 HTML 保留结构，页面列宽可能变化。",
                    );
                }
                if continuation {
                    if let Some(&(r, c)) = active.get(&column) {
                        rows[r][c].rowspan += 1;
                        rows[r][c].blocks.extend(
                            blocks
                                .clone()
                                .into_iter()
                                .filter(|b| !matches!(b,Block::Paragraph(v) if v.is_empty())),
                        );
                    } else {
                        continuation = false;
                        self.warn("table", "纵向合并缺少起始单元格，按普通单元格保留内容。");
                    }
                } else {
                    active.remove(&column);
                    if merge.is_some() {
                        active.insert(column, (rows.len(), cells.len()));
                    }
                }
                cells.push(Cell {
                    blocks,
                    colspan,
                    rowspan: 1,
                    continuation,
                    align,
                });
                column += colspan;
                if column > 256 {
                    return Err("DOCX 表格列数超过 256".into());
                }
            }
            rows.push(cells);
            if rows.len() > 10_000 {
                return Err("DOCX 表格行数超过 10000".into());
            }
        }
        Ok(rows)
    }
}
fn plain(values: &[Inline]) -> String {
    values
        .iter()
        .map(|v| match v {
            Inline::Text(s, _) | Inline::Unsupported(s) => s.clone(),
            Inline::Break => "\n".into(),
            Inline::Tab => "\t".into(),
            Inline::Link { content, .. } => plain(content),
            Inline::Image { alt, .. } => alt.clone(),
            Inline::Footnote(id) => format!("[^{id}]"),
        })
        .collect()
}
fn extract_text(node: &Element) -> String {
    if matches!(node.name.as_str(), "w:t" | "w:delText" | "a:t" | "m:t") {
        node.text.clone()
    } else {
        node.children
            .iter()
            .map(extract_text)
            .collect::<Vec<_>>()
            .join(" ")
    }
}
fn relationship_ids(node: &Element, ids: &mut Vec<String>) {
    for (key, value) in &node.attrs {
        if key.starts_with("r:") && !ids.contains(value) {
            ids.push(value.clone());
        }
    }
    for child in &node.children {
        relationship_ids(child, ids);
    }
}
fn safe_link(value: &str) -> bool {
    if value.contains(['\0', '\r', '\n', '<', '>']) {
        return false;
    }
    match value.split_once(':') {
        Some((scheme, _)) => matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto" | "file" | "tel"
        ),
        None => true,
    }
}
fn related_xml(
    package: &mut Package,
    rels: &Relationships,
    kind: &str,
    check: &impl Fn() -> Result<()>,
) -> Result<Option<(String, Element)>> {
    let matches: Vec<_> = rels
        .values()
        .filter(|r| r.kind.ends_with(&format!("/{kind}")))
        .collect();
    if matches.len() > 1 {
        return Err(format!("DOCX 的 {kind} 部件关系重复"));
    }
    let rel = matches.first();
    match rel {
        Some(r) if r.external => Err(format!("DOCX 的 {kind} 部件不能是外部关系")),
        Some(r) => Ok(Some((r.target.clone(), package.xml(&r.target, check)?))),
        None => Ok(None),
    }
}
pub fn parse(bytes: &[u8], check: &impl Fn() -> Result<()>) -> Result<NativeDocument> {
    let mut package = Package::read(bytes, check)?;
    let main = package.main_part(check)?;
    let rels = package.relationships(&main, check)?;
    let styles = related_xml(&mut package, &rels, "styles", check)?
        .map(|(_, e)| Styles::read(&e))
        .transpose()?
        .unwrap_or_default();
    let numbering = related_xml(&mut package, &rels, "numbering", check)?
        .map(|(_, e)| Numbering::read(&e))
        .unwrap_or_default();
    let body = package.xml(&main, check)?;
    if body.name != "w:document" {
        return Err("DOCX 主文档命名空间或根节点无效".into());
    }
    let body = body.child("w:body").ok_or("DOCX 主文档缺少正文")?;
    let mut parser = Parser {
        package,
        check,
        styles,
        numbering,
        counters: HashMap::new(),
        assets: Vec::new(),
        asset_names: HashMap::new(),
        warnings: Vec::new(),
        stats: Stats::default(),
        note_refs: HashSet::new(),
    };
    let mut blocks = parser.blocks(body, &rels)?;
    let mut footnotes = Vec::new();
    for (kind, prefix, element) in [
        ("footnotes", "fn", "w:footnote"),
        ("endnotes", "en", "w:endnote"),
    ] {
        if let Some((part, notes)) = related_xml(&mut parser.package, &rels, kind, check)? {
            let note_rels = parser.package.relationships(&part, check)?;
            for note in notes.children.iter().filter(|e| {
                e.name == element && e.attr("w:type").is_empty() && !e.attr("w:id").starts_with('-')
            }) {
                let number = note
                    .attr("w:id")
                    .parse::<u32>()
                    .map_err(|_| "DOCX 脚注定义编号无效")?;
                let id = format!("{prefix}{number}");
                if footnotes.iter().any(|(key, _)| key == &id) {
                    return Err("DOCX 脚注定义编号重复".into());
                }
                let content = parser.blocks(note, &note_rels)?;
                footnotes.push((id, content));
                parser.stats.footnotes += 1;
            }
        }
    }
    for id in parser.note_refs.clone() {
        if !footnotes.iter().any(|(key, _)| key == &id) {
            parser.warn("footnote", "存在缺失的脚注或尾注，已保留引用与缺失提示。");
            footnotes.push((id, vec![Block::Unsupported("〔脚注内容缺失〕".into())]));
        }
    }
    for rel in rels.values() {
        if ["header", "footer", "comments"]
            .iter()
            .any(|kind| rel.kind.ends_with(&format!("/{kind}")))
        {
            parser.warn(
                "layout",
                "页眉、页脚或批注无法保持 Word 页面布局；可提取文字附在文末。",
            );
            if !rel.external {
                let part = parser.package.xml(&rel.target, check)?;
                let text = extract_text(&part);
                if !text.trim().is_empty() {
                    blocks.push(Block::Quote(vec![Block::Unsupported(format!(
                        "〔Word 页眉、页脚或批注〕{text}"
                    ))]));
                }
            }
        }
    }
    Ok(NativeDocument {
        blocks,
        footnotes,
        assets: parser.assets,
        warnings: parser.warnings,
        stats: parser.stats,
    })
}

pub(super) fn read_package(bytes: &[u8]) -> Result<Package> {
    Package::read(bytes, &|| Ok(()))
}
