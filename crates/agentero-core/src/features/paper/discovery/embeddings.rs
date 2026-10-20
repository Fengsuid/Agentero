//! Minimal OpenAI-compatible embeddings client shared by discovery ranking
//! and the desktop arXiv recommendation.
//!
//! Only the transport + vector math live here; caching (the catalog
//! `embed_cache`) stays with its callers.

use std::time::Duration;

use serde::Serialize;

use crate::error::AppError;

/// Default timeout for one embeddings request.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);
/// Inputs per `/embeddings` call. Qwen text-embedding caps a request at 20
/// inputs; other compatible providers differ, so keep the default at the cap
/// and let `embed_batch` halve-and-retry when a provider is stricter.
pub const EMBED_BATCH: usize = 20;

/// An OpenAI-compatible embeddings endpoint.
#[derive(Debug, Clone)]
pub struct EmbeddingConfig {
    /// Base URL (`https://host/v1`) or the full `/embeddings` URL.
    pub base_url: String,
    /// Optional bearer token.
    pub api_key: Option<String>,
    pub model: String,
}

/// Resolve a base URL into the full `/embeddings` URL.
///
/// Accepts trailing slashes and bases that already end in `/embeddings`.
pub fn resolve_endpoint(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return String::new();
    }
    if base.ends_with("/embeddings") {
        base.to_string()
    } else {
        format!("{base}/embeddings")
    }
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: &'a [String],
}

/// `L2`-normalize a vector in place (no-op for a zero vector).
pub fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > 0.0 {
        for v in vector.iter_mut() {
            *v /= norm;
        }
    }
}

/// Dot product (cosine similarity for L2-normalized inputs).
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// POST one batch of texts and return their vectors, in input order.
pub async fn embed_batch(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: Option<&str>,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let mut request = client.post(endpoint).json(&EmbedRequest {
        model,
        input: texts,
    });
    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {key}"));
    }
    let resp = request
        .send()
        .await
        .map_err(|e| AppError::message(format!("embeddings request failed: {e}")))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::message(format!("embeddings read body: {e}")))?;
    if !status.is_success() {
        // Provider batch caps differ (Qwen text-embedding is 20), so halve and
        // retry instead of failing the whole run.
        if texts.len() > 1 && is_batch_rejection(status, &body) {
            let mid = texts.len() / 2;
            let (head, tail) = texts.split_at(mid);
            log::warn!(
                "embeddings batch of {} rejected ({status}); retrying as {} + {}",
                texts.len(),
                head.len(),
                tail.len()
            );
            let mut out = Box::pin(embed_batch(client, endpoint, api_key, model, head)).await?;
            out.extend(Box::pin(embed_batch(client, endpoint, api_key, model, tail)).await?);
            return Ok(out);
        }
        let snippet = crate::http::http_err_snippet(&body);
        return Err(AppError::message(format!(
            "embeddings endpoint returned {status}: {snippet}"
        )));
    }
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| AppError::message(format!("embeddings parse: {e}")))?;
    let data = value
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| AppError::message("embeddings response has no data array"))?;
    let mut out = Vec::with_capacity(data.len());
    for entry in data {
        let vector: Vec<f32> = entry
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or_else(|| AppError::message("embeddings entry has no embedding"))?
            .iter()
            .filter_map(|v| v.as_f64())
            .map(|v| v as f32)
            .collect();
        if vector.is_empty() {
            return Err(AppError::message("embeddings entry is empty"));
        }
        out.push(vector);
    }
    if out.len() != texts.len() {
        return Err(AppError::message(format!(
            "embeddings returned {} vectors for {} inputs",
            out.len(),
            texts.len()
        )));
    }
    Ok(out)
}

/// True when a failed response looks like "too many inputs for one request".
fn is_batch_rejection(status: reqwest::StatusCode, body: &str) -> bool {
    if !matches!(status.as_u16(), 400 | 413 | 422) {
        return false;
    }
    let body = body.to_ascii_lowercase();
    body.contains("batch")
        || body.contains("too many input")
        || body.contains("too many text")
        || body.contains("maximum number of")
}

/// Embed every text with a fresh client, chunked to respect provider limits.
pub async fn embed_texts(
    config: &EmbeddingConfig,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, AppError> {
    let endpoint = resolve_endpoint(&config.base_url);
    if endpoint.is_empty() {
        return Err(AppError::message("embeddings: empty base URL"));
    }
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let client = crate::http::client_builder()
        .timeout(DEFAULT_TIMEOUT)
        .build()
        .map_err(|e| AppError::message(format!("embeddings http client: {e}")))?;
    let mut out = Vec::with_capacity(texts.len());
    for chunk in texts.chunks(EMBED_BATCH) {
        let vectors = embed_batch(
            &client,
            &endpoint,
            config.api_key.as_deref(),
            &config.model,
            chunk,
        )
        .await?;
        out.extend(vectors);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_endpoint_appends_embeddings_path() {
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/embeddings"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("https://api.openai.com/v1/embeddings/"),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(
            resolve_endpoint("  https://api.openai.com/v1/  "),
            "https://api.openai.com/v1/embeddings"
        );
        assert_eq!(resolve_endpoint(""), "");
    }

    #[test]
    fn normalize_makes_unit_length() {
        let mut v = vec![3.0_f32, 4.0];
        normalize(&mut v);
        assert!((dot(&v, &v) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn detects_batch_rejections() {
        assert!(is_batch_rejection(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"batch size is invalid, it should not be larger than 20."}}"#
        ));
        assert!(is_batch_rejection(
            reqwest::StatusCode::PAYLOAD_TOO_LARGE,
            "too many inputs"
        ));
        assert!(is_batch_rejection(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            "maximum number of texts exceeded"
        ));
        // Unrelated failures must not trigger the halving path.
        assert!(!is_batch_rejection(
            reqwest::StatusCode::UNAUTHORIZED,
            "invalid api key"
        ));
        assert!(!is_batch_rejection(
            reqwest::StatusCode::BAD_REQUEST,
            "model not found"
        ));
    }
}
