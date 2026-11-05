use super::super::Result;
use quick_xml::{events::Event, name::ResolveResult, NsReader, XmlVersion};
use std::collections::HashMap;

#[derive(Debug, Default, Clone)]
pub struct Element {
    pub name: String,
    pub attrs: HashMap<String, String>,
    pub text: String,
    pub children: Vec<Element>,
}
impl Element {
    pub fn child(&self, name: &str) -> Option<&Self> {
        self.children.iter().find(|e| e.name == name)
    }
    pub fn attr(&self, name: &str) -> &str {
        self.attrs.get(name).map(String::as_str).unwrap_or("")
    }
    pub fn val(&self, name: &str) -> &str {
        self.child(name).map(|e| e.attr("w:val")).unwrap_or("")
    }
    pub fn find(&self, name: &str) -> Option<&Self> {
        if self.name == name {
            Some(self)
        } else {
            self.children.iter().find_map(|e| e.find(name))
        }
    }
    pub fn text_content(&self) -> String {
        let mut text = self.text.clone();
        for child in &self.children {
            text.push_str(&child.text_content());
        }
        text
    }
}
fn qualified(ns: ResolveResult<'_>, local: &str) -> Result<String> {
    let prefix = match ns {
        ResolveResult::Unknown(_) => return Err("XML 使用未声明的命名空间".into()),
        ResolveResult::Unbound => "",
        ResolveResult::Bound(uri) => match uri.as_ref() {
            "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            | "http://purl.oclc.org/ooxml/wordprocessingml/main" => "w:",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            | "http://purl.oclc.org/ooxml/officeDocument/relationships" => "r:",
            "http://schemas.openxmlformats.org/package/2006/relationships" => "pkg:",
            "http://schemas.openxmlformats.org/package/2006/content-types" => "ct:",
            "http://schemas.openxmlformats.org/drawingml/2006/main"
            | "http://purl.oclc.org/ooxml/drawingml/main" => "a:",
            "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            | "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing" => "wp:",
            "http://schemas.openxmlformats.org/markup-compatibility/2006" => "mc:",
            "http://schemas.openxmlformats.org/officeDocument/2006/math" => "m:",
            "urn:schemas-microsoft-com:vml" => "v:",
            "http://www.w3.org/XML/1998/namespace" => "xml:",
            _ => "other:",
        },
    };
    Ok(format!("{prefix}{}", local))
}
pub fn parse(bytes: &[u8], check: &impl Fn() -> Result<()>, budget: &mut usize) -> Result<Element> {
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("DOCX 单个 XML 超过 8 MiB".into());
    }
    let input = std::str::from_utf8(bytes)
        .map_err(|_| "不支持的 XML 编码（需要 UTF-8）；请另存为标准 DOCX")?;
    let mut reader = NsReader::from_str(input.trim_start_matches('\u{feff}'));
    let mut stack = vec![Element::default()];
    loop {
        check()?;
        let event = reader
            .read_event()
            .map_err(|e| format!("DOCX XML 损坏: {e}"))?;
        match event {
            Event::Start(ref e) | Event::Empty(ref e) => {
                *budget += 1;
                if *budget > 250_000 || stack.len() > 96 {
                    return Err("DOCX XML 节点数或嵌套深度超过预算".into());
                }
                let (ns, local) = reader.resolver().resolve_element(e.name());
                let mut element = Element {
                    name: qualified(ns, local.as_ref())?,
                    ..Element::default()
                };
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| e.to_string())?;
                    if attr.key.as_ref() == "xmlns" || attr.key.as_ref().starts_with("xmlns:") {
                        continue;
                    }
                    let (ns, local) = reader.resolver().resolve_attribute(attr.key);
                    let key = qualified(ns, local.as_ref())?;
                    let value = attr
                        .normalized_value(XmlVersion::Implicit1_0)
                        .map_err(|e| e.to_string())?
                        .into_owned();
                    if element.attrs.insert(key, value).is_some() {
                        return Err("XML 属性重复".into());
                    }
                }
                if matches!(event, Event::Empty(_)) {
                    stack.last_mut().unwrap().children.push(element);
                } else {
                    stack.push(element);
                }
            }
            Event::End(_) => {
                if stack.len() <= 1 {
                    return Err("XML 结束标签无效".into());
                }
                let element = stack.pop().unwrap();
                stack.last_mut().unwrap().children.push(element);
            }
            Event::Text(e) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&e.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(e) => stack
                .last_mut()
                .unwrap()
                .text
                .push_str(&e.xml_content(XmlVersion::Implicit1_0)),
            Event::GeneralRef(e) => {
                let name = e.as_ref();
                let ch = match name {
                    "amp" => '&',
                    "lt" => '<',
                    "gt" => '>',
                    "quot" => '"',
                    "apos" => '\'',
                    _ => e
                        .resolve_char_ref()
                        .map_err(|e| e.to_string())?
                        .ok_or("禁止自定义 XML 实体")?,
                };
                stack.last_mut().unwrap().text.push(ch);
            }
            Event::DocType(_) => return Err("DOCX 不允许 DTD 或外部实体".into()),
            Event::Eof => break,
            _ => {}
        }
    }
    if stack.len() != 1 || stack[0].children.len() != 1 || !stack[0].text.trim().is_empty() {
        return Err("DOCX XML 根结构无效".into());
    }
    Ok(stack.pop().unwrap().children.remove(0))
}
