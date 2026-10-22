use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, Write};

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
    /// Host handshake written after engine limits are installed and before user JS.
    /// `clean_env` is host-to-host; guest code cannot read it.
    Ready {
        clean_env: bool,
    },
    Call {
        request: Request,
    },
    Done {
        value: Value,
    },
    Failed {
        code: String,
        message: String,
    },
}

pub fn encode(value: &impl Serialize) -> Result<Vec<u8>, String> {
    encode_limited(value, crate::MAX_FRAME)
}

pub(crate) fn encode_invocation(value: &impl Serialize) -> Result<Vec<u8>, String> {
    encode_limited(value, crate::MAX_INVOCATION)
}

fn encode_limited(value: &impl Serialize, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = serde_json::to_vec(value).map_err(|_| "plugin_worker_failed".to_string())?;
    if bytes.len() >= limit {
        return Err("plugin_frame_too_large".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

/// One frame from a reader that already owns the stream buffer.
/// A new `BufReader` per frame would discard bytes read ahead of the newline.
pub fn read_line(reader: &mut impl BufRead) -> Result<String, String> {
    read_limited(reader, crate::MAX_FRAME)
}

pub(crate) fn read_limited(reader: &mut impl BufRead, limit: usize) -> Result<String, String> {
    let mut line = Vec::new();
    loop {
        let (take, done) = {
            let buf = reader
                .fill_buf()
                .map_err(|_| "plugin_worker_failed".to_string())?;
            if buf.is_empty() {
                (0, true)
            } else if let Some(pos) = buf.iter().position(|byte| *byte == b'\n') {
                let take = pos + 1;
                if line.len() + take > limit {
                    return Err("plugin_invalid_frame".into());
                }
                line.extend_from_slice(&buf[..take]);
                (take, true)
            } else {
                let take = buf.len();
                if line.len() + take > limit {
                    return Err("plugin_invalid_frame".into());
                }
                line.extend_from_slice(buf);
                (take, false)
            }
        };
        if take == 0 {
            break;
        }
        reader.consume(take);
        if done {
            break;
        }
    }
    if line.last() != Some(&b'\n') {
        return Err(if line.is_empty() {
            "plugin_worker_failed".into()
        } else {
            "plugin_invalid_frame".into()
        });
    }
    String::from_utf8(line).map_err(|_| "plugin_invalid_frame".into())
}

pub fn write_frame(bytes: &[u8]) -> Result<(), String> {
    let mut output = std::io::stdout().lock();
    output
        .write_all(bytes)
        .map_err(|_| "plugin_worker_failed".to_string())?;
    output
        .flush()
        .map_err(|_| "plugin_worker_failed".to_string())
}

pub fn send(value: &impl Serialize) -> Result<(), String> {
    write_frame(&encode(value)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn escaped_quotes_can_exceed_max_frame_within_invocation_budget() {
        let input = Invocation {
            source: "\"".repeat(128 * 1024),
            command: "inspect".into(),
            context: json!({"paperRef": "papers/demo"}),
        };
        let encoded = encode_invocation(&input).expect("invocation budget");
        assert!(encoded.len() > crate::MAX_FRAME);
        assert!(encoded.len() <= crate::MAX_INVOCATION);
        assert_eq!(encode(&input).unwrap_err(), "plugin_frame_too_large");
    }

    #[test]
    fn invocation_over_two_mib_is_rejected() {
        let input = Invocation {
            source: "a".repeat(crate::MAX_INVOCATION),
            command: "inspect".into(),
            context: json!(null),
        };
        assert_eq!(
            encode_invocation(&input).unwrap_err(),
            "plugin_frame_too_large"
        );
    }
}
