import type {
	CompletionContext,
	CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap } from "@codemirror/view";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { basenameOf } from "@/lib/core/path";
import { renderKatexToElement } from "@/lib/math/katex-cache";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import {
	loadTexProjectIndex,
	type TexProjectIndex,
} from "@/lib/tex/project-index";
import { texSourceCode } from "@/lib/tex/source";

export type TexReferenceContext = {
	kind: "citation" | "label";
	key: string;
	from: number;
	to: number;
};
type TexSyntaxNode = ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]>;
const REFERENCE_COMMANDS = new Set([
	"ref",
	"pageref",
	"eqref",
	"autoref",
	"nameref",
	"cref",
	"vref",
	"vpageref",
	"cpageref",
	"labelcref",
	"labelcpageref",
	"namecref",
	"namecrefs",
	"lcnamecref",
	"crefrange",
	"cpagerefrange",
	"thref",
	"zref",
	"zpageref",
	"fullref",
]);
const CITATION_COMMANDS = new Set([
	"cite",
	"citet",
	"citep",
	"citealt",
	"citealp",
	"citeauthor",
	"citeyear",
	"citeyearpar",
	"citetitle",
	"citedate",
	"citeurl",
	"textcite",
	"parencite",
	"autocite",
	"footcite",
	"footcitetext",
	"smartcite",
	"supercite",
	"fullcite",
	"footfullcite",
	"nocite",
	"cites",
	"textcites",
	"parencites",
	"autocites",
	"footcites",
	"smartcites",
	"volcite",
	"pvolcite",
	"fvolcite",
	"tvolcite",
]);
type TexReferenceArgument = {
	kind: "citation" | "label";
	from: number;
	to: number;
};

/** Explicit command semantics keep link text and URLs out of label resolution. */
function texReferenceArguments(source: string): TexReferenceArgument[] {
	const code = texSourceCode(source);
	const arguments_: TexReferenceArgument[] = [];
	for (const command of code.matchAll(/\\([A-Za-z]+)\*?/g)) {
		const name = command[1].toLowerCase();
		let offset = (command.index ?? 0) + command[0].length;
		if (name === "hyperref") {
			const optional = /^\s*\[([^[\]]*)(\]|$)/.exec(code.slice(offset));
			if (optional) {
				const from = offset + optional[0].indexOf("[") + 1;
				arguments_.push({
					kind: "label",
					from,
					to: from + optional[1].length,
				});
			}
			continue;
		}
		const kind = CITATION_COMMANDS.has(name)
			? "citation"
			: REFERENCE_COMMANDS.has(name)
				? "label"
				: null;
		if (!kind) continue;
		const options = /^(?:\s*\[[^\]]*\]){0,2}\s*/.exec(code.slice(offset));
		offset += options?.[0].length ?? 0;
		const count = name.endsWith("refrange") ? 2 : 1;
		for (let index = 0; index < count; index += 1) {
			const argument = /^\s*\{([^{}]*)(\}|$)/.exec(code.slice(offset));
			if (!argument) break;
			const from = offset + argument[0].indexOf("{") + 1;
			arguments_.push({
				kind,
				from,
				to: from + argument[1].length,
			});
			offset += argument[0].length;
		}
	}
	return arguments_;
}

/** The argument token at the cursor, including the individual key in a cite list. */
export function texReferenceContext(
	source: string,
	position: number,
): TexReferenceContext | null {
	for (const argument of texReferenceArguments(source)) {
		const start = argument.from;
		const end = argument.to;
		if (position < start || position > end) continue;
		const before = source.slice(start, position);
		const from = start + before.lastIndexOf(",") + 1;
		const afterComma = source.indexOf(",", position);
		const to = afterComma >= 0 && afterComma < end ? afterComma : end;
		const token = source.slice(from, to);
		const trimmed = token.trimStart();
		return {
			kind: argument.kind,
			key: token.trim(),
			from: from + token.length - trimmed.length,
			to: to - (token.length - token.trimEnd().length),
		};
	}
	return null;
}

function ignoredAt(view: EditorView, position: number): boolean {
	for (
		let node: TexSyntaxNode | null = syntaxTree(view.state).resolveInner(
			position,
			-1,
		);
		node;
		node = node.parent
	) {
		if (/Comment|Verbatim|VerbContent|LstInline/.test(node.name)) return true;
	}
	return false;
}

export function texProjectCompletionSource(path: string) {
	return async (
		context: CompletionContext,
	): Promise<CompletionResult | null> => {
		const source = context.state.doc.toString();
		const ref = texReferenceContext(source, context.pos);
		if (!ref) return null;
		if (
			/Comment|Verbatim/.test(
				syntaxTree(context.state).resolveInner(context.pos, -1).name,
			)
		)
			return null;
		try {
			const index = await loadTexProjectIndex(path);
			return {
				from: ref.from,
				to: ref.to,
				options:
					ref.kind === "citation"
						? index.citations.map((entry) => ({
								label: [entry.key, entry.fields.title, entry.fields.author]
									.filter(Boolean)
									.join(" "),
								displayLabel: entry.key,
								apply: entry.key,
								detail: entry.fields.title ?? entry.fields.author,
								info: [
									entry.fields.title,
									entry.fields.author,
									entry.fields.year,
								]
									.filter(Boolean)
									.join("\n"),
								type: "reference",
								boost: 20,
							}))
						: index.labels.map((entry) => ({
								label: entry.key,
								detail: `${basenameOf(entry.path)}:${entry.line}`,
								info: entry.preview,
								type: "reference",
								boost: 20,
							})),
				validFor: /^[^{}\s,]*$/,
			};
		} catch {
			return null;
		}
	};
}

