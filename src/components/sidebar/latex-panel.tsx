/**
 * Bottom-of-sidebar LaTeX tools for the active TeX project: compile,
 * view PDF, live preview, then that file's section outline. The compile
 * engine sits behind the header settings button.
 */

import {
	Check,
	ChevronRight,
	Eraser,
	File,
	FileText,
	Loader2,
	Play,
	Radio,
	Settings,
} from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	type PointerEvent as ReactPointerEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { notifyError } from "@/lib/core/notify";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { cn } from "@/lib/core/utils";
import { rememberTexEngine } from "@/lib/tex/engine";
import { activeOutlineSectionId, resolveTexInputPath } from "@/lib/tex/outline";
import { vaultPathExists } from "@/lib/vault/fs";
import {
	closeTexLive,
	openTab,
	openTexLive,
	openTexPdf,
} from "@/lib/workspace/actions";
import { workspaceStore } from "@/lib/workspace/store";
import { normalizeTabPath } from "@/lib/workspace/tabs";
import {
	cleanTexAuxFiles,
	initTexEngines,
	inspectTexEngine,
	type TexEngineChoice,
	texCompileStore,
} from "@/lib/workspace/tex-compile";
import {
	jumpTexOutline,
	texOutlineStore,
} from "@/lib/workspace/tex-outline-bridge";
import { texPdfPath } from "@/lib/workspace/viewer";

const HEIGHT_STORAGE_KEY = "agentero.latexPanelHeight";
const MIN_CONTENT_HEIGHT = 120;
const DEFAULT_CONTENT_HEIGHT = 320;
const HEADER_HEIGHT = 32;

function clampHeight(value: number) {
	return Math.max(MIN_CONTENT_HEIGHT, value);
}

