import { type Diagnostic, linter, setDiagnostics } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
	collectEditorDiagnostics,
	formatEditorDiagnostic,
	type LintSeverity,
} from "@/components/viewer/text-editor-lint-footer";

const DOC = "\\documentclass{article}\nA bad ellipsis... here.\nsecond line\n";

/**
 * The lint state field is private to @codemirror/lint, but `linter()`
 * installs it and `setDiagnostics` is the public way to populate it — the
 * same effect the real lint plugin dispatches after a run. No EditorView is
 * needed (the vitest env is node), which is exactly how the collector is
 * consumed: it only ever reads the state.
 */
function stateWith(raw: Array<Partial<Diagnostic> & { from: number }>) {
	const diagnostics: Diagnostic[] = raw.map((d) => ({
		to: d.to ?? d.from + 1,
		message: d.message ?? "msg",
		...d,
	}));
	let state = EditorState.create({
		doc: DOC,
		extensions: [linter(() => [])],
	});
	// setDiagnostics returns a ready TransactionSpec (it also enables the lint
	// state when needed) — feed it to update() directly.
	state = state.update(setDiagnostics(state, diagnostics)).state;
	return state;
}

describe("collectEditorDiagnostics", () => {
	it("collects findings with 1-based line/column in document order", () => {
		const line2 = DOC.indexOf("A bad ellipsis");
		const state = stateWith([
			{
				from: line2 + 15,
				to: line2 + 18,
				severity: "warning",
				message: "\\ldots",
			},
			{
				from: DOC.indexOf("second"),
				to: DOC.indexOf("second") + 6,
				severity: "info",
				message: "note",
			},
		]);
		const found = collectEditorDiagnostics(state);
		expect(found.map((d) => [d.line, d.column])).toEqual([
			[2, 16],
			[3, 1],
		]);
		expect(found.map((d) => d.severity)).toEqual(["warning", "info"]);
		expect(found[0].message).toBe("\\ldots");
	});

	it("defaults a missing severity to warning instead of dropping the finding", () => {
		const state = stateWith([{ from: 0, severity: undefined }]);
		const found = collectEditorDiagnostics(state);
		expect(found).toHaveLength(1);
		expect(found[0].severity).toBe("warning" as LintSeverity);
	});

	it("returns empty when the lint run found nothing", () => {
		expect(collectEditorDiagnostics(stateWith([]))).toEqual([]);
	});
});

describe("diagnostic copying", () => {
	it("copies location, severity and the unchanged ChkTeX rule message", () => {
		const diagnostic = {
			from: 0,
			to: 1,
			line: 44,
			column: 10,
			severity: "warning" as const,
			message: "Command terminated with space. (chktex 1)",
		};
		expect(formatEditorDiagnostic(diagnostic, "/vault/main.tex")).toBe(
			"/vault/main.tex:44:10 [warning]\nCommand terminated with space. (chktex 1)",
		);
	});
	it("retains native Windows paths in the copied location", () => {
		const diagnostic = {
			from: 0,
			to: 1,
			line: 2,
			column: 3,
			severity: "warning" as const,
			message: "native warning",
		};
		expect(formatEditorDiagnostic(diagnostic, "C:\\vault\\main.tex")).toBe(
			"C:\\vault\\main.tex:2:3 [warning]\nnative warning",
		);
	});
});
