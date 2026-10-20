import type { BibFields } from "@/lib/bibtex/parse";

const SCHOLAR_HOST = "https://scholar.google.com/scholar";

export type ScholarUrlOptions = {
	/** UI language (`hl`). Default `zh-CN`. */
	hl?: string;
	/** Override host (e.g. `https://scholar.google.com.hk/scholar`). */
	base?: string;
};

/**
 * Build a Google Scholar **search** URL from BibTeX fields.
 * Prefer DOI → arXiv eprint → quoted title (+ author/year).
 * Returns null when nothing searchable is present.
 */
export function buildScholarSearchUrl(
	fields: BibFields,
	opts: ScholarUrlOptions = {},
): string | null {
	const q = buildScholarQuery(fields);
	if (!q) return null;
	const base = opts.base ?? SCHOLAR_HOST;
	const params = new URLSearchParams({
		q,
		hl: opts.hl ?? "zh-CN",
	});
	return `${base}?${params.toString()}`;
}

/**
 * Scholar `q=` value (not URL-encoded). Empty string when no usable fields.
 *
 * Priority:
 * 1. `"title"` — a title search is the most predictable entry point, and it
 *    still resolves the right record when the entry's DOI is stale.
 * 2. `doi:…` when the entry has no title
 * 3. `arxiv:…` from `eprint` / `arxiv` / arXiv-looking `url`
 *
 * Combining title and DOI with `OR` was considered, but Scholar's boolean
 * handling is unreliable: a DOI clause that is not indexed can collapse the
 * whole query to zero results instead of adding a second record. Keep one
 * stable clause rather than silently losing the title hit.
 */
export function buildScholarQuery(fields: BibFields): string {
	const title = fields.title?.trim();
	if (title) return `"${title}"`;

	const doi = normalizeDoi(fields.doi);
	if (doi) return `doi:${doi}`;

	const arxiv = normalizeArxivId(
		fields.eprint ?? fields.arxiv ?? arxivFromUrl(fields.url),
	);
	if (arxiv) return `arxiv:${arxiv}`;

	return "";
}

/** Strip `https://doi.org/` / `doi:` prefixes and lowercase. */
export function normalizeDoi(raw: string | undefined): string | null {
	if (!raw?.trim()) return null;
	let s = raw.trim();
	s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
	s = s.replace(/^doi:\s*/i, "");
	s = s.trim();
	// Bare DOI starts with `10.`
	if (!/^10\.\d{4,}\//i.test(s)) return null;
	return s;
}

/** Keep `YYMM.NNNNN` / `archive/NNNN` form; drop `arXiv:` and version suffix optional keep. */
export function normalizeArxivId(raw: string | undefined): string | null {
	if (!raw?.trim()) return null;
	let s = raw.trim();
	s = s.replace(/^https?:\/\/arxiv\.org\/(abs|pdf|html)\//i, "");
	s = s.replace(/^arxiv:\s*/i, "");
	s = s.replace(/\.pdf$/i, "");
	s = s.trim();
	// New-style 2505.02387 or 2505.02387v2; old-style cs/0501001
	if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) return s.replace(/v\d+$/i, "");
	if (/^[a-z-]+(\.[A-Z]{2})?\/\d{7}(v\d+)?$/i.test(s))
		return s.replace(/v\d+$/i, "");
	return null;
}

function arxivFromUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	const m = url.match(
		/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i,
	);
	return m?.[1];
}