function loadStoredHeight(): number {
	const parsed = readJsonStorage<number>(HEIGHT_STORAGE_KEY, Number.NaN);
	if (Number.isFinite(parsed)) return clampHeight(parsed);
	return DEFAULT_CONTENT_HEIGHT;
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	const [open, setOpen] = useState(true);
	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<CollapsibleTrigger
				className={cn(
					"flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm font-medium",
					"text-muted-foreground hover:text-foreground",
					"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				)}
			>
				<ChevronRight
					className={cn(
						"size-3.5 shrink-0 transition-transform",
						open && "rotate-90",
					)}
					aria-hidden
				/>
				<span className="truncate">{title}</span>
			</CollapsibleTrigger>
			<CollapsibleContent>{children}</CollapsibleContent>
		</Collapsible>
	);
}

function CommandRow({
	icon: Icon,
	label,
	disabled,
	busy,
	pressed,
	onClick,
}: {
	icon: typeof Play;
	label: string;
	disabled?: boolean;
	busy?: boolean;
	pressed?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			disabled={disabled || busy}
			aria-label={label}
			aria-pressed={pressed || undefined}
			onClick={onClick}
			className={cn(
				"flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm",
				"hover:bg-muted/70",
				"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				"disabled:cursor-not-allowed disabled:opacity-50",
				pressed && "bg-muted/50",
			)}
		>
			{busy ? (
				<Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
			) : (
				<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
			)}
			<span className="min-w-0 flex-1 truncate">{label}</span>
		</button>
	);
}

export function LatexPanel({ texPath }: { texPath: string }) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(true);
	const [contentHeight, setContentHeight] = useState(loadStoredHeight);
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<{
		startY: number;
		startHeight: number;
		collapseOnRelease: boolean;
	} | null>(null);

	const engines = useStore(texCompileStore, (s) => s.engines);
	const enginesLoading = useStore(texCompileStore, (s) => s.enginesLoading);
	const compilingPath = useStore(texCompileStore, (s) => s.compilingPath);
	const snapshot = useStore(texOutlineStore, (s) => s.snapshot);
	const tabs = useStore(workspaceStore, (s) => s.tabs);
	const [engineChoice, setEngineChoice] = useState<TexEngineChoice | null>(
		null,
	);

	useEffect(() => {
		initTexEngines();
	}, []);

	useEffect(() => {
		if (enginesLoading && engines.length === 0) return;
		let cancelled = false;
		void inspectTexEngine(texPath).then((choice) => {
			if (!cancelled) setEngineChoice(choice);
		});
		return () => {
			cancelled = true;
		};
	}, [texPath, engines, enginesLoading]);

	const persistHeight = (value: number) => {
		writeJsonStorage(HEIGHT_STORAGE_KEY, Math.round(value));
	};

	const onHandlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
		if (e.button !== 0) return;
		dragRef.current = {
			startY: e.clientY,
			startHeight: contentHeight,
			collapseOnRelease: false,
		};
		setIsDragging(true);
		e.currentTarget.setPointerCapture(e.pointerId);
	};

	const onHandlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		const next = drag.startHeight + (drag.startY - e.clientY);
		drag.collapseOnRelease = next <= MIN_CONTENT_HEIGHT;
		setContentHeight(clampHeight(next));
	};

	const onHandlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		dragRef.current = null;
		setIsDragging(false);
		e.currentTarget.releasePointerCapture(e.pointerId);
		setContentHeight((h) => {
			persistHeight(h);
			return h;
		});
		if (drag.collapseOnRelease) setOpen(false);
	};

	const onHandleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		const step = e.shiftKey ? 48 : 16;
		let next: number | null = null;
		if (e.key === "ArrowUp") next = clampHeight(contentHeight + step);
		else if (e.key === "ArrowDown") next = clampHeight(contentHeight - step);
		if (next == null) return;
		e.preventDefault();
		if (e.key === "ArrowDown" && contentHeight <= MIN_CONTENT_HEIGHT) {
			setOpen(false);
			return;
		}
		setContentHeight(next);
		persistHeight(next);
	};

	const hasEngines = !enginesLoading && engines.length > 0;
	const canLive = engines.some((engine) => engine.id === "lualatex");
	const liveOn =
		engineChoice != null &&
		tabs.some((tab) => {
			if (!tab.texLive) return false;
			const root = normalizePath(engineChoice.rootPath);
			return (
				normalizePath(tab.texRoot ?? "") === root ||
				normalizePath(tab.path) === normalizePath(texPdfPath(root))
			);
		});
	const compiling = compilingPath !== null;
	const outline =
		snapshot && snapshot.path === normalizeTabPath(texPath) ? snapshot : null;
	const items = outline?.items ?? [];
	const activeId = outline
		? activeOutlineSectionId(items, outline.cursorLine)
		: null;

	const openIncluded = async (fileArg: string) => {
		const target = resolveTexInputPath(texPath, fileArg);
		if (!target) return;
		let exists = false;
		try {
			exists = await vaultPathExists(target);
		} catch {
			exists = false;
		}
		if (!exists) {
			notifyError(t("latexPanel.fileMissing", { name: basenameOf(target) }));
			return;
		}
		openTab(target, { preferMode: "text" });
	};

	return (
		<div
			className={cn(
				"relative flex min-h-0 shrink-0 flex-col overflow-hidden border-t",
				!isDragging &&
					"transition-[height] duration-200 ease-[cubic-bezier(0.25,1,0.5,1)]",
			)}
			style={{ height: open ? contentHeight + HEADER_HEIGHT : HEADER_HEIGHT }}
		>
			{open ? (
				// biome-ignore lint/a11y/useSemanticElements: a focusable drag separator cannot be a native <hr>
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label={t("latexPanel.resize")}
					aria-valuenow={Math.round(contentHeight)}
					aria-valuemin={MIN_CONTENT_HEIGHT}
					title={t("latexPanel.resize")}
					tabIndex={0}
					onPointerDown={onHandlePointerDown}
					onPointerMove={onHandlePointerMove}
					onPointerUp={onHandlePointerUp}
					onPointerCancel={onHandlePointerUp}
					onLostPointerCapture={() => {
						if (!dragRef.current) return;
						dragRef.current = null;
						setIsDragging(false);
					}}
					onKeyDown={onHandleKeyDown}
					className={cn(
						"absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize outline-none",
						"after:absolute after:inset-x-0 after:top-[3px] after:h-px after:content-['']",
						"hover:after:bg-foreground/25 focus-visible:after:bg-foreground/35",
					)}
				/>
			) : null}
			<Collapsible
				open={open}
				onOpenChange={setOpen}
				className="flex min-h-0 flex-1 flex-col"
			>
				<div className="flex h-8 min-h-8 shrink-0 items-center pr-1.5">
					<CollapsibleTrigger
						className={cn(
							"flex min-w-0 flex-1 items-center gap-1.5 px-2 text-left outline-none",
							"text-muted-foreground text-sm font-medium",
							"hover:text-foreground",
							"focus-visible:ring-1 focus-visible:ring-ring",
						)}
					>
						<ChevronRight
							className={cn(
								"size-3.5 shrink-0 transition-transform",
								open && "rotate-90",
							)}
							aria-hidden
						/>
						<span className="truncate">{t("latexPanel.title")}</span>
					</CollapsibleTrigger>
					<Popover
						onOpenChange={(next) => {
							if (!next) return;
							void inspectTexEngine(texPath).then(setEngineChoice);
						}}
					>
						<PopoverTrigger asChild>
							<Button
								type="button"
								size="icon-xs"
								variant="ghost"
								className="shrink-0 text-muted-foreground"
								aria-label={t("latexPanel.engineSettings")}
								title={t("latexPanel.engineSettings")}
							>
								<Settings className="size-3.5" aria-hidden />
							</Button>
						</PopoverTrigger>
						<PopoverContent align="end" side="top" className="w-52 gap-1 p-1">
							<p className="px-2 pt-1 text-caption text-muted-foreground">
								{t("fileTree.latexEngine")}
							</p>
							{engineChoice?.locked ? (
								<p className="px-2 pb-1 text-xs text-muted-foreground">
									{t("latexPanel.engineFromFile")}
								</p>
							) : null}
							{enginesLoading ? (
								<p className="px-2 py-1 text-muted-foreground text-xs">
									{t("fileTree.detectingEngines")}
								</p>
							) : hasEngines ? (
								<div
									role="listbox"
									aria-label={t("fileTree.latexEngine")}
									className="flex flex-col"
								>
									{engines.map((engine) => {
										const selected = engineChoice?.engineId === engine.id;
										return (
											<button
												key={engine.id}
												type="button"
												role="option"
												aria-selected={selected}
												disabled={engineChoice?.locked}
												onClick={() => {
													if (!engineChoice || engineChoice.locked) return;
													rememberTexEngine(engineChoice.rootPath, engine.id);
													setEngineChoice({
														...engineChoice,
														engineId: engine.id,
													});
												}}
												className={cn(
													"flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-sm",
													"hover:bg-muted/70",
													"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
													"disabled:cursor-default disabled:opacity-100 disabled:hover:bg-transparent",
													selected && "bg-muted/50",
												)}
											>
												<Check
													className={cn(
														"size-3.5 shrink-0",
														selected ? "opacity-100" : "opacity-0",
													)}
													aria-hidden
												/>
												<span className="min-w-0 flex-1 truncate">
													{engine.label}
												</span>
											</button>
										);
									})}
								</div>
							) : (
								<p className="px-2 py-1 text-muted-foreground text-xs">
									{t("fileTree.noLatexEngine")}
								</p>
							)}
						</PopoverContent>
					</Popover>
				</div>
				<CollapsibleContent
					forceMount
					className={cn(
						"flex min-h-0 flex-1 flex-col",
						!open && "pointer-events-none",
					)}
					aria-hidden={!open}
				>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
						<Group title={t("latexPanel.commands")}>
							<div className="flex flex-col px-1 pb-1">
								<CommandRow
									icon={Play}
									label={t("fileTree.compileTex")}
									disabled={!hasEngines}
									busy={compiling}
									onClick={() => {
										void openTexPdf(texPath, { forceCompile: true });
									}}
								/>
								<CommandRow
									icon={FileText}
									label={t("latexPanel.viewPdf")}
									onClick={() => {
										void openTexPdf(texPath);
									}}
								/>
								{canLive ? (
									<CommandRow
										icon={Radio}
										label={t("fileTree.liveCompile")}
										pressed={liveOn}
										onClick={() => {
											if (liveOn) void closeTexLive(texPath);
											else void openTexLive(texPath);
										}}
									/>
								) : null}
								{hasEngines ? (
									<CommandRow
										icon={Eraser}
										label={t("fileTree.cleanAux")}
										disabled={compiling}
										onClick={() => {
											void cleanTexAuxFiles(texPath);
										}}
									/>
								) : null}
							</div>
						</Group>
						<Group title={t("latexPanel.structure")}>
							{outline == null ? null : items.length === 0 ? (
								<p className="px-3 py-1 text-muted-foreground text-xs">
									{t("latexPanel.emptyStructure")}
								</p>
							) : (
								<ul className="flex flex-col px-1 pb-1">
									{items.map((item) => {
										const current =
											item.kind === "section" && item.id === activeId;
										return (
											<li key={item.id}>
												<button
													type="button"
													aria-current={current ? "true" : undefined}
													title={item.title}
													onClick={() => {
														if (item.kind === "file" && item.fileArg) {
															void openIncluded(item.fileArg);
															return;
														}
														openTab(texPath, { preferMode: "text" });
														jumpTexOutline(texPath, item.line);
													}}
													className={cn(
														"flex w-full items-center gap-1.5 rounded-sm py-0.5 pr-2 text-left text-sm",
														"hover:bg-muted/70",
														"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
														current && "bg-muted/80 text-foreground",
													)}
													style={{
														paddingLeft: `${0.5 + item.indent * 0.75}rem`,
													}}
												>
													{item.kind === "file" ? (
														<File
															className="size-3.5 shrink-0 text-muted-foreground"
															aria-hidden
														/>
													) : null}
													<span className="min-w-0 flex-1 truncate">
														{item.title}
													</span>
												</button>
											</li>
										);
									})}
								</ul>
							)}
						</Group>
					</div>
				</CollapsibleContent>
			</Collapsible>
		</div>
	);
}
