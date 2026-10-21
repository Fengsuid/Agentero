//! Public lifecycle events for the plugin data API.
//!
//! Names and domain fields match `src/lib/lifecycle/events.ts`. Host-only
//! events (`window:closed`, `job:*`, `agent:registry-changed`, `app:ready`)
//! are not part of this catalog. There is no subscription API yet.

use serde::Serialize;

/// One public lifecycle event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicEventSpec {
    pub name: &'static str,
    pub summary: &'static str,
    /// Domain payload fields. The host also sends `timestamp`; `paper:renamed`
    /// also sends `updatedSources`. Those are outside this v0 field list.
    pub payload_fields: &'static [&'static str],
}

const EVENTS: &[PublicEventSpec] = &[
    PublicEventSpec {
        name: "vault:opened",
        summary: "A vault was opened or switched to.",
        payload_fields: &["vaultId"],
    },
    PublicEventSpec {
        name: "paper:imported",
        summary: "A paper was committed to the catalog.",
        payload_fields: &["vaultId", "paperId"],
    },
    PublicEventSpec {
        name: "paper:assets-ready",
        summary: "PDF, TeX, or PAPER.md for an imported paper finished.",
        payload_fields: &["vaultId", "paperId"],
    },
    PublicEventSpec {
        name: "paper:renamed",
        summary: "Deferred recognition renamed a paper folder or merged it into an existing entry.",
        payload_fields: &[
            "vaultId",
            "oldPaperId",
            "newPaperId",
            "oldPath",
            "newPath",
            "outcome",
        ],
    },
    PublicEventSpec {
        name: "paper:opened",
        summary: "A paper was opened in the workspace.",
        payload_fields: &["paperId"],
    },
];

/// The five public lifecycle events. Order is stable.
pub fn public_events() -> &'static [PublicEventSpec] {
    EVENTS
}
