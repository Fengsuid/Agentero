"use client";

import { Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { copyTextToClipboard } from "@/lib/core/clipboard";

export type MarkdownSourcePeekDialogProps = {
	open: boolean;
	/** Complete source captured when the overlay opened (frontmatter + body). */
	source: string;
	onClose: () => void;
};

/**
 * Read-only view of the current note source — exactly what autosave would
 * write. Editing the source belongs to a later phase; this overlay only shows
 * and copies it, so opening it never dirties the note.
 */
export function MarkdownSourcePeekDialog({
	open,
	source,
	onClose,
}: MarkdownSourcePeekDialogProps) {
	const { t } = useTranslation("editor");

	useOverlayRegistration("markdown-source-peek", open, onClose);

	const copyAll = () => {
		void copyTextToClipboard(source, {
			successMessage: t("sourcePeek.copied"),
			errorMessage: t("sourcePeek.copyFailed"),
		});
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="gap-3 sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{t("sourcePeek.title")}</DialogTitle>
				</DialogHeader>
				<textarea
					readOnly
					value={source}
					aria-label={t("sourcePeek.title")}
					spellCheck={false}
					wrap="off"
					className="agentero-scroll-both h-[min(60vh,32rem)] w-full resize-none rounded-lg border border-input bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
				/>
				<DialogFooter>
					<Button type="button" disabled={!source} onClick={copyAll}>
						<Copy className="size-4" aria-hidden />
						{t("sourcePeek.copy")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
