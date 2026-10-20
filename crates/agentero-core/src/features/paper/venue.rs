//! Submission-target inference from an arXiv e-print's LaTeX source, projected
//! onto a Host-owned catalog tag.
//!
//! `#submitted:<VENUE> <YEAR>` is inferred from the LaTeX template
//! (`\documentclass` / `\usepackage` / bundled `.sty`/`.cls` names), i.e. the
//! venue the paper was formatted for. It is a compatibility projection, not a
//! scholarly-API field: `publication` remains the single authoritative venue.
//!
//! The retired `#venue:` namespace is never written again. Any leftover tags
//! are removed during sync; `publication` is shown directly by the UI.
//!
//! Rules:
//! - Authoritative `publication` present → drop `#submitted:` (and legacy `#venue:`).
//! - Otherwise → add `#submitted:` only when it does not exist yet and no user
//!   tag already names that venue.
//! - EasyScholar metrics are refreshed by the same sync entry point and stored
//!   as `#easyscholar:` tags (also Host-owned).

use crate::error::AppError;
use crate::features::paper::catalog::papers::{self, PaperTag};
use crate::features::paper::scholar_api::sources::easy_scholar::{
    is_easyscholar_tag, merge_easyscholar_tags, strip_easyscholar_journal_tags,
    strip_easyscholar_tags, tags_from_metrics, EasyScholarApi,
};
use crate::features::paper::scholar_api::traits::VenueMetricsSource;
use crate::features::paper::scholar_api::VenueIdentifiers;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::Path;
use walkdir::WalkDir;

/// Tag namespace for the template-inferred submission target.
pub const SUBMITTED_TAG_PREFIX: &str = "#submitted:";
/// Retired authoritative-venue namespace; only read for cleanup.
const LEGACY_VENUE_TAG_PREFIX: &str = "#venue:";

/// Upper bounds keeping detection cheap on e-prints with hundreds of files.
const MAX_TEX_FILES: usize = 200;
const MAX_TEX_HEAD_BYTES: u64 = 256 * 1024;

/// Whether `name` is a template-inferred submission tag.
pub fn is_submitted_tag_name(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(SUBMITTED_TAG_PREFIX)
}

/// Whether `name` is a retired authoritative-venue tag.
fn is_legacy_venue_tag_name(name: &str) -> bool {
    name.trim()
        .to_ascii_lowercase()
        .starts_with(LEGACY_VENUE_TAG_PREFIX)
}

/// One template token mapped to its venue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedVenue {
    /// Abbreviated venue, e.g. `AAAI`.
    pub venue: &'static str,
    /// Four-digit year when the template token carries one.
    pub year: Option<u16>,
    /// The source token that matched (for logs / tests).
    pub evidence: String,
}

impl DetectedVenue {
    /// `#submitted:AAAI 2027` (or without the year when unknown).
    pub fn submitted_tag_name(&self) -> String {
        match self.year {
            Some(year) => format!("{SUBMITTED_TAG_PREFIX}{} {year}", self.venue),
            None => format!("{SUBMITTED_TAG_PREFIX}{}", self.venue),
        }
    }
}

/// Curated template-token prefixes → venue abbreviation. Kept short and
/// conservative: only tokens that unambiguously name a venue belong here, so a
/// generic `article`/`elsarticle`/`IEEEtran` never produces a tag.
const VENUE_TABLE: &[(&str, &str)] = &[
    ("aaai", "AAAI"),
    ("ijcai", "IJCAI"),
    ("iclr", "ICLR"),
    ("icml", "ICML"),
    ("neurips", "NeurIPS"),
    ("nips", "NeurIPS"),
    ("cvpr", "CVPR"),
    ("iccv", "ICCV"),
    ("eccv", "ECCV"),
    ("wacv", "WACV"),
    ("emnlp", "EMNLP"),
    ("naacl", "NAACL"),
    ("coling", "COLING"),
    ("colm", "COLM"),
    ("acl", "ACL"),
    ("tacl", "TACL"),
    ("sigkdd", "KDD"),
    ("kdd", "KDD"),
    ("sigir", "SIGIR"),
    ("www", "WWW"),
    ("miccai", "MICCAI"),
    ("ijcv", "IJCV"),
    ("tpami", "TPAMI"),
    ("tkde", "TKDE"),
    ("jmlr", "JMLR"),
    ("aistats", "AISTATS"),
    ("uai", "UAI"),
    ("icra", "ICRA"),
    ("iros", "IROS"),
    ("corl", "CoRL"),
    ("osdi", "OSDI"),
    ("sosp", "SOSP"),
    ("nsdi", "NSDI"),
    ("ndss", "NDSS"),
];

