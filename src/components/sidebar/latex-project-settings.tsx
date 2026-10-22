import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { notifyError } from "@/lib/core/notify";
import { basenameOf } from "@/lib/core/path";
import { trackTexProject } from "@/lib/tex/auto-build";
import {
	explicitTexRoot,
	getTexProjectSettings,
	setTexProjectRoot,
	setTexProjectSettings,
	type TexAutoBuild,
	type TexProjectSettings,
	validateTexSettings,
} from "@/lib/tex/config";
import { inspectLatexProject } from "@/lib/tex/host";
import { vaultStore } from "@/lib/vault/store";

const fieldClass =
	"min-h-8 w-full rounded-md border border-input bg-transparent px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function LatexProjectSettings({
	texPath,
	rootPath,
	onChanged,
}: {
	texPath: string;
	rootPath: string;
	onChanged: () => void;
}) {
	const { t } = useTranslation("latexBuild");
	const id = useId();
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState<TexProjectSettings>(() =>
		getTexProjectSettings(rootPath),
	);
	const [root, setRoot] = useState("");
	const [candidates, setCandidates] = useState<string[]>([rootPath]);
	const [recipes, setRecipes] = useState("[]");
	const [saving, setSaving] = useState(false);
	useEffect(() => {
		if (!open) return;
		const settings = getTexProjectSettings(rootPath);
		setDraft(settings);
		setRoot(explicitTexRoot(texPath) ?? "");
		setRecipes(JSON.stringify(settings.recipes, null, 2));
		let cancelled = false;
		void inspectLatexProject(texPath, vaultStore.getState().vaultPath ?? "")
			.then((project) => {
				if (!cancelled)
					setCandidates([
						...new Set([rootPath, texPath, ...project.candidates]),
					]);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [open, texPath, rootPath]);

	const save = async () => {
		setSaving(true);
		try {
			const parsed = JSON.parse(recipes) as unknown;
			const next = validateTexSettings({
				...draft,
				recipes: parsed,
				recipe: null,
				selectedRecipe:
					Array.isArray(parsed) &&
					parsed.some((recipe) => recipe?.name === draft.selectedRecipe)
						? draft.selectedRecipe
						: null,
			});
			const project = await inspectLatexProject(
				texPath,
				vaultStore.getState().vaultPath ?? "",
				root || null,
			);
			const targetRoot = project.rootPath;
			setTexProjectRoot(texPath, root);
			setTexProjectSettings(targetRoot, next);
			await trackTexProject(targetRoot);
			onChanged();
			setOpen(false);
		} catch (error) {
			notifyError(
				error instanceof SyntaxError ? t("invalidJson") : t("invalidSettings"),
			);
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					className="w-full justify-start px-2 text-sm"
				>
					{t("projectSettings")}
				</Button>
			</DialogTrigger>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto sm:max-w-xl"
				aria-describedby={undefined}
			>
				<DialogTitle>{t("projectSettings")}</DialogTitle>
				<form
					className="grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<label className="grid gap-1 text-xs" htmlFor={`${id}-root`}>
						{t("rootFile")}
						<select
							id={`${id}-root`}
							className={fieldClass}
							value={root}
							onChange={(event) => setRoot(event.target.value)}
						>
							<option value="">
								{t("automaticRoot", { name: basenameOf(rootPath) })}
							</option>
							{candidates.map((path) => (
								<option key={path} value={path}>
									{path}
								</option>
							))}
						</select>
					</label>
					<label className="grid gap-1 text-xs" htmlFor={`${id}-auto`}>
						{t("autoBuild")}
						<select
							id={`${id}-auto`}
							className={fieldClass}
							value={draft.autoBuild}
							onChange={(event) =>
								setDraft({
									...draft,
									autoBuild: event.target.value as TexAutoBuild,
								})
							}
						>
							<option value="never">{t("manual")}</option>
							<option value="onSave">{t("onSave")}</option>
							<option value="onFileChange">{t("onFileChange")}</option>
						</select>
					</label>
					<label
						className="flex min-h-8 items-center gap-2 text-sm"
						htmlFor={`${id}-sync`}
					>
						<input
							id={`${id}-sync`}
							type="checkbox"
							checked={draft.syncAfterBuild}
							onChange={(event) =>
								setDraft({ ...draft, syncAfterBuild: event.target.checked })
							}
						/>
						{t("syncAfterBuild")}
					</label>
					<div className="grid grid-cols-2 gap-3">
						{(["outDir", "auxDir"] as const).map((key) => (
							<label
								key={key}
								className="grid gap-1 text-xs"
								htmlFor={`${id}-${key}`}
							>
								{t(key)}
								<input
									id={`${id}-${key}`}
									className={fieldClass}
									value={draft[key]}
									placeholder="."
									onChange={(event) =>
										setDraft({ ...draft, [key]: event.target.value })
									}
								/>
							</label>
						))}
					</div>
					<label className="grid gap-1 text-xs" htmlFor={`${id}-jobname`}>
						{t("jobname")}
						<input
							id={`${id}-jobname`}
							className={fieldClass}
							value={draft.jobname}
							onChange={(event) =>
								setDraft({ ...draft, jobname: event.target.value })
							}
						/>
					</label>
					<details className="rounded-md border border-border p-2">
						<summary className="text-sm">{t("recipes")}</summary>
						<label
							className="mt-2 grid gap-1 text-xs"
							htmlFor={`${id}-recipes`}
						>
							{t("recipeJson")}
							<textarea
								id={`${id}-recipes`}
								spellCheck={false}
								className={`${fieldClass} min-h-40 font-mono text-xs`}
								value={recipes}
								onChange={(event) => setRecipes(event.target.value)}
							/>
						</label>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setRecipes(
									JSON.stringify(
										[
											{
												name: "PDFLaTeX + latexmk",
												tools: [
													{
														command: "latexmk",
														args: [
															"-pdf",
															"-synctex=1",
															"-file-line-error",
															"-recorder",
															"-interaction=nonstopmode",
															"-outdir=%OUTDIR%",
															"%DOC%",
														],
													},
												],
											},
										],
										null,
										2,
									),
								);
							}}
						>
							{t("recipeExample")}
						</Button>
					</details>
					<div className="flex justify-end gap-2">
						<Button
							type="button"
							variant="ghost"
							onClick={() => setOpen(false)}
						>
							{t("cancel")}
						</Button>
						<Button type="submit" disabled={saving}>
							{t("save")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
