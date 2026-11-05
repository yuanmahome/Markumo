//! Native capabilities and bounded staging for document conversion only.
pub(crate) mod docx;
mod engine;
mod lease;
pub use engine::*;
pub use lease::*;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_OUTPUT: usize = 16 * 1024 * 1024;
pub const MAX_TEXT: usize = 16 * 1024 * 1024;
pub const MAX_MEDIA: u64 = 64 * 1024 * 1024;
pub const MAX_MEDIA_FILES: usize = 256;
pub const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Debug)]
pub struct InputText(pub String);
impl<'de> serde::Deserialize<'de> for InputText {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct TextVisitor;
        impl<'de> serde::de::Visitor<'de> for TextVisitor {
            type Value = InputText;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "转换文本，最多 16 MiB UTF-8")
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<InputText, E> {
                if value.len() > MAX_TEXT {
                    return Err(E::custom("转换输入超过 16 MiB"));
                }
                Ok(InputText(value.to_owned()))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<InputText, E> {
                if value.len() > MAX_TEXT {
                    return Err(E::custom("转换输入超过 16 MiB"));
                }
                Ok(InputText(value))
            }
        }
        d.deserialize_string(TextVisitor)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub path: String,
    pub warnings: Vec<docx::ast::Warning>,
    pub stats: docx::ast::Stats,
}