/// Map one lowercased template token (file stem or package/class name) to a
/// venue. Trailing digits are read as a year (`aaai26` → 2026,
/// `iclr2027_conference` → 2027, `acl_natbib` → no year).
fn match_token(token: &str) -> Option<DetectedVenue> {
    let token = token.trim().trim_start_matches('*');
    if token.is_empty() {
        return None;
    }
    for (prefix, venue) in VENUE_TABLE {
        if let Some(rest) = token.strip_prefix(prefix) {
            return Some(DetectedVenue {
                venue,
                year: extract_year(rest),
                evidence: token.to_string(),
            });
        }
    }
    None
}

/// First 2- or 4-digit run in `rest`, interpreted as a year. 2-digit values are
/// 20xx (conference templates never carry a 19xx two-digit year).
fn extract_year(rest: &str) -> Option<u16> {
    let bytes = rest.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            let run = &rest[start..i];
            match run.len() {
                2 => return Some(2000 + run.parse::<u16>().ok()?),
                4 => {
                    let year = run.parse::<u16>().ok()?;
                    if (1980..=2099).contains(&year) {
                        return Some(year);
                    }
                }
                _ => {}
            }
        } else {
            i += 1;
        }
    }
    None
}

/// Infer the target venue from a paper's `source/` tree. `None` when the source
/// is absent/PDF-only or no known template token matches.
pub fn detect_venue(source_dir: &Path) -> Option<DetectedVenue> {
    if !source_dir.is_dir() {
        return None;
    }
    let mut doc_tokens: Vec<String> = Vec::new();
    let mut file_tokens: Vec<String> = Vec::new();
    let mut pkg_tokens: Vec<String> = Vec::new();
    let mut tex_read = 0usize;

    for entry in WalkDir::new(source_dir)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        match ext.as_str() {
            "sty" | "cls" | "bst" => {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    file_tokens.push(stem.to_ascii_lowercase());
                }
            }
            "tex" => {
                if tex_read >= MAX_TEX_FILES {
                    continue;
                }
                tex_read += 1;
                if let Some(head) = read_head(path, MAX_TEX_HEAD_BYTES) {
                    collect_cmd_args(&head, "\\documentclass", &mut doc_tokens);
                    collect_cmd_args(&head, "\\usepackage", &mut pkg_tokens);
                }
            }
            _ => {}
        }
    }

    // Priority: explicit document class, then bundled template files, then
    // packages.
    doc_tokens
        .iter()
        .chain(file_tokens.iter())
        .chain(pkg_tokens.iter())
        .find_map(|token| match_token(token))
}

/// Read at most `limit` bytes as lossy UTF-8 (LaTeX preambles are ASCII-ish).
fn read_head(path: &Path, limit: u64) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; limit as usize];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Append the comma-split braced arguments of every `cmd` occurrence in
/// `content` (e.g. `\usepackage[opt]{a,b}` → `a`, `b`).
fn collect_cmd_args(content: &str, cmd: &str, out: &mut Vec<String>) {
    let mut from = 0;
    while let Some(pos) = content[from..].find(cmd) {
        let at = from + pos;
        let after_cmd = &content[at + cmd.len()..];
        // Guard against a longer command sharing the prefix (`\documentclassx`).
        if after_cmd
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
        {
            from = at + cmd.len();
            continue;
        }
        if let Some(group) = group_after(after_cmd) {
            for name in group.split(',') {
                let name = name.trim().trim_start_matches('*').trim();
                if !name.is_empty() {
                    out.push(name.to_ascii_lowercase());
                }
            }
        }
        from = at + cmd.len();
    }
}

