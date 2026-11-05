use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct Warning {
    pub kind: String,
    pub message: String,
}
#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub paragraphs: usize,
    pub headings: usize,
    pub list_items: usize,
    pub tables: usize,
    pub images: usize,
    pub footnotes: usize,
}
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Format {
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
}
#[derive(Debug, Clone)]
pub enum Inline {
    Text(String, Format),
    Break,
    Tab,
    Link {
        target: String,
        content: Vec<Inline>,
    },
    Image {
        asset: String,
        alt: String,
        width: Option<u32>,
        height: Option<u32>,
    },
    Footnote(String),
    Unsupported(String),
}
#[derive(Debug, Clone)]
pub struct Cell {
    pub blocks: Vec<Block>,
    pub colspan: usize,
    pub rowspan: usize,
    pub continuation: bool,
    pub align: String,
}
#[derive(Debug, Clone)]
pub struct ListItem {
    pub blocks: Vec<Block>,
}
#[derive(Debug, Clone)]
pub enum Block {
    Paragraph(Vec<Inline>),
    Heading(u8, Vec<Inline>),
    Code(String),
    Quote(Vec<Block>),
    Rule,
    List {
        ordered: bool,
        start: u32,
        items: Vec<ListItem>,
    },
    Table(Vec<Vec<Cell>>),
    Unsupported(String),
}
pub struct NativeDocument {
    pub blocks: Vec<Block>,
    pub footnotes: Vec<(String, Vec<Block>)>,
    pub assets: Vec<(String, Vec<u8>)>,
    pub warnings: Vec<Warning>,
    pub stats: Stats,
}
