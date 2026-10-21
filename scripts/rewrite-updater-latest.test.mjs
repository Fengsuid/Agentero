import assert from "node:assert/strict";
import { test } from "node:test";
import { apiAssetId, rewriteUpdaterLatest } from "./rewrite-updater-latest.mjs";

const assets = [
	{
		id: 654003754,
		browser_download_url:
			"https://github.com/poco-ai/Agentero/releases/download/v0.12.0/Agentero_0.12.0_x64-setup.exe",
	},
	{
		id: 654020500,
		browser_download_url:
			"https://github.com/poco-ai/Agentero/releases/download/v0.12.0/Agentero_0.12.0_aarch64.app.tar.gz",
	},
];

test("rewrites GitHub API asset URLs to browser_download_url", () => {
	const { latest, changed, missing } = rewriteUpdaterLatest(
		{
			version: "0.12.0",
			platforms: {
				"windows-x86_64": {
					signature: "sig",
					url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/654003754",
				},
				"windows-x86_64-nsis": {
					signature: "sig",
					url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/654003754",
				},
				"darwin-aarch64": {
					signature: "sig",
					url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/654020500",
				},
			},
		},
		assets,
	);
	assert.equal(changed, true);
	assert.deepEqual(missing, []);
	assert.equal(
		latest.platforms["windows-x86_64"].url,
		assets[0].browser_download_url,
	);
	assert.equal(
		latest.platforms["windows-x86_64-nsis"].url,
		assets[0].browser_download_url,
	);
	assert.equal(
		latest.platforms["darwin-aarch64"].url,
		assets[1].browser_download_url,
	);
});

test("leaves public GitHub download URLs unchanged", () => {
	const input = {
		version: "0.12.0",
		platforms: {
			"windows-x86_64": {
				signature: "sig",
				url: assets[0].browser_download_url,
			},
		},
	};
	const { latest, changed, missing } = rewriteUpdaterLatest(input, assets);
	assert.equal(changed, false);
	assert.equal(latest, input);
	assert.deepEqual(missing, []);
});

test("reports API asset URLs that have no matching release asset", () => {
	const { changed, missing } = rewriteUpdaterLatest(
		{
			platforms: {
				"linux-x86_64": {
					url: "https://api.github.com/repos/poco-ai/Agentero/releases/assets/1",
				},
			},
		},
		assets,
	);
	assert.equal(changed, false);
	assert.deepEqual(missing, ["linux-x86_64 asset 1"]);
});

test("apiAssetId extracts the numeric GitHub asset id", () => {
	assert.equal(
		apiAssetId(
			"https://api.github.com/repos/poco-ai/Agentero/releases/assets/654003754",
		),
		"654003754",
	);
	assert.equal(apiAssetId(assets[0].browser_download_url), null);
});
