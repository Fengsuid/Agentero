//! Follow-up work after a paper commit or asset download.
//!
//! The plan is pure data: asset flags decide the steps, and no host is
//! required to build it. Desktop enqueues the steps; the CLI reports them
//! and does not run them. `None` host hooks no longer mean "do not schedule".

/// One follow-up the commit/download path used to start immediately.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PreparationStep {
    /// Generate `PAPER.md` when the paper has a PDF and neither TeX nor
    /// `PAPER.md`. `force` matches the flag previously passed to the spawn.
    ParseBody { force: bool },
    /// Parse the references sidecar.
    ParseRefs,
    /// Resolve placeholder metadata for a just-committed local PDF.
    RecognizeMetadata,
}

impl PreparationStep {
    /// Short label for CLI skip lines.
    pub fn label(&self) -> &'static str {
        match self {
            Self::ParseBody { force: true } => "ParseBody(force)",
            Self::ParseBody { force: false } => "ParseBody",
            Self::ParseRefs => "ParseRefs",
            Self::RecognizeMetadata => "RecognizeMetadata",
        }
    }
}

/// Steps that should run for one vault-relative paper folder.
///
/// `vault_rel` is the paper folder (`papers/id`), the same path the old
/// spawn hooks received.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PreparationPlan {
    pub vault_rel: String,
    pub steps: Vec<PreparationStep>,
}

impl PreparationPlan {
    /// Named paper with nothing to schedule (dedupe, skip, deferred assets
    /// that this call does not follow).
    pub fn empty(vault_rel: impl Into<String>) -> Self {
        Self {
            vault_rel: vault_rel.into(),
            steps: Vec::new(),
        }
    }

    pub fn has_parse_body(&self) -> bool {
        self.steps
            .iter()
            .any(|step| matches!(step, PreparationStep::ParseBody { .. }))
    }
}

/// Steps after a new commit or an on-demand asset download.
///
/// Same conditions as the old spawn calls: `ParseBody` only for a PDF with
/// neither TeX nor `PAPER.md`; `ParseRefs` whenever parse jobs are not
/// deferred. `defer_parse_jobs` yields no steps — the caller appends
/// `RecognizeMetadata` when recognition owns the later work.
pub fn plan_after_assets(
    vault_rel: impl Into<String>,
    pdf: bool,
    tex: bool,
    paper_md: bool,
    defer_parse_jobs: bool,
) -> PreparationPlan {
    let mut steps = Vec::new();
    if !defer_parse_jobs {
        if pdf && !tex && !paper_md {
            steps.push(PreparationStep::ParseBody { force: false });
        }
        steps.push(PreparationStep::ParseRefs);
    }
    PreparationPlan {
        vault_rel: vault_rel.into(),
        steps,
    }
}

/// Steps when a PDF is merged into an existing catalog entry.
///
/// Body and refs are planned together, and only when the file became the
/// main PDF of an entry that still has no TeX and no `PAPER.md`.
pub fn plan_after_merged_pdf(
    vault_rel: impl Into<String>,
    became_main: bool,
    pdf: bool,
    tex: bool,
    paper_md: bool,
) -> PreparationPlan {
    let mut steps = Vec::new();
    if became_main && pdf && !tex && !paper_md {
        steps.push(PreparationStep::ParseBody { force: false });
        steps.push(PreparationStep::ParseRefs);
    }
    PreparationPlan {
        vault_rel: vault_rel.into(),
        steps,
    }
}

/// One human line naming the steps a headless caller did not run.
/// `None` when the plan has nothing to skip.
pub fn skipped_preparation_line(plan: &PreparationPlan) -> Option<String> {
    if plan.steps.is_empty() {
        return None;
    }
    let steps = plan
        .steps
        .iter()
        .map(PreparationStep::label)
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "skipped preparation for {}: {steps}",
        plan.vault_rel
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_without_tex_or_paper_md_plans_parse_body() {
        let planned = plan_after_assets("papers/demo", true, false, false, false);
        assert_eq!(
            planned.steps,
            vec![
                PreparationStep::ParseBody { force: false },
                PreparationStep::ParseRefs,
            ]
        );

        // TeX or an existing PAPER.md suppresses ParseBody. Refs stay,
        // matching the old "always parse refs unless deferred" call.
        let with_tex = plan_after_assets("papers/demo", true, true, false, false);
        assert!(!with_tex
            .steps
            .iter()
            .any(|step| matches!(step, PreparationStep::ParseBody { .. })));
        assert_eq!(with_tex.steps, vec![PreparationStep::ParseRefs]);

        let with_paper_md = plan_after_assets("papers/demo", true, false, true, false);
        assert!(!with_paper_md
            .steps
            .iter()
            .any(|step| matches!(step, PreparationStep::ParseBody { .. })));
        assert_eq!(with_paper_md.steps, vec![PreparationStep::ParseRefs]);

        let deferred = plan_after_assets("papers/demo", true, false, false, true);
        assert!(deferred.steps.is_empty());
    }

    #[test]
    fn building_the_plan_does_not_require_host_hooks() {
        // Asset flags only. This test constructs no `AppHandle` or `HostHooks`.
        let plan = plan_after_assets("papers/demo", true, false, false, false);
        assert_eq!(plan.vault_rel, "papers/demo");
        assert!(plan.has_parse_body());
        assert!(skipped_preparation_line(&plan).is_some());
    }
}
