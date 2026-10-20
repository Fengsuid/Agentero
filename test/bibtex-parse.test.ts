import { describe, expect, it } from "vitest";
import {
	bibEntryAt,
	firstAuthorSurname,
	parseBibEntries,
} from "@/lib/bibtex/parse";
import {
	buildScholarQuery,
	buildScholarSearchUrl,
	normalizeArxivId,
	normalizeDoi,
} from "@/lib/bibtex/scholar-url";

const SAMPLE = `
% a comment line
@comment{ignore me {nested}}
@article{vaswani2017,
  title   = {Attention Is {A}ll You Need},
  author  = {Vaswani, Ashish and Shazeer, Noam and others},
  year    = 2017,
  journal = "Advances in NeurIPS",
  doi     = {10.5555/3295222},
  eprint  = {1706.03762},
  archiveprefix = {arXiv},
}
@inproceedings{he2016deep,
  title={Deep Residual Learning},
  author={He, Kaiming},
  booktitle={CVPR},
  year={2016}
}
@misc{noMeta,
  note = {nothing searchable}
}
`;

describe("parseBibEntries", () => {
	it("parses entries, fields, and source ranges", () => {
		const entries = parseBibEntries(SAMPLE);
		expect(entries.map((e) => e.key)).toEqual([
			"vaswani2017",
			"he2016deep",
			"noMeta",
		]);
		const e = entries[0];
		expect(e).toBeDefined();
		expect(e?.kind).toBe("article");
		expect(e?.fields.title).toBe("Attention Is All You Need");
		expect(e?.fields.year).toBe("2017");
		expect(e?.fields.journal).toBe("Advances in NeurIPS");
		expect(e?.fields.eprint).toBe("1706.03762");
		expect(e?.fields.doi).toBe("10.5555/3295222");
		expect(e && SAMPLE.slice(e.from, e.from + 8)).toBe("@article");
		expect(e && SAMPLE[e.to - 1]).toBe("}");

		expect(entries[1]?.fields.booktitle).toBe("CVPR");
	});

	it("finds entry at offset", () => {
		const entries = parseBibEntries(SAMPLE);
		const he = entries[1];
		expect(he).toBeDefined();
		expect(he && bibEntryAt(entries, he.from)?.key).toBe("he2016deep");
		expect(he && bibEntryAt(entries, he.to - 1)?.key).toBe("he2016deep");
		expect(bibEntryAt(entries, 0)).toBeNull();
	});

	it("extracts first author surname", () => {
		expect(firstAuthorSurname("Vaswani, Ashish and Shazeer, Noam")).toBe(
			"Vaswani",
		);
		expect(firstAuthorSurname("Kaiming He and Xiangyu Zhang")).toBe("He");
		expect(firstAuthorSurname("others")).toBeNull();
	});
});

describe("scholar URL", () => {
	it("normalizes DOI and arXiv ids", () => {
		expect(normalizeDoi("https://doi.org/10.5555/3295222")).toBe(
			"10.5555/3295222",
		);
		expect(normalizeDoi("doi:10.5555/3295222")).toBe("10.5555/3295222");
		expect(normalizeDoi("not-a-doi")).toBeNull();
		expect(normalizeArxivId("arXiv:1706.03762v5")).toBe("1706.03762");
		expect(normalizeArxivId("https://arxiv.org/abs/2505.02387")).toBe(
			"2505.02387",
		);
	});

	it("prefers the title over DOI and arXiv", () => {
		expect(
			buildScholarQuery({
				doi: "10.5555/3295222",
				title: "Attention Is All You Need",
				eprint: "1706.03762",
			}),
		).toBe('"Attention Is All You Need"');
	});

	it("falls back to doi then arxiv when there is no title", () => {
		expect(buildScholarQuery({ doi: "10.5555/3295222" })).toBe(
			"doi:10.5555/3295222",
		);
		expect(buildScholarQuery({ eprint: "1706.03762v1" })).toBe(
			"arxiv:1706.03762",
		);
	});

	it("builds an encoded scholar search URL", () => {
		const url = buildScholarSearchUrl({ doi: "10.5555/3295222" });
		expect(url).toBe(
			"https://scholar.google.com/scholar?q=doi%3A10.5555%2F3295222&hl=zh-CN",
		);
		expect(buildScholarSearchUrl({ note: "x" })).toBeNull();
	});
});
