export {
	type BibEntry,
	type BibFields,
	bibEntryAt,
	firstAuthorSurname,
	parseBibEntries,
} from "@/lib/bibtex/parse";
export {
	buildScholarQuery,
	buildScholarSearchUrl,
	normalizeArxivId,
	normalizeDoi,
	type ScholarUrlOptions,
} from "@/lib/bibtex/scholar-url";
