use super::{
    super::{Result, MAX_MEDIA, MAX_OUTPUT},
    xml::{self, Element},
};
use std::{
    collections::{HashMap, HashSet},
    io::Read,
};

pub struct Package {
    pub parts: HashMap<String, Vec<u8>>,
    pub xml_nodes: usize,
}
#[derive(Clone, Debug)]
pub struct Relationship {
    pub kind: String,
    pub target: String,
    pub external: bool,
}
pub type Relationships = HashMap<String, Relationship>;

pub fn safe_member(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('/') || name.contains(['\\', ':', '\0']) {
        return Err("DOCX 包含非法资源路径".into());
    }
    for part in name.split('/') {
        crate::workspace::guard::validate_name(part)?;
    }
    Ok(())
}
pub fn resolve(part: &str, target: &str) -> Result<String> {
    let path = target.split('#').next().unwrap_or("");
    let mut decoded = Vec::new();
    let bytes = path.as_bytes();
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            if at + 2 >= bytes.len() {
                return Err("OPC 关系 URI 转义无效".into());
            }
            let digit = |b: u8| (b as char).to_digit(16).ok_or("OPC 关系 URI 转义无效");
            decoded.push((digit(bytes[at + 1])? * 16 + digit(bytes[at + 2])?) as u8);
            at += 3;
        } else {
            decoded.push(bytes[at]);
            at += 1;
        }
    }
    let target = String::from_utf8(decoded).map_err(|_| "OPC 路径不是 UTF-8")?;
    if target.contains(['\\', ':', '\0', '?']) {
        return Err("OPC 关系目标路径无效".into());
    }
    let mut segments: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        part.rsplit_once('/')
            .map(|(dir, _)| dir.split('/').collect())
            .unwrap_or_default()
    };
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if segments.pop().is_none() {
                    return Err("OPC 关系目标越出包根目录".into());
                }
            }
            value => segments.push(value),
        }
    }
    let result = segments.join("/");
    safe_member(&result)?;
    Ok(result)
}
impl Package {
    pub fn read(bytes: &[u8], check: &impl Fn() -> Result<()>) -> Result<Self> {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| format!("无效、加密或损坏的 DOCX 包: {e}"))?;
        if zip.len() > 4096 {
            return Err("DOCX ZIP 条目超过 4096 个".into());
        }
        let mut parts = HashMap::new();
        let mut names = HashSet::new();
        let mut total = 0u64;
        for index in 0..zip.len() {
            check()?;
            let mut entry = zip
                .by_index(index)
                .map_err(|e| format!("无法读取 DOCX 条目（不支持加密）: {e}"))?;
            let name = entry.name().trim_end_matches('/').to_owned();
            safe_member(&name)?;
            if entry.is_symlink() || !names.insert(name.to_lowercase()) {
                return Err("DOCX 包含链接或重复 ZIP 条目".into());
            }
            if entry.is_dir() {
                continue;
            }
            total = total.checked_add(entry.size()).ok_or("DOCX 解压体积溢出")?;
            if entry.size() > MAX_OUTPUT as u64 || total > MAX_MEDIA {
                return Err("DOCX 解压预算超限（单项 16 MiB，总量 64 MiB）".into());
            }
            let declared = entry.size();
            let mut data = Vec::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                check()?;
                let n = entry
                    .read(&mut buf)
                    .map_err(|e| format!("DOCX 解压或 CRC 校验失败: {e}"))?;
                if n == 0 {
                    break;
                }
                if data.len() + n > MAX_OUTPUT {
                    return Err("DOCX 实际解压体积超过限制".into());
                }
                data.extend_from_slice(&buf[..n]);
            }
            if data.len() as u64 != declared {
                return Err("DOCX 解压长度不符".into());
            }
            parts.insert(name, data);
        }
        if !parts.contains_key("[Content_Types].xml") || !parts.contains_key("_rels/.rels") {
            return Err("不是有效 DOCX：缺少 OPC 内容类型或包关系".into());
        }
        Ok(Self {
            parts,
            xml_nodes: 0,
        })
    }
    pub fn xml(&mut self, part: &str, check: &impl Fn() -> Result<()>) -> Result<Element> {
        xml::parse(
            self.parts
                .get(part)
                .ok_or_else(|| format!("DOCX 缺少部件 {part}"))?,
            check,
            &mut self.xml_nodes,
        )
    }
    pub fn relationships(
        &mut self,
        part: &str,
        check: &impl Fn() -> Result<()>,
    ) -> Result<Relationships> {
        let relpath = if part.is_empty() {
            "_rels/.rels".into()
        } else {
            let (dir, name) = part.rsplit_once('/').unwrap_or(("", part));
            format!(
                "{}{sep}_rels/{name}.rels",
                dir,
                sep = if dir.is_empty() { "" } else { "/" }
            )
        };
        if !self.parts.contains_key(&relpath) {
            return Ok(HashMap::new());
        }
        let xml = self.xml(&relpath, check)?;
        if xml.name != "pkg:Relationships" {
            return Err("OPC 关系命名空间无效".into());
        }
        let mut result = HashMap::new();
        for r in xml.children.iter().filter(|r| r.name == "pkg:Relationship") {
            let id = r.attr("Id");
            if id.is_empty() {
                return Err("OPC 关系缺少 Id".into());
            }
            let external = r.attr("TargetMode") == "External";
            let target = if external {
                r.attr("Target").into()
            } else {
                resolve(part, r.attr("Target"))?
            };
            if result
                .insert(
                    id.into(),
                    Relationship {
                        kind: r.attr("Type").into(),
                        target,
                        external,
                    },
                )
                .is_some()
            {
                return Err("OPC 关系 Id 重复".into());
            }
        }
        Ok(result)
    }
    pub fn main_part(&mut self, check: &impl Fn() -> Result<()>) -> Result<String> {
        let relationships = self.relationships("", check)?;
        let main: Vec<_> = relationships
            .values()
            .filter(|r| r.kind.ends_with("/officeDocument"))
            .collect();
        if main.len() != 1 || main[0].external {
            return Err("DOCX 主文档关系缺失、重复或为外部目标".into());
        }
        let path = main[0].target.clone();
        let types = self.xml("[Content_Types].xml", check)?;
        if types.name != "ct:Types" {
            return Err("OPC 内容类型命名空间无效".into());
        }
        let mut overrides = HashSet::new();
        for entry in &types.children {
            if entry.attr("ContentType").contains("macroEnabled")
                || entry.attr("ContentType").contains("vbaProject")
            {
                return Err("不支持宏文档，请另存为无宏 DOCX".into());
            }
            if entry.name == "ct:Override" && !overrides.insert(entry.attr("PartName")) {
                return Err("OPC 内容类型存在重复部件".into());
            }
        }
        if !self.parts.contains_key(&path) {
            return Err("DOCX 主文档部件缺失".into());
        }
        let content_type = types
            .children
            .iter()
            .find(|e| e.name == "ct:Override" && e.attr("PartName").trim_start_matches('/') == path)
            .map(|e| e.attr("ContentType"));
        if content_type
            != Some(
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
            )
        {
            return Err("不支持的 Office 类型：只接受无宏的 DOCX 主文档".into());
        }
        Ok(path)
    }
}
