/**
 * Submission-target tag helper: `#submitted:<conference> <year>`.
 *
 * This tag is a Host-owned compatibility projection. It is inferred from the
 * arXiv LaTeX template (the venue the paper was formatted for), not from a
 * scholarly API, and is removed once a real `publication` exists.
 *
 * `#venue:` is retired: `publication` is the single authoritative venue field.
 */

import { SUBMITTED_TAG_PREFIX } from "@/lib/paper/tag-namespaces";

export { SUBMITTED_TAG_PREFIX };

export function isSubmittedTagName(name: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(SUBMITTED_TAG_PREFIX);
}

/**
 * Display label with the namespace prefix removed.
 *
 * `#submitted:` keeps the "Submitted to" wording because the template-inferred
 * target is not a formal publication yet.
 */
export function formatVenueTag(name: string): string {
	const trimmed = name.trim();
	if (isSubmittedTagName(trimmed)) {
		return `Submitted to ${trimmed.slice(SUBMITTED_TAG_PREFIX.length)}`;
	}
	return name;
}
