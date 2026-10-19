// Load the font and image files a display list refers to.
//
// Ported from realtime-tex's VS Code host (MIT). The extension host used
// Node's `fs`/`child_process`; here the bytes come from two narrow Tauri
// commands:
//   - `rtex_kpsewhich` resolves a name and adds the result to the session's
//     read allow-list;
//   - `rtex_read_tex_file` returns base64 for allow-listed/project files.
import { commands } from "@/lib/core/bindings";
import { joinPath } from "@/lib/core/path";
import type { DisplayList, FontDesc } from "../protocol";
import { type FontResource, fontKey, type ImageResource } from "./font-key";
import {
	type MapEntry,
	parseEncFile,
	parseMapFile,
	type1Outlines,
} from "./type1";

function decodeBase64(value: string): Uint8Array {
	const binary = atob(value);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		out[i] = binary.charCodeAt(i);
	}
	return out;
}

function latin1(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		out += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return out;
}

export class ResourceLoader {
	private kpseCache = new Map<string, Promise<string | undefined>>();
	private mapFile: Promise<Map<string, MapEntry>> | undefined;
	private fonts = new Map<string, Promise<FontResource>>();

	constructor(
		private readonly sessionId: string,
		private readonly projectRoot: string,
		private readonly log: (message: string) => void = () => undefined,
	) {}

	/** Font resources needed by `dls` that are not in `have`, keyed by fontKey. */
	async fontsFor(
		dls: readonly DisplayList[],
		have: ReadonlySet<string>,
	): Promise<Map<string, FontResource>> {
		const want = new Map<string, FontDesc>();
		for (const dl of dls) {
			for (const desc of Object.values(dl.fonts ?? {})) {
				const key = fontKey(desc);
				if (!have.has(key) && !want.has(key)) want.set(key, desc);
			}
		}
		const out = new Map<string, FontResource>();
		await Promise.all(
			[...want].map(async ([key, desc]) => {
				out.set(key, await this.font(key, desc));
			}),
		);
		return out;
	}

	/** Image files referenced by `dls` that are not in `have`. */
	async imagesFor(
		dls: readonly DisplayList[],
		have: ReadonlySet<string>,
	): Promise<Map<string, ImageResource>> {
		const want = new Set<string>();
		for (const dl of dls) {
			for (const info of Object.values(dl.images_info ?? {})) {
				if (info.file && !info.cached_picture && !have.has(info.file)) {
					want.add(info.file);
				}
			}
		}
		const out = new Map<string, ImageResource>();
		await Promise.all(
			[...want].map(async (file) => {
				out.set(file, await this.image(file));
			}),
		);
		return out;
	}

	private font(key: string, desc: FontDesc): Promise<FontResource> {
		let pending = this.fonts.get(key);
		if (!pending) {
			pending = this.loadFont(desc).catch(
				(error: Error) =>
					({
						kind: "missing",
						reason: error.message,
					}) satisfies FontResource,
			);
			this.fonts.set(key, pending);
		}
		return pending;
	}

	private async loadFont(desc: FontDesc): Promise<FontResource> {
		if (desc.filename) {
			const file = await this.locate(desc.filename);
			if (!file) {
				return {
					kind: "missing",
					reason: `font file not found: ${desc.filename}`,
				};
			}
			const lower = file.toLowerCase();
			if (lower.endsWith(".otf") || lower.endsWith(".ttf")) {
				return { kind: "sfnt", data: await this.read(file) };
			}
			if (lower.endsWith(".pfb") || lower.endsWith(".pfa")) {
				const entry = desc.name ? (await this.map()).get(desc.name) : undefined;
				return this.loadType1(file, entry);
			}
			return {
				kind: "missing",
				reason: `unsupported font format: ${file}`,
			};
		}
		const name = desc.name ?? "";
		const entry = (await this.map()).get(name);
		if (!entry?.fontFile) {
			return {
				kind: "missing",
				reason: `no outline font for ${name} in pdftex.map`,
			};
		}
		const file = await this.locate(entry.fontFile);
		if (!file) {
			return {
				kind: "missing",
				reason: `font file not found: ${entry.fontFile}`,
			};
		}
		if (/\.(otf|ttf)$/i.test(file)) {
			return {
				kind: "missing",
				reason: `TFM font mapped to OpenType (${entry.fontFile})`,
			};
		}
		return this.loadType1(file, entry);
	}

	private async loadType1(
		file: string,
		entry: MapEntry | undefined,
	): Promise<FontResource> {
		let encoding: string[] | undefined;
		if (entry?.encFile) {
			const encPath = await this.locate(entry.encFile);
			if (encPath) encoding = parseEncFile(latin1(await this.read(encPath)));
		}
		const { upem, glyphs } = type1Outlines(await this.read(file), encoding);
		return {
			kind: "type1",
			upem,
			glyphs,
			slant: entry?.slant,
			extend: entry?.extend,
		};
	}

	private async image(file: string): Promise<ImageResource> {
		const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(file);
		const candidates = isAbsolute ? [file] : [joinPath(this.projectRoot, file)];
		for (const candidate of candidates) {
			try {
				const lower = candidate.toLowerCase();
				if (lower.endsWith(".pdf")) {
					return {
						kind: "pdf",
						mime: "application/pdf",
						data: await this.read(candidate),
					};
				}
				const mime = lower.endsWith(".png")
					? "image/png"
					: lower.endsWith(".jpg") || lower.endsWith(".jpeg")
						? "image/jpeg"
						: "";
				if (!mime) {
					return {
						kind: "missing",
						reason: `unsupported image format: ${candidate}`,
					};
				}
				return { kind: "bitmap", mime, data: await this.read(candidate) };
			} catch {
				/* next candidate */
			}
		}
		return { kind: "missing", reason: `image not found: ${file}` };
	}

	private async map(): Promise<Map<string, MapEntry>> {
		if (!this.mapFile) {
			this.mapFile = (async () => {
				const file = await this.kpsewhich("pdftex.map");
				if (!file) {
					this.log("pdftex.map not found: Type1 fonts render from the PDF");
					return new Map<string, MapEntry>();
				}
				return parseMapFile(latin1(await this.read(file)));
			})();
		}
		return this.mapFile;
	}

	private async locate(file: string): Promise<string | undefined> {
		if (/^([a-zA-Z]:[\\/]|[\\/])/.test(file)) {
			try {
				await this.read(file);
				return file;
			} catch {
				return this.kpsewhich(file.replace(/^.*[\\/]/, ""));
			}
		}
		return this.kpsewhich(file);
	}

	kpsewhich(file: string): Promise<string | undefined> {
		let pending = this.kpseCache.get(file);
		if (!pending) {
			pending = (async () => {
				const result = await commands.rtexKpsewhich(this.sessionId, file);
				return result.ok ? (result.data ?? undefined) : undefined;
			})().catch(() => undefined);
			this.kpseCache.set(file, pending);
		}
		return pending;
	}

	private async read(path: string): Promise<Uint8Array> {
		const result = await commands.rtexReadTexFile(this.sessionId, path);
		if (!result.ok || !result.data) {
			throw new Error(result.error?.message ?? `cannot read ${path}`);
		}
		return decodeBase64(result.data);
	}
}
