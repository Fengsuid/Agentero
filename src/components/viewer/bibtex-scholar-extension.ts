/**
 * CodeMirror affordance for `.bib` files: hover (or caret inside) an entry
 * and a quiet Scholar link appears on the entry-head line. It stays visible
 * for the entry at the caret, so opening a `.bib` file always shows one; the
 * inline box is height-capped so the line metrics never move.
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
		btn.tabIndex = -1;
		btn.innerHTML = `${SCHOLAR_ICON_SVG}<span class="cm-bib-scholar-btn-label"></span>`;
		const labelEl = btn.querySelector(".cm-bib-scholar-btn-label");
		if (labelEl) labelEl.textContent = label;
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

const SCHOLAR_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>`;

const scholarTheme = EditorView.baseTheme({
	// A quiet inline link at rest; the pill only appears under the pointer.
	// Height is locked to the text box so the decoration never reflows the line.
	".cm-bib-scholar-btn": {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: "0.35em",
		boxSizing: "border-box",
		height: "1.5em",
		maxHeight: "1.5em",
		marginLeft: "0.55em",
		padding: "0 0.5em 0 0.35em",
		border: "1px solid color-mix(in oklab, var(--border) 55%, transparent)",
		borderRadius: "0.375rem",
		background: "color-mix(in oklab, var(--muted) 70%, var(--background))",
		color: "var(--muted-foreground)",
		cursor: "pointer",
		fontFamily: "var(--font-sans)",
		fontSize: "0.85em",
		fontWeight: "500",
		letterSpacing: "0.01em",
		lineHeight: "1",
		whiteSpace: "nowrap",
		verticalAlign: "middle",
		opacity: "0.9",
		transition:
			"opacity 120ms ease-out, color 120ms ease-out, background-color 120ms ease-out, border-color 120ms ease-out",
	},
	".cm-bib-scholar-btn svg": {
		flexShrink: "0",
		width: "1.05em",
		height: "1.05em",
		opacity: "0.85",
	},
	".cm-bib-scholar-btn:hover, .cm-bib-scholar-btn:focus-visible": {
		opacity: "1",
		color: "var(--foreground)",
		backgroundColor: "color-mix(in oklab, var(--muted) 88%, var(--background))",
		borderColor: "var(--border)",
	},
	".cm-bib-scholar-btn:active": {
		transform: "translateY(0.5px)",
	},
	"@media (prefers-reduced-motion: reduce)": {
		".cm-bib-scholar-btn": {
			transition: "color 120ms ease, background-color 120ms ease",
		},
		".cm-bib-scholar-btn:active": {
			transform: "none",
		},
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
	// Keep one chip on screen when the file opens (caret above @article) or
	// the pointer leaves; the caret's own entry wins, then the first entry.
	return bibEntryAt(entries, caret) ?? entries[0] ?? null;
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
