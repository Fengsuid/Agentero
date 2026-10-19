import type { Text } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

const encoder = new TextEncoder();

/** UTF-8 byte length of a string (CodeMirror offsets are UTF-16). */
export function utf8Length(text: string): number {
	return encoder.encode(text).length;
}

/**
 * Line-start UTF-8 byte offsets for a CodeMirror document.
 *
 * Both ends of an edit must be converted against the *old* document; after
 * applying the change set, {@link update} rebuilds the table from the previous
 * line onward. The tail rebuild is O(lines after the edit); ample for normal
 * TeX sources and the first path that keeps Chinese/emoji offsets correct.
 */
export class ByteIndex {
	private starts: number[] = [];
	/** The document these offsets were built for (CodeMirror Text is persistent). */
	private doc: Text | null = null;

	constructor(doc: Text) {
		this.rebuild(doc);
	}

	byteAt(doc: Text, pos: number): number {
		if (this.doc !== doc) this.rebuild(doc);
		const line = doc.lineAt(pos);
		const start = this.starts[line.number - 1] ?? 0;
		return start + utf8Length(doc.sliceString(line.from, pos));
	}

	update(doc: Text, firstChangedLine: number): void {
		const first = Math.max(1, Math.min(firstChangedLine, doc.lines));
		let offset = 0;
		if (first > 1) {
			const previous = doc.line(first - 1);
			offset = (this.starts[first - 2] ?? 0) + utf8Length(previous.text) + 1;
		}
		this.starts.length = Math.max(this.starts.length, doc.lines);
		for (let number = first; number <= doc.lines; number += 1) {
			this.starts[number - 1] = offset;
			const line = doc.line(number);
			offset += utf8Length(line.text) + (number < doc.lines ? 1 : 0);
		}
		this.starts.length = doc.lines;
		this.doc = doc;
	}

	rebuild(doc: Text): void {
		this.doc = doc;
		this.starts = new Array<number>(doc.lines);
		let offset = 0;
		for (let number = 1; number <= doc.lines; number += 1) {
			this.starts[number - 1] = offset;
			offset +=
				utf8Length(doc.line(number).text) + (number < doc.lines ? 1 : 0);
		}
	}
}

export type TexLiveEdit = { start: number; end: number; text: string };

/**
 * Convert a CodeMirror transaction into rtex edits.
 *
 * All positions are resolved against `update.startState.doc`; the caller sends
 * them in reverse order so earlier offsets stay valid after later edits.
 */
export function editsFromUpdate(
	update: ViewUpdate,
	index: ByteIndex,
): TexLiveEdit[] {
	if (!update.docChanged) return [];
	const doc = update.startState.doc;
	const edits: TexLiveEdit[] = [];
	update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
		edits.push({
			start: index.byteAt(doc, fromA),
			end: index.byteAt(doc, toA),
			text: inserted.toString(),
		});
	});
	return edits;
}

/** First line touched by the transaction, one line of safety margin. */
export function firstChangedLine(update: ViewUpdate): number {
	let first = Number.POSITIVE_INFINITY;
	update.changes.iterChanges((fromA) => {
		first = Math.min(first, update.startState.doc.lineAt(fromA).number);
	});
	if (!Number.isFinite(first)) return 1;
	return Math.max(1, first - 1);
}
