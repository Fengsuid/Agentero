import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { notifyError } from "@/lib/core/notify";
import { listPapers } from "@/lib/paper/api";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper/types";
import { addCatalogCitation } from "@/lib/tex/catalog-citation";
import { vaultStore } from "@/lib/vault/store";

export function TexCitationPicker({
	path,
	open,
	onOpenChange,
	onInsert,
}: {
	path: string;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onInsert: (key: string) => void;
}) {
	const { t } = useTranslation("latexLanguage");
	const [query, setQuery] = useState("");
	const [papers, setPapers] = useState<PaperLibraryRow[]>([]);
	const [loading, setLoading] = useState(false);
	const [inserting, setInserting] = useState(false);
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setLoading(true);
		setQuery("");
		setPapers([]);
		void listPapers(vaultStore.getState().vaultPath ?? "")
			.then((rows) => {
				if (!cancelled) setPapers(rows);
			})
			.catch((error) => {
				if (!cancelled)
					notifyError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);
	const filtered = useMemo(() => {
		const words = query.toLocaleLowerCase().trim().split(/\s+/);
		return papers
			.filter((paper) => {
				const search =
					`${paper.title} ${paper.authors.join(" ")} ${paper.year ?? ""} ${paper.doi ?? ""}`.toLocaleLowerCase();
				return words.every((word) => search.includes(word));
			})
			.slice(0, 100);
	}, [papers, query]);
	const insert = async (paper: PaperMetadata) => {
		if (inserting) return;
		setInserting(true);
		try {
			const key = await addCatalogCitation(path, paper);
			onInsert(key);
			onOpenChange(false);
		} catch (error) {
			notifyError(error instanceof Error ? error.message : String(error));
		} finally {
			setInserting(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!inserting) onOpenChange(next);
			}}
		>
			<DialogContent className="sm:max-w-xl" aria-describedby={undefined}>
				<DialogTitle>{t("insertCitation")}</DialogTitle>
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder={t("searchLibrary")}
					aria-label={t("searchLibrary")}
					disabled={inserting}
				/>
				<div
					className="max-h-80 space-y-1 overflow-y-auto"
					aria-busy={loading || inserting}
				>
					{loading || inserting ? (
						<div className="flex justify-center p-6">
							<Loader2
								className="size-5 animate-spin"
								aria-label={t("loading")}
							/>
						</div>
					) : filtered.length ? (
						filtered.map((paper) => (
							<button
								key={paper.path}
								type="button"
								className="w-full rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
								onClick={() => void insert(paper)}
							>
								<span className="line-clamp-2 block text-sm">
									{paper.title}
								</span>
								<span className="mt-0.5 block truncate text-xs text-muted-foreground">
									{[paper.authors.slice(0, 3).join(", "), paper.year]
										.filter(Boolean)
										.join(" · ")}
								</span>
							</button>
						))
					) : (
						<p className="p-6 text-center text-sm text-muted-foreground">
							{t("noPapers")}
						</p>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