/// First `{...}` group in `s` (skips a preceding `[...]` naturally).
fn group_after(s: &str) -> Option<&str> {
    let open = s.find('{')?;
    let rest = &s[open + 1..];
    let close = rest.find('}')?;
    Some(&rest[..close])
}

/// Whether a user tag already names `venue` (bare `ICLR`, or `#submitted:ICLR 2027`).
fn tag_names_venue(name: &str, venue: &str) -> bool {
    let mut normalized = name.trim().to_ascii_lowercase();
    if let Some(rest) = normalized.strip_prefix(SUBMITTED_TAG_PREFIX) {
        normalized = rest.to_string();
    }
    let venue = venue.to_ascii_lowercase();
    normalized == venue || normalized.starts_with(&format!("{venue} "))
}

/// Repository / preprint-server names that must never be treated as a venue.
/// Metadata APIs sometimes fill `publication` with these — e.g. Semantic
/// Scholar reports `arXiv (Cornell University)` for preprints.
fn is_repository_venue(name: &str) -> bool {
    let name = name.trim().to_ascii_lowercase();
    if name.is_empty() {
        return true;
    }
    const MARKERS: &[&str] = &[
        "arxiv",
        "biorxiv",
        "medrxiv",
        "chemrxiv",
        "techrxiv",
        "ssrn",
        "research square",
        "researchesquare",
        "preprints.org",
        "osf preprint",
        "zenodo",
        "semantic scholar",
        "researchgate",
        "scienceopen",
        "openreview",
    ];
    MARKERS.iter().any(|marker| name.contains(marker))
}

/// The authoritative published venue, or `None` for empty/repository values.
fn real_publication(publication: Option<&str>) -> Option<&str> {
    publication
        .map(str::trim)
        .filter(|s| !s.is_empty() && !is_repository_venue(s))
}

/// Decide the Host-owned submission tag set for a paper.
///
/// `#venue:` is retired and always removed. With a real `publication`, the
/// submission guess is stale and removed too. Otherwise the existing guess is
/// kept; a new one is added only when the LaTeX template names a venue that no
/// user tag already mentions.
pub fn plan_submission_tags(
    existing: &[PaperTag],
    publication: Option<&str>,
    detected: Option<&DetectedVenue>,
) -> Vec<PaperTag> {
    let mut next: Vec<PaperTag> = existing
        .iter()
        .filter(|t| !is_legacy_venue_tag_name(&t.name))
        .cloned()
        .collect();

    if real_publication(publication).is_some() {
        next.retain(|t| !is_submitted_tag_name(&t.name));
        return next;
    }

    if next.iter().any(|t| is_submitted_tag_name(&t.name)) {
        return next;
    }
    let Some(detected) = detected else {
        return next;
    };
    if next
        .iter()
        .any(|t| tag_names_venue(&t.name, detected.venue))
    {
        return next;
    }
    next.push(PaperTag::new(detected.submitted_tag_name()));
    next
}

/// Recompute the Host-owned submission tag for one paper.
/// Returns whether the tag set changed.
pub fn sync_venue_tag(vault_root: &Path, paper_path: &str) -> Result<bool, AppError> {
    let Some(record) = papers::get_by_path(vault_root, paper_path)? else {
        return Ok(false);
    };
    let source_dir = vault_root.join(paper_path).join("source");
    let detected = detect_venue(&source_dir);
    let next = plan_submission_tags(
        &record.tags,
        record.publication.as_deref(),
        detected.as_ref(),
    );
    if next == record.tags {
        return Ok(false);
    }
    papers::set_tags(vault_root, paper_path, &next)?;
    Ok(true)
}

/// Result of one publication sync over a Library scope.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct VenueSyncReport {
    /// Papers whose tag projection changed (submission, legacy cleanup, metrics).
    pub updated: usize,
    /// Papers whose EasyScholar metrics were refreshed.
    pub metrics_updated: usize,
    /// Papers where the EasyScholar request failed; existing metrics are kept.
    pub metrics_failed: usize,
}

