/**
 * External address carried by a PDF link annotation.
 * URI actions and Launch file paths open the URL tip. GoTo destinations
 * stay on the citation and cross-reference cards.
 */
import { PdfActionType, type PdfLinkTarget } from "@embedpdf/models";

export function linkTargetUrl(
	target: PdfLinkTarget | undefined,
): string | null {
	const action = target?.type === "action" ? target.action : null;
	if (!action) return null;
	if (action.type === PdfActionType.URI) {
		const uri = action.uri.trim();
		return uri || null;
	}
	if (action.type === PdfActionType.LaunchAppOrOpenFile) {
		const path = action.path.trim();
		return path || null;
	}
	return null;
}
