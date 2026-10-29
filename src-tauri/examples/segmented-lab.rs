//! Explicit CLI laboratory, never an application command. One JSON request per
//! line; responses contain bounded windows/metadata, never the complete file.
use markumo_lib::text_document::{Edit, Session, WINDOW_BYTES};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Read, Write},
    path::Path,
    sync::atomic::AtomicBool,
    time::Instant,
};
fn main() {
    let mut session: Option<Session> = None;
    let mut output = io::stdout().lock();
    let mut input = io::stdin().lock();
    loop {
        let mut bytes = Vec::new();
        let count = match Read::by_ref(&mut input)
            .take(2 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut bytes)
        {
            Ok(n) => n,
            Err(error) => {
                eprintln!("stdin: {error}");
                break;
            }
        };
        if count == 0 {
            break;
        }
        let over_budget = bytes.len() > 2 * 1024 * 1024;
        let line = String::from_utf8(bytes);
        let started = Instant::now();
        let result = (|| -> Result<Value, Box<dyn std::error::Error>> {
            let line = line?;
            if line.len() > 2 * 1024 * 1024 {
                return Err("request exceeds 2 MiB".into());
            }
            let request: Value = serde_json::from_str(&line)?;
            let command = request["command"].as_str().ok_or("missing command")?;
            let cancel = AtomicBool::new(false);
            match command {
                "open" => {
                    if session.is_some() {
                        return Err("close the current session first".into());
                    }
                    session = Some(Session::open(
                        Path::new(request["path"].as_str().ok_or("missing path")?),
                        Path::new(request["workspace"].as_str().ok_or("missing workspace")?),
                        &cancel,
                    )?);
                }
                "restore" => {
                    if session.is_some() {
                        return Err("close first".into());
                    }
                    session = Some(Session::restore(
                        Path::new(request["directory"].as_str().ok_or("missing directory")?),
                        &cancel,
                    )?);
                }
                "close" => {
                    if request["discard"] == true {
                        if let Some(doc) = session.take() {
                            doc.discard()?;
                        }
                    } else {
                        if let Some(doc) = session.as_mut() {
                            doc.checkpoint(&cancel)?;
                        }
                        session.take();
                    }
                    return Ok(json!({"closed":true}));
                }
                _ => {
                    let doc = session.as_mut().ok_or("no open session")?;
                    let revision = request["revision"].as_u64().ok_or("missing revision")?;
                    match command {
                        "window" => {
                            return Ok(serde_json::to_value(doc.window(
                                revision,
                                request["start"].as_u64().unwrap_or(0),
                                request["budget"].as_u64().unwrap_or(WINDOW_BYTES as u64) as usize,
                            )?)?)
                        }
                        "edit" => {
                            let edits = request["edits"]
                                .as_array()
                                .ok_or("missing edits")?
                                .iter()
                                .map(|e| {
                                    Ok(Edit {
                                        from: e["from"].as_u64().ok_or("missing from")?,
                                        to: e["to"].as_u64().ok_or("missing to")?,
                                        insert: e["insert"].as_str().ok_or("missing insert")?,
                                    })
                                })
                                .collect::<Result<Vec<_>, &str>>()?;
                            doc.edit(revision, &edits)?;
                        }
                        "undo" => {
                            doc.undo(revision)?;
                        }
                        "redo" => {
                            doc.redo(revision)?;
                        }
                        "search" => {
                            return Ok(serde_json::to_value(doc.search(
                                revision,
                                request["query"].as_str().ok_or("missing query")?,
                                request["start"].as_u64().unwrap_or(0),
                                request["limit"].as_u64().unwrap_or(16) as usize,
                                &cancel,
                            )?)?)
                        }
                        "position" => {
                            return Ok(serde_json::to_value(doc.position(
                                revision,
                                request["byte"].as_u64().ok_or("missing byte")?,
                                &cancel,
                            )?)?)
                        }
                        "lineStart" => {
                            return Ok(
                                json!({"byte":doc.line_start(revision,request["line"].as_u64().ok_or("missing line")?,&cancel)?}),
                            )
                        }
                        "replace" => {
                            doc.replace_all(
                                revision,
                                request["query"].as_str().ok_or("missing query")?,
                                request["replacement"]
                                    .as_str()
                                    .ok_or("missing replacement")?,
                                &cancel,
                            )?;
                        }
                        "checkpoint" => {
                            doc.checkpoint_at(revision, &cancel)?;
                        }
                        "saveCopy" => {
                            doc.save_copy(
                                Path::new(request["path"].as_str().ok_or("missing path")?),
                                revision,
                                &cancel,
                            )?;
                        }
                        "externalChanged" => {
                            return Ok(json!({"changed":doc.external_changed(&cancel)?}))
                        }
                        _ => return Err("unsupported prototype operation".into()),
                    }
                }
            }
            let doc = session.as_ref().ok_or("no session")?;
            Ok(
                json!({"revision":doc.revision(),"byteLength":doc.byte_length(),"directory":doc.directory(),"canUndo":doc.can_undo(),"canRedo":doc.can_redo()}),
            )
        })();
        let response = match result {
            Ok(value) => {
                json!({"ok":true,"value":value,"ms":started.elapsed().as_secs_f64()*1000.0})
            }
            Err(error) => {
                json!({"ok":false,"error":error.to_string(),"ms":started.elapsed().as_secs_f64()*1000.0})
            }
        };
        if writeln!(output, "{response}")
            .and_then(|_| output.flush())
            .is_err()
        {
            break;
        }
        if over_budget {
            break;
        }
    }
    if let Some(doc) = session.as_mut() {
        if let Err(error) = doc.checkpoint(&AtomicBool::new(false)) {
            eprintln!("未能保存最终恢复点，磁盘资产仍保留：{error}");
        }
    }
}
