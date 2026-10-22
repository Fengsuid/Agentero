use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Read, Write};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Invocation {
    pub source: String,
    pub command: String,
    pub context: Value,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub op: String,
    pub args: Value,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Frame {
    Call { request: Request },
    Done { value: Value },
    Failed { message: String },
}

pub fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() >= crate::MAX_FRAME {
        return Err("plugin_frame_too_large".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn read_line(reader: impl Read) -> Result<String, String> {
    let mut line = String::new();
    std::io::BufReader::new(reader.take(crate::MAX_FRAME as u64 + 1))
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    if line.len() > crate::MAX_FRAME || !line.ends_with('\n') {
        return Err("plugin_invalid_frame".into());
    }
    Ok(line)
}

pub fn send(value: &impl Serialize) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    output
        .write_all(&encode(value)?)
        .map_err(|e| e.to_string())?;
    output.flush().map_err(|e| e.to_string())
}
