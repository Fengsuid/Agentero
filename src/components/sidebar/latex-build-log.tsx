import { FileText, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { cancelTask } from "@/lib/core/tasks";
import { texBuildStore } from "@/lib/tex/build-state";

/** The sidebar has one log action; all problems remain in the editor footer. */
export function LatexBuildLog({ rootPath }: { rootPath: string }) {
	const { t } = useTranslation("latexBuild");
	const snapshot = useStore(
		texBuildStore,
		(state) => state.byRoot[normalizePath(rootPath)],
	);
	return (
		<Dialog>
			<DialogTrigger asChild>
				<button
					type="button"
					className="flex min-h-7 w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
				>
					<FileText
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					<span>{t("log")}</span>
				</button>
			</DialogTrigger>
			<DialogContent
				className="flex h-[65vh] flex-col gap-3 sm:max-w-3xl"
				aria-describedby={undefined}
			>
				<DialogTitle>
					{t("log")} · {basenameOf(rootPath)}
				</DialogTitle>
				<div className="flex items-center justify-end gap-1">
					{snapshot?.status === "running" && snapshot.jobId ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								if (snapshot.jobId) cancelTask(snapshot.jobId);
							}}
						>
							<Square className="size-3.5" aria-hidden />
							{t("stop")}
						</Button>
					) : null}
				</div>
				<textarea
					readOnly
					aria-label={t("log")}
					spellCheck={false}
					className="min-h-0 flex-1 resize-none overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
					value={snapshot?.logs.join("\n") || t("noLog")}
				/>
			</DialogContent>
		</Dialog>
	);
}
