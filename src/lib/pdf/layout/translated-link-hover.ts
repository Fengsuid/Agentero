/**
 * Which hover card a translated link token should open.
 *
 * The token is the hit target (the English link rect stays under the glyphs).
 * External addresses use the URL tip; in-document links use the citation /
 * crossref cards. Leaving the token clears both.
 */

import type { PdfLinkAnnoObject } from "@embedpdf/models";
import { linkTargetUrl } from "@/components/viewer/pdf/layers/citation-links";
import type { PreservedLinkAssignment } from "@/lib/pdf/layout/translated-links";

export type TranslatedLinkHoverAction =
	| { kind: "clear" }
	| { kind: "url"; url: string }
	| { kind: "citation"; link: PdfLinkAnnoObject };

export function translatedLinkHoverAction(
	assignment: PreservedLinkAssignment | null,
	link: PdfLinkAnnoObject | undefined,
): TranslatedLinkHoverAction {
	if (!assignment) return { kind: "clear" };
	const annotationUrl = link ? linkTargetUrl(link.target) : null;
	const assignedUrl = assignment.url?.trim() ?? "";
	const url = annotationUrl || assignedUrl;
	if (url) return { kind: "url", url };
	if (link) return { kind: "citation", link };
	return { kind: "clear" };
}
