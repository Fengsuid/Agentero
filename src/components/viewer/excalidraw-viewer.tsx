import {
	Excalidraw,
	restoreAppState,
	restoreElements,
	serializeAsJSON,
} from "@excalidraw/excalidraw";
// Required base styles — without them the canvas and toolbars collapse.
import "@excalidraw/excalidraw/index.css";
import type {
	BinaryFiles,
	ExcalidrawInitialDataState,
	ExcalidrawProps,
} from "@excalidraw/excalidraw/types";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

interface ExcalidrawViewerProps {
	seed: string;
	path: string;
	reloadKey: number;
	onPersist: (
		path: string,
		content: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange: (dirty: boolean) => void;
	className?: string;
}

const AUTOSAVE_DELAY_MS = 800;

// The image tool must stay enabled: Excalidraw gates pasting and dropping
// image files on `isToolSupported("image")` — disabling it here rejects
// clipboard images with "Images are disabled" (#682).
const UI_OPTIONS: NonNullable<ExcalidrawProps["UIOptions"]> = {
	tools: { image: true },
};

// Extract embedded image binaries (`files: { [fileId]: { dataURL, ... } }`)
// from a `.excalidraw` snapshot so image elements can render on reload.
// Entries without a usable dataURL are dropped instead of poisoning the
// image cache.
function parseSeedFiles(raw: unknown): BinaryFiles | undefined {
	if (typeof raw !== "object" || raw == null) return undefined;
	const files: BinaryFiles = {};
	for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
		if (
			typeof entry === "object" &&
			entry != null &&
			typeof (entry as { dataURL?: unknown }).dataURL === "string" &&
			(entry as { dataURL: string }).dataURL
		) {
			files[id] = entry as BinaryFiles[string];
		}
	}
	return Object.keys(files).length > 0 ? files : undefined;
}

export function ExcalidrawViewer({
	seed,
	path,
	reloadKey,
	onPersist,
	onDirtyChange,
	className,
}: ExcalidrawViewerProps) {
	const { i18n } = useTranslation("viewer");
	// Follow the app theme (system / light / dark preference via next-themes).
	const { resolvedTheme } = useTheme();
	const theme = resolvedTheme === "dark" ? "dark" : "light";
	const lastSavedRef = useRef(seed);
	// PERF: onChange fires per pointer-event frame; stash the latest
	// (elements, appState, files) tuple — a reference, zero-copy — and let
	// the debounced flush do the (potentially MB-scale with embedded image
	// dataURLs) serializeAsJSON pass exactly once.
	const pendingSceneRef = useRef<Parameters<
		NonNullable<ExcalidrawProps["onChange"]>
	> | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const dirtyRef = useRef(false);

	// Keep the dirty callback stable across parent re-renders (doc-view passes
	// an inline arrow for `onDirtyChange`).
	const onDirtyChangeRef = useRef(onDirtyChange);
	onDirtyChangeRef.current = onDirtyChange;

	const initialData = useMemo<ExcalidrawInitialDataState>(() => {
		try {
			const parsed = JSON.parse(seed || "{}") as Record<string, unknown>;
			const elements = Array.isArray(parsed.elements) ? parsed.elements : [];
			const appState =
				typeof parsed.appState === "object" && parsed.appState != null
					? (parsed.appState as Record<string, unknown>)
					: {};
			return {
				elements: restoreElements(elements, null),
				appState: restoreAppState(appState, null),
				// Image binaries live top-level next to elements; without
				// them restored image elements render as broken placeholders.
				files: parseSeedFiles(parsed.files),
			};
		} catch {
			return {
				elements: restoreElements([], null),
				appState: restoreAppState({}, null),
			};
		}
	}, [seed]);

	const flush = useCallback(async () => {
		const scene = pendingSceneRef.current;
		if (scene == null) return;
		pendingSceneRef.current = null;
		const [elements, appState, files] = scene;
		// `files` carries the embedded image binaries (dataURLs); serializing
		// without them would persist elements without their images.
		const payload = serializeAsJSON(elements, appState, files, "local");
		const ok = await onPersist(path, payload, lastSavedRef.current);
		if (ok) {
			lastSavedRef.current = payload;
			dirtyRef.current = false;
			onDirtyChangeRef.current(false);
		}
	}, [onPersist, path]);

	const schedulePersist = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = null;
			void flush();
		}, AUTOSAVE_DELAY_MS);
	}, [flush]);

	useEffect(() => {
		return () => {
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
			if (pendingSceneRef.current) {
				void flush();
			}
		};
	}, [flush]);

	// The seed is authoritative: after our own save it equals what we wrote
	// (idempotent), after an external change it is the new disk snapshot.
	useEffect(() => {
		lastSavedRef.current = seed;
	}, [seed]);

	// A `reloadKey` bump means the canvas was reloaded from disk (external
	// change the user accepted). Any pending autosave from the superseded
	// editing session must be dropped, or its flush would pass the conflict
	// check (disk === lastSaved) and overwrite the reloaded content.
	useEffect(() => {
		if (reloadKey === 0) return; // mount: nothing to drop
		if (debounceRef.current) {
			clearTimeout(debounceRef.current);
			debounceRef.current = null;
		}
		pendingSceneRef.current = null;
		dirtyRef.current = false;
		onDirtyChangeRef.current(false);
	}, [reloadKey]);

	const handleChange: NonNullable<ExcalidrawProps["onChange"]> = useCallback(
		(elements, appState, files) => {
			pendingSceneRef.current = [elements, appState, files];
			if (!dirtyRef.current) {
				dirtyRef.current = true;
				onDirtyChangeRef.current(true);
			}
			schedulePersist();
		},
		[schedulePersist],
	);

	// An empty or unreadable file still opens a blank canvas — the next
	// autosave creates/repairs the file on disk.
	return (
		<div className={`h-full w-full ${className ?? ""}`}>
			<Excalidraw
				key={reloadKey}
				initialData={initialData}
				onChange={handleChange}
				theme={theme}
				langCode={i18n.language}
				UIOptions={UI_OPTIONS}
			/>
		</div>
	);
}
