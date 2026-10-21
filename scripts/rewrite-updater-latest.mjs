#!/usr/bin/env node
// Rewrite Tauri updater latest.json URLs from GitHub API asset endpoints
// (403 without a token) to public browser_download_url values.
// See docs/bug_fix/updater-github-api-asset-urls.md.

import { pathToFileURL } from "node:url";

const API_ASSET_URL =
	/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)(?:\?.*)?$/i;

const USER_AGENT = "Agentero-updater-latest-rewrite";

/**
 * @param {unknown} latest
 * @param {Iterable<{ id?: unknown, browser_download_url?: unknown }>} assets
 * @returns {{ latest: object, changed: boolean, missing: string[] }}
 */
export function rewriteUpdaterLatest(latest, assets) {
	if (!latest || typeof latest !== "object" || Array.isArray(latest)) {
		throw new Error("latest.json must be an object");
	}
	const platforms = latest.platforms;
	if (!platforms || typeof platforms !== "object" || Array.isArray(platforms)) {
		throw new Error("latest.json is missing platforms");
	}
	const byId = new Map();
	for (const asset of assets) {
		if (asset == null || typeof asset !== "object") continue;
		const id = Number(asset.id);
		const url = asset.browser_download_url;
		if (!Number.isInteger(id) || typeof url !== "string" || !url) continue;
		byId.set(String(id), url);
	}
	const nextPlatforms = { ...platforms };
	const missing = [];
	let changed = false;
	for (const [key, platform] of Object.entries(platforms)) {
		if (!platform || typeof platform !== "object") continue;
		const url = platform.url;
		if (typeof url !== "string") continue;
		const match = url.match(API_ASSET_URL);
		if (!match) continue;
		const publicUrl = byId.get(match[1]);
		if (!publicUrl) {
			missing.push(`${key} asset ${match[1]}`);
			continue;
		}
		nextPlatforms[key] = { ...platform, url: publicUrl };
		changed = true;
	}
	return {
		latest: changed ? { ...latest, platforms: nextPlatforms } : latest,
		changed,
		missing,
	};
}

export function apiAssetId(url) {
	const match = typeof url === "string" ? url.match(API_ASSET_URL) : null;
	return match ? match[1] : null;
}

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const args = { tag: "", dryRun: false };
	for (const arg of argv) {
		if (arg === "--dry-run") args.dryRun = true;
		else if (!arg.startsWith("-") && !args.tag) args.tag = arg;
		else fail(`Unknown argument: ${arg}`);
	}
	return args;
}

async function githubJson(url, token, { accept, method, body } = {}) {
	const headers = {
		Accept: accept ?? "application/vnd.github+json",
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	if (body !== undefined) headers["Content-Type"] = "application/json";
	const response = await fetch(url, { method: method ?? "GET", headers, body });
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`${method ?? "GET"} ${url} → HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
		);
	}
	if (response.status === 204) return null;
	return response.json();
}

async function githubBytes(url, token) {
	const headers = {
		Accept: "application/octet-stream",
		"User-Agent": USER_AGENT,
	};
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetch(url, { headers });
	if (!response.ok) {
		throw new Error(`GET ${url} → HTTP ${response.status}`);
	}
	return Buffer.from(await response.arrayBuffer());
}

async function findRelease(repo, tag, token) {
	try {
		return await githubJson(
			`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`,
			token,
		);
	} catch (error) {
		if (!String(error.message).includes("HTTP 404")) throw error;
	}
	let page = 1;
	while (page <= 10) {
		const releases = await githubJson(
			`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
			token,
		);
		if (!Array.isArray(releases) || releases.length === 0) break;
		const match = releases.find((release) => release.tag_name === tag);
		if (match) return match;
		page += 1;
	}
	throw new Error(`Release ${tag} not found in ${repo}`);
}

async function listAssets(repo, releaseId, token) {
	const assets = [];
	let page = 1;
	while (page <= 10) {
		const batch = await githubJson(
			`https://api.github.com/repos/${repo}/releases/${releaseId}/assets?per_page=100&page=${page}`,
			token,
		);
		if (!Array.isArray(batch) || batch.length === 0) break;
		assets.push(...batch);
		if (batch.length < 100) break;
		page += 1;
	}
	return assets;
}

async function replaceLatestJson(repo, release, asset, body, token) {
	await githubJson(
		`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`,
		token,
		{ method: "DELETE" },
	);
	const origin = new URL(release.upload_url).origin;
	const uploadUrl = `${origin}/repos/${repo}/releases/${release.id}/assets?name=latest.json`;
	const response = await fetch(uploadUrl, {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
			"X-GitHub-Api-Version": "2022-11-28",
		},
		body,
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(
			`Upload latest.json → HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
		);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const repo = process.env.GITHUB_REPOSITORY;
	const tag = args.tag || process.env.GITHUB_REF_NAME || "";
	const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
	if (!repo) fail("GITHUB_REPOSITORY is required (owner/name)");
	if (!tag) fail("Pass a tag (v0.12.0) or set GITHUB_REF_NAME");

	const release = await findRelease(repo, tag, token);
	const assets = await listAssets(repo, release.id, token);
	const latestAsset = assets.find((asset) => asset.name === "latest.json");
	if (!latestAsset) {
		fail(`Release ${tag} has no latest.json asset`);
	}

	const source = token ? latestAsset.url : latestAsset.browser_download_url;
	if (!source) fail(`Release ${tag} latest.json has no download URL`);
	const bytes = await githubBytes(source, token);
	const parsed = JSON.parse(bytes.toString("utf8"));
	const { latest, changed, missing } = rewriteUpdaterLatest(parsed, assets);
	if (missing.length > 0) {
		fail(`Missing browser_download_url for: ${missing.join(", ")}`);
	}
	const serialized = `${JSON.stringify(latest, null, 2)}\n`;
	if (args.dryRun) {
		process.stdout.write(serialized);
		console.error(
			changed
				? `Rewrote API asset URLs in ${tag} latest.json (dry-run)`
				: `${tag} latest.json already uses public download URLs`,
		);
		return;
	}
	if (!changed) {
		console.log(`${tag} latest.json already uses public download URLs`);
		return;
	}
	if (!token) {
		fail("GITHUB_TOKEN is required to upload the rewritten latest.json");
	}
	await replaceLatestJson(repo, release, latestAsset, serialized, token);
	console.log(`Replaced ${tag} latest.json with public GitHub download URLs`);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error) => {
		fail(error instanceof Error ? error.message : String(error));
	});
}
