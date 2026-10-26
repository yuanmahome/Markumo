//! Native capabilities and bounded staging for document conversion only.
mod engine;
mod lease;
mod remote;
pub use engine::*;
pub use lease::*;

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_OUTPUT: usize = 16 * 1024 * 1024;
pub const MAX_TEXT: usize = 16 * 1024 * 1024;
pub const MAX_MEDIA: u64 = 64 * 1024 * 1024;
pub const MAX_MEDIA_FILES: usize = 256;
pub const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

#[derive(Debug)]
pub struct BinaryBytes(pub Vec<u8>);
impl<'de> serde::Deserialize<'de> for BinaryBytes {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct BytesVisitor;
        impl<'de> serde::de::Visitor<'de> for BytesVisitor {
            type Value = BinaryBytes;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "转换字节数组，最多 16 MiB")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut bytes = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(64 * 1024));
                while let Some(byte) = seq.next_element::<u8>()? {
                    if bytes.len() == MAX_OUTPUT {
                        return Err(serde::de::Error::custom("导出超过 16 MiB"));
                    }
                    bytes.push(byte);
                }
                Ok(BinaryBytes(bytes))
            }
        }
        d.deserialize_seq(BytesVisitor)
    }
}

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
