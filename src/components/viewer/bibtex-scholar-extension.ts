/**
 * CodeMirror affordance for `.bib` files: hover (or caret inside) an entry
 * and a small button appears on the entry's first line to open Google Scholar.
 */
import { type Extension, StateEffect, StateField } from "@codemirror/state";
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
} from "@codemirror/view";
import i18n from "@/i18n";
import {
	type BibEntry,
	bibEntryAt,
	buildScholarSearchUrl,
	parseBibEntries,
} from "@/lib/bibtex";
import { openExternalUrl } from "@/lib/core/open-external";

/** Pointer-driven entry range (`from`), or null when the pointer left the buffer. */
const setBibHover = StateEffect.define<number | null>();

class ScholarButtonWidget extends WidgetType {
	constructor(readonly url: string) {
		super();
	}

	eq(other: ScholarButtonWidget): boolean {
		return other.url === this.url;
	}

	toDOM(): HTMLElement {
		const btn = document.createElement("button");
		btn.type = "button";
		btn.className = "cm-bib-scholar-btn";
		const label = i18n.t("viewer:textEditor.openInScholar");
		btn.setAttribute("aria-label", label);
		btn.title = label;
		btn.tabIndex = -1;
		btn.innerHTML = SCHOLAR_ICON_SVG;
		btn.addEventListener("mousedown", (e) => {
			e.preventDefault();
		});
		btn.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			openExternalUrl(this.url);
		});
		return btn;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

/** Graduation-cap monogram — icon only, no face text. */
const SCHOLAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`;

const scholarTheme = EditorView.baseTheme({
	".cm-bib-scholar-btn": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		verticalAlign: "middle",
		marginLeft: "0.5rem",
		padding: "0.1rem 0.25rem",
		border: "1px solid transparent",
		borderRadius: "0.375rem",
		background: "transparent",
		color: "var(--muted-foreground)",
		cursor: "pointer",
		lineHeight: "1",
		opacity: "0.75",
	},
	".cm-bib-scholar-btn:hover, .cm-bib-scholar-btn:focus-visible": {
		opacity: "1",
		color: "var(--foreground)",
		backgroundColor: "color-mix(in oklab, var(--muted) 70%, transparent)",
		borderColor: "var(--border)",
	},
});

type BibScholarState = {
	entries: BibEntry[];
	/** Entry `from` under the pointer; null = no pointer hover. */
	hoverFrom: number | null;
	decorations: DecorationSet;
};

function parseEntries(doc: string): BibEntry[] {
	return parseBibEntries(doc);
}

function activeEntry(
	entries: BibEntry[],
	hoverFrom: number | null,
	caret: number,
): BibEntry | null {
	if (hoverFrom != null) {
		const byHover = bibEntryAt(entries, hoverFrom);
		if (byHover) return byHover;
	}
	return bibEntryAt(entries, caret);
}

function buildDecorations(
	doc: { lineAt(pos: number): { to: number } },
	entry: BibEntry | null,
): DecorationSet {
	if (!entry) return Decoration.none;
	const url = buildScholarSearchUrl(entry.fields);
	if (!url) return Decoration.none;
	const lineEnd = doc.lineAt(entry.from).to;
	return Decoration.set([
		Decoration.widget({
			widget: new ScholarButtonWidget(url),
			side: 1,
		}).range(lineEnd),
	]);
}

function recompute(
	doc: { toString(): string; lineAt(pos: number): { to: number } },
	entries: BibEntry[],
	hoverFrom: number | null,
	caret: number,
): BibScholarState {
	return {
		entries,
		hoverFrom,
		decorations: buildDecorations(doc, activeEntry(entries, hoverFrom, caret)),
	};
}

const bibScholarField = StateField.define<BibScholarState>({
	create(state) {
		return recompute(
			state.doc,
			parseEntries(state.doc.toString()),
			null,
			state.selection.main.head,
		);
	},
	update(value, tr) {
		let entries = value.entries;
		let hoverFrom = value.hoverFrom;
		let dirty = tr.docChanged || tr.selection;

		if (tr.docChanged) {
			entries = parseEntries(tr.state.doc.toString());
			// Keep hover if the same key still covers the old offset band.
			if (hoverFrom != null) {
				const mapped = tr.changes.mapPos(hoverFrom, 1);
				const still = bibEntryAt(entries, mapped);
				hoverFrom = still ? still.from : null;
			}
		}

		for (const effect of tr.effects) {
			if (effect.is(setBibHover)) {
				hoverFrom = effect.value;
				dirty = true;
			}
		}

		if (!dirty) return value;
		return recompute(
			tr.state.doc,
			entries,
			hoverFrom,
			tr.state.selection.main.head,
		);
	},
	provide: (field) => EditorView.decorations.from(field, (v) => v.decorations),
});

const bibScholarMouse = EditorView.domEventHandlers({
	mousemove(event, view) {
		const target = event.target;
		if (target instanceof Element && target.closest(".cm-bib-scholar-btn")) {
			// Pointer is on the button — keep current hover entry.
			return false;
		}
		const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
		const field = view.state.field(bibScholarField);
		const nextFrom =
			pos == null ? null : (bibEntryAt(field.entries, pos)?.from ?? null);
		if (nextFrom === field.hoverFrom) return false;
		view.dispatch({ effects: setBibHover.of(nextFrom) });
		return false;
	},
	mouseleave(_event, view) {
		const field = view.state.field(bibScholarField);
		if (field.hoverFrom == null) return false;
		view.dispatch({ effects: setBibHover.of(null) });
		return false;
	},
});

/**
 * Hover / caret-driven Scholar jump button for BibTeX buffers.
 */
export function bibtexScholarExtension(): Extension {
	return [bibScholarField, bibScholarMouse, scholarTheme];
}
