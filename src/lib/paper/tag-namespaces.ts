/**
 * System tag namespaces. These tags are written by the Host, not by the
 * renderer: the UI may display them but must not create, edit, or delete them.
 *
 * `#venue:` is retired. It is still recognized here so previously written
 * tags can be hidden immediately and cleaned up by the next Host sync.
 */

export const EASY_SCHOLAR_TAG_PREFIX = "#easyscholar:";
export const SUBMITTED_TAG_PREFIX = "#submitted:";
export const LEGACY_VENUE_TAG_PREFIX = "#venue:";

function hasPrefix(name: string, prefix: string): boolean {
	return name.trim().toLocaleLowerCase().startsWith(prefix);
}

export function isEasyScholarTagName(name: string): boolean {
	return hasPrefix(name, EASY_SCHOLAR_TAG_PREFIX);
}

export function isSubmittedTagName(name: string): boolean {
	return hasPrefix(name, SUBMITTED_TAG_PREFIX);
}

/** Retired authoritative-venue tag; never written again. */
export function isLegacyVenueTagName(name: string): boolean {
	return hasPrefix(name, LEGACY_VENUE_TAG_PREFIX);
}

/** Tags owned by the Host and unavailable to manual tag editing. */
export function isSystemManagedTagName(name: string): boolean {
	return isSubmittedTagName(name) || isEasyScholarTagName(name);
}
