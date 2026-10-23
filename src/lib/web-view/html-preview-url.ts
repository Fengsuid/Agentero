/**
 * URL of a local HTML preview served by the `agentero-html` scheme.
 *
 * The token is the directory grant from `html_preview_grant`. `name` is the
 * file name and must be the last path segment so relative assets resolve
 * next to it. Windows WebView2 rewrites custom schemes to
 * `http://<scheme>.localhost`, same as `webViewProxyUrl`.
 */

/** Sandbox for the preview frame. Opaque origin: scripts run, parent does not. */
export const LOCAL_HTML_SANDBOX = "allow-scripts";

export function localHtmlPreviewUrl(
	token: string,
	name: string,
	version: number,
): string {
	const isWindows =
		typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
	const origin = isWindows
		? "http://agentero-html.localhost"
		: "agentero-html://localhost";
	const file = name
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `${origin}/t/${encodeURIComponent(token)}/${file}?v=${version}`;
}
