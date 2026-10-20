/**
 * Minimal brace-aware BibTeX parser for editor affordances.
 * Mirrors `crates/agentero-core/.../refs/bib.rs` and adds source ranges.
 */

export type BibFields = Record<string, string>;

export type BibEntry = {
	key: string;
	/** Lowercased entry type (`article`, `inproceedings`, …). */
	kind: string;
	/** Lowercased field name → plain value (outer braces/quotes stripped). */
	fields: BibFields;
	/** Document offset of the leading `@`. */
	from: number;
	/** Document offset just past the closing `}` / `)`. */
	to: number;
};

const SKIP_KINDS = new Set(["comment", "preamble", "string"]);

/**
 * Parse BibTeX entries from a full document string.
 * Skips `@comment` / `@preamble` / `@string`. Best-effort on malformed input.
 */
export function parseBibEntries(input: string): BibEntry[] {
	const entries: BibEntry[] = [];
	let i = 0;
	const n = input.length;

	while (i < n) {
		if (input.charCodeAt(i) !== 0x40 /* @ */) {
			i += 1;
			continue;
		}
		const from = i;
		i += 1;

		const kindStart = i;
		while (i < n && isAsciiAlpha(input.charCodeAt(i))) i += 1;
		const kind = input.slice(kindStart, i).toLowerCase();
		i = skipWs(input, i);
		if (i >= n) break;

		const open = input.charCodeAt(i);
		if (open !== 0x7b /* { */ && open !== 0x28 /* ( */) continue;
		const closer = open === 0x7b ? 0x7d /* } */ : 0x29 /* ) */;
		i += 1;

		if (SKIP_KINDS.has(kind)) {
			i = skipBalanced(input, i, closer);
			continue;
		}

		const keyStart = i;
		while (i < n) {
			const c = input.charCodeAt(i);
			if (c === 0x2c /* , */ || c === closer) break;
			i += 1;
		}
		const key = input.slice(keyStart, i).trim();
		if (i < n && input.charCodeAt(i) === 0x2c) i += 1;

		const fields: BibFields = {};
		for (;;) {
			i = skipWsAndCommas(input, i);
			if (i >= n || input.charCodeAt(i) === closer) {
				if (i < n) i += 1;
				break;
			}
			const nameStart = i;
			while (i < n) {
				const c = input.charCodeAt(i);
				if (c === 0x3d /* = */ || c === closer) break;
				i += 1;
			}
			if (i >= n || input.charCodeAt(i) !== 0x3d) continue;
			const name = input.slice(nameStart, i).trim().toLowerCase();
			i += 1;
			const [value, next] = parseValue(input, i, closer);
			i = next;
			if (name && value) fields[name] = value;
		}

		if (key) {
			entries.push({ key, kind, fields, from, to: i });
		}
	}

	return entries;
}

/** Entry that contains document offset `pos` (half-open `[from, to)`). */
export function bibEntryAt(entries: BibEntry[], pos: number): BibEntry | null {
	for (const e of entries) {
		if (pos >= e.from && pos < e.to) return e;
	}
	return null;
}

/** First author surname for Scholar `author:` queries. */
export function firstAuthorSurname(
	authorField: string | undefined,
): string | null {
	if (!authorField?.trim()) return null;
	const first = authorField.split(/\s+and\s+/i)[0]?.trim();
	if (!first || /^others$/i.test(first)) return null;
	const comma = first.indexOf(",");
	if (comma >= 0) {
		const last = first.slice(0, comma).trim();
		return last || null;
	}
	// "First Last" / "First von Last" → last token
	const parts = first.split(/\s+/).filter(Boolean);
	return parts.length ? (parts[parts.length - 1] ?? null) : null;
}

function parseValue(
	input: string,
	start: number,
	closer: number,
): [string, number] {
	const parts: string[] = [];
	let i = start;
	const n = input.length;

	for (;;) {
		i = skipWs(input, i);
		if (i >= n) break;
		const c = input.charCodeAt(i);
		if (c === 0x7b /* { */) {
			const innerStart = i + 1;
			const end = skipBalanced(input, innerStart, 0x7d);
			parts.push(plainFieldText(input.slice(innerStart, end - 1)));
			i = end;
		} else if (c === 0x22 /* " */) {
			const innerStart = i + 1;
			let depth = 0;
			let j = innerStart;
			while (j < n) {
				const cj = input.charCodeAt(j);
				if (cj === 0x7b) depth += 1;
				else if (cj === 0x7d) depth = Math.max(0, depth - 1);
				else if (cj === 0x22 && depth === 0) break;
				j += 1;
			}
			parts.push(plainFieldText(input.slice(innerStart, j)));
			i = Math.min(j + 1, n);
		} else {
			const bareStart = i;
			while (i < n) {
				const cj = input.charCodeAt(i);
				if (cj === 0x2c || cj === closer || cj === 0x23 /* # */ || isWs(cj)) {
					break;
				}
				i += 1;
			}
			parts.push(input.slice(bareStart, i));
		}
		i = skipWs(input, i);
		if (i < n && input.charCodeAt(i) === 0x23 /* # */) {
			i += 1;
			continue;
		}
		break;
	}

	return [parts.join("").trim(), i];
}

/** Drop protection braces and light TeX noise for search queries. */
function plainFieldText(raw: string): string {
	return raw
		.replace(/\{\s*([^{}]*)\s*\}/g, "$1")
		.replace(/[{}]/g, "")
		.replace(/~/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** `i` starts just after the opener; returns index just after the matching closer. */
function skipBalanced(input: string, i: number, closer: number): number {
	const opener = closer === 0x7d ? 0x7b : 0x28;
	let depth = 1;
	const n = input.length;
	while (i < n) {
		const c = input.charCodeAt(i);
		if (c === 0x5c /* \ */) {
			i += 2;
			continue;
		}
		if (c === opener) depth += 1;
		else if (c === closer) {
			depth -= 1;
			if (depth === 0) return i + 1;
		}
		i += 1;
	}
	return i;
}

function skipWs(input: string, i: number): number {
	const n = input.length;
	while (i < n && isWs(input.charCodeAt(i))) i += 1;
	return i;
}

function skipWsAndCommas(input: string, i: number): number {
	const n = input.length;
	while (i < n) {
		const c = input.charCodeAt(i);
		if (!isWs(c) && c !== 0x2c) break;
		i += 1;
	}
	return i;
}

function isWs(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function isAsciiAlpha(c: number): boolean {
	return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}