fn normalize_paper_path(raw: &str) -> Option<String> {
    let path = raw.trim().trim_matches('/').replace('\\', "/");
    (!path.is_empty()).then_some(path)
}

/// Single Host-side entry point for publication-derived state.
///
/// 1. Recompute the `#submitted:` projection and drop legacy `#venue:` tags.
/// 2. Drop the retired EasyScholar `journal=` tag.
/// 3. When the scope has a real `publication` and a key is configured, replace
///    the `#easyscholar:` metrics namespace with fresh data.
///
/// A failed EasyScholar request never clears existing metrics; a paper without
/// a real publication has no valid metrics and is cleaned instead.
pub async fn sync_publication(
    vault_root: &Path,
    paper_paths: &[String],
    easyscholar_key: Option<&str>,
) -> Result<VenueSyncReport, AppError> {
    let api = easyscholar_key
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(EasyScholarApi::new);
    let mut report = VenueSyncReport {
        updated: 0,
        metrics_updated: 0,
        metrics_failed: 0,
    };

    for raw in paper_paths {
        let Some(path) = normalize_paper_path(raw) else {
            continue;
        };
        let Some(record) = papers::get_by_path(vault_root, &path)? else {
            continue;
        };
        let source_dir = vault_root.join(&path).join("source");
        let detected = detect_venue(&source_dir);
        let mut tags = strip_easyscholar_journal_tags(&plan_submission_tags(
            &record.tags,
            record.publication.as_deref(),
            detected.as_ref(),
        ));

        let published = real_publication(record.publication.as_deref());
        // Metrics are a function of `publication`. A publication change strips
        // them in `update_meta`, so presence means "already fetched for the
        // current venue"; retry only when the namespace is missing/empty.
        let has_metrics = tags.iter().any(|tag| is_easyscholar_tag(&tag.name));
        match (published, &api) {
            (Some(publication), Some(api)) if !has_metrics => {
                match api
                    .fetch_metrics(publication, &VenueIdentifiers::default())
                    .await
                {
                    Ok(metrics) => {
                        let merged = merge_easyscholar_tags(&tags, &tags_from_metrics(&metrics));
                        if merged != tags {
                            tags = merged;
                            report.metrics_updated += 1;
                        }
                    }
                    Err(error) => {
                        report.metrics_failed += 1;
                        log::warn!(
                            target: "agentero::paper",
                            "EasyScholar metrics refresh failed for {path}: {error}"
                        );
                    }
                }
            }
            // No real venue: metrics no longer describe this paper.
            (None, _) => {
                let stripped = strip_easyscholar_tags(&tags);
                if stripped != tags {
                    tags = stripped;
                    report.metrics_updated += 1;
                }
            }
            // Key missing or metrics already present for this publication.
            (Some(_), _) => {}
        }

        if tags != record.tags {
            papers::set_tags(vault_root, &path, &tags)?;
            report.updated += 1;
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn tag(name: &str) -> PaperTag {
        PaperTag::new(name)
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    fn source_dir() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        fs::create_dir_all(&source).unwrap();
        (dir, source)
    }

    #[test]
    fn match_token_reads_venue_and_year() {
        assert_eq!(match_token("aaai26").unwrap().venue, "AAAI");
        assert_eq!(match_token("aaai26").unwrap().year, Some(2026));
        assert_eq!(match_token("iclr2027_conference").unwrap().year, Some(2027));
        assert_eq!(match_token("neurips_2026").unwrap().venue, "NeurIPS");
        assert_eq!(match_token("neurips_2026").unwrap().year, Some(2026));
        assert_eq!(match_token("nips2017").unwrap().venue, "NeurIPS");
        assert_eq!(match_token("acl_natbib").unwrap().venue, "ACL");
        assert_eq!(match_token("acl_natbib").unwrap().year, None);
        assert!(match_token("article").is_none());
        assert!(match_token("elsarticle").is_none());
    }

    #[test]
    fn detect_venue_prefers_documentclass_then_sty() {
        let (_dir, source) = source_dir();
        write(
            &source.join("main.tex"),
            "\\documentclass[11pt]{aaai26}\n\\usepackage{times}\n",
        );
        let detected = detect_venue(&source).expect("detected");
        assert_eq!(detected.venue, "AAAI");
        assert_eq!(detected.year, Some(2026));

        let (_dir2, source2) = source_dir();
        write(&source2.join("main.tex"), "\\documentclass{article}\n");
        write(&source2.join("iclr2027.sty"), "% template\n");
        let detected2 = detect_venue(&source2).expect("detected from sty");
        assert_eq!(detected2.venue, "ICLR");
        assert_eq!(detected2.year, Some(2027));
    }

    #[test]
    fn detect_venue_uses_usepackage_fallback() {
        let (_dir, source) = source_dir();
        write(
            &source.join("paper.tex"),
            "\\documentclass{article}\n\\usepackage[final]{neurips_2026}\n",
        );
        let detected = detect_venue(&source).expect("detected");
        assert_eq!(detected.venue, "NeurIPS");
        assert_eq!(detected.year, Some(2026));
    }

    #[test]
    fn plan_keeps_existing_submission_tag() {
        let detected = DetectedVenue {
            venue: "ICLR",
            year: Some(2027),
            evidence: "iclr2027".into(),
        };
        assert_eq!(
            plan_submission_tags(&[tag("#submitted:AAAI 2026")], None, Some(&detected)),
            vec![tag("#submitted:AAAI 2026")]
        );
        // A bare user tag naming the venue also suppresses a new guess.
        assert_eq!(
            plan_submission_tags(&[tag("ICLR")], None, Some(&detected)),
            vec![tag("ICLR")]
        );
    }

    #[test]
    fn plan_adds_submitted_tag_when_untagged() {
        let detected = DetectedVenue {
            venue: "AAAI",
            year: Some(2027),
            evidence: "aaai27".into(),
        };
        assert_eq!(
            plan_submission_tags(&[tag("nlp")], None, Some(&detected)),
            vec![tag("nlp"), tag("#submitted:AAAI 2027")]
        );
    }

    #[test]
    fn published_venue_drops_submission_and_legacy_venue_tags() {
        let existing = vec![
            tag("nlp"),
            tag("#submitted:AAAI 2027"),
            tag("#venue:AAAI 2027"),
        ];
        assert_eq!(
            plan_submission_tags(&existing, Some("ICLR"), None),
            vec![tag("nlp")]
        );
    }

    #[test]
    fn legacy_venue_tag_is_removed_without_publication() {
        let detected = DetectedVenue {
            venue: "ICLR",
            year: Some(2027),
            evidence: "iclr2027".into(),
        };
        assert_eq!(
            plan_submission_tags(&[tag("#venue:ICLR")], Some("arXiv"), Some(&detected)),
            vec![tag("#submitted:ICLR 2027")]
        );
        assert_eq!(
            plan_submission_tags(&[tag("#venue:arXiv (Cornell University)")], None, None),
            Vec::<PaperTag>::new()
        );
    }

    #[test]
    fn repository_publication_is_not_a_venue() {
        let detected = DetectedVenue {
            venue: "ICLR",
            year: Some(2027),
            evidence: "iclr2027".into(),
        };
        // Repository `publication` → template path, no authoritative tag.
        assert_eq!(
            plan_submission_tags(&[], Some("arXiv (Cornell University)"), Some(&detected)),
            vec![tag("#submitted:ICLR 2027")]
        );
        // A repository publication keeps the template guess.
        assert_eq!(
            plan_submission_tags(
                &[tag("#submitted:ICLR 2027")],
                Some("bioRxiv"),
                Some(&detected),
            ),
            vec![tag("#submitted:ICLR 2027")]
        );
        // A real published venue still wins.
        assert_eq!(
            plan_submission_tags(&[], Some("NeurIPS"), None),
            Vec::<PaperTag>::new()
        );
    }
}