export function texReferenceDefinition(
	index: TexProjectIndex,
	reference: TexReferenceContext,
): { path: string; line: number } | null {
	return (
		(reference.kind === "citation" ? index.citations : index.labels).find(
			(entry) => entry.key === reference.key,
		) ?? null
	);
}

/** Insert at CodeMirror's mapped selection after any bibliography attachment. */
export function insertTexCitation(view: EditorView, key: string): void {
	const selection = view.state.selection.main;
	const reference = texReferenceContext(
		view.state.doc.toString(),
		selection.head,
	);
	const inCitation = reference?.kind === "citation";
	view.dispatch({
		changes: {
			from: inCitation ? reference.from : selection.from,
			to: inCitation ? reference.to : selection.to,
			insert: inCitation ? key : `\\cite{${key}}`,
		},
		userEvent: "input.citation",
	});
	view.focus();
}

async function goToDefinition(
	view: EditorView,
	path: string,
	position = view.state.selection.main.head,
): Promise<void> {
	if (ignoredAt(view, position)) return;
	const reference = texReferenceContext(view.state.doc.toString(), position);
	if (!reference) return;
	try {
		const target = texReferenceDefinition(
			await loadTexProjectIndex(path),
			reference,
		);
		if (target) navigateTexSource(target.path, target.line);
	} catch (error) {
		notifyError(errorText(error));
	}
}

export function texMathAt(
	view: EditorView,
	position: number,
): { from: number; to: number; tex: string; display: boolean } | null {
	for (
		let node: TexSyntaxNode | null = syntaxTree(view.state).resolveInner(
			position,
			-1,
		);
		node;
		node = node.parent
	) {
		if (
			!/^(DollarMath|DisplayMath|BracketMath|ParenMath|EquationEnvironment|EquationArrayEnvironment)$/.test(
				node.name,
			)
		)
			continue;
		let tex = view.state.sliceDoc(node.from, node.to).trim();
		const display = !/^(DollarMath|ParenMath)$/.test(node.name);
		tex = tex.replace(/^\$\$?|\$\$?$/g, "").replace(/^\\[[(]|\\[\])]$/g, "");
		tex = tex
			.replace(/\\(?:begin|end)\{(?:equation\*?)\}/g, "")
			.replace(/\{align\*?\}/g, "{aligned}")
			.replace(/\{gather\*?\}/g, "{gathered}")
			.replace(/\\label\{[^}]*\}/g, "");
		return { from: node.from, to: node.to, tex, display };
	}
	return null;
}

export function texIntelligenceExtensions(path: string): Extension[] {
	return [
		keymap.of([
			{
				key: "F12",
				run(view) {
					void goToDefinition(view, path);
					return true;
				},
			},
		]),
		EditorView.domEventHandlers({
			click(event, view) {
				if (!event.ctrlKey && !event.metaKey) return false;
				const position = view.posAtCoords({
					x: event.clientX,
					y: event.clientY,
				});
				if (
					position === null ||
					!texReferenceContext(view.state.doc.toString(), position)
				)
					return false;
				void goToDefinition(view, path, position);
				event.preventDefault();
				return true;
			},
		}),
		hoverTooltip(
			async (view, position) => {
				if (ignoredAt(view, position)) return null;
				const math = texMathAt(view, position);
				if (math)
					return {
						pos: math.from,
						end: math.to,
						above: true,
						create() {
							const dom = document.createElement("div");
							dom.className =
								"max-w-xl overflow-auto rounded-md bg-popover p-3 text-popover-foreground";
							renderKatexToElement(
								math.tex,
								{
									displayMode: math.display,
									throwOnError: false,
									strict: "ignore",
									trust: false,
								},
								dom,
							);
							return { dom };
						},
					};
				const reference = texReferenceContext(
					view.state.doc.toString(),
					position,
				);
				if (!reference?.key) return null;
				try {
					const index = await loadTexProjectIndex(path);
					const entry =
						reference.kind === "citation"
							? index.citations.find((item) => item.key === reference.key)
							: index.labels.find((item) => item.key === reference.key);
					if (!entry) return null;
					return {
						pos: reference.from,
						end: reference.to,
						above: true,
						create() {
							const dom = document.createElement("div");
							dom.className =
								"max-w-md rounded-md bg-popover p-3 text-xs text-popover-foreground";
							const text = document.createElement("pre");
							text.className = "whitespace-pre-wrap break-words font-mono";
							text.textContent =
								"fields" in entry
									? [entry.fields.title, entry.fields.author, entry.fields.year]
											.filter(Boolean)
											.join("\n")
									: entry.preview;
							const button = document.createElement("button");
							button.className =
								"mt-2 underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
							button.textContent = `${i18n.t("latexLanguage:goToDefinition")} · ${basenameOf(entry.path)}:${entry.line}`;
							button.onclick = () => navigateTexSource(entry.path, entry.line);
							dom.append(text, button);
							return { dom };
						},
					};
				} catch {
					return null;
				}
			},
			{ hideOnChange: true },
		),
	];
}
