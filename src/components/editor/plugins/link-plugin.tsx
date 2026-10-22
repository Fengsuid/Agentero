import { BaseLinkPlugin } from "@platejs/link";
import { toPlatePlugin } from "platejs/react";
import { LinkElement } from "@/components/editor/nodes/inline/link-node";
import { isLiteralTextContext } from "@/lib/markdown/input-context";
import { markdownLinkInputRule } from "@/lib/markdown/link-input-rule";

/** Upstream link normalization and input rules, with Agentero's rendering and paths. */
export const LinkPlugin = toPlatePlugin(BaseLinkPlugin)
	.configure({
		inputRules: [markdownLinkInputRule],
		options: {
			// Markdown links also point at relative Vault files and citation fragments.
			isUrl: (url) => Boolean(url) && !/[\s)]/.test(url),
			allowedSchemes: [
				...(BaseLinkPlugin.options.allowedSchemes ?? []),
				"file",
				"agentero-wiki",
			],
		},
	})
	.withComponent(LinkElement)
	.overrideEditor(({ editor, tf: { insertText } }) => ({
		transforms: {
			insertText(text, options) {
				// IME/batched insertion can deliver a whole link at once. Feed the final
				// delimiter through the same upstream rule as a single keystroke.
				if (
					!options?.at &&
					text.length > 1 &&
					/[)）]$/.test(text) &&
					!isLiteralTextContext(editor)
				) {
					insertText(text.slice(0, -1), options);
					insertText(text.slice(-1), options);
					return;
				}
				insertText(text, options);
			},
		},
	}));
