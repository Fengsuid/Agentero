/** Collapse whitespace, then truncate with an ellipsis. */
export function shorten(text: string, max: number): string {
	const t = text.trim().replace(/\s+/g, " ");
	if (!t) return "";
	return t.length > max ? `${t.slice(0, Math.max(1, max - 1))}…` : t;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isRect(
	v: unknown,
): v is { x: number; y: number; w: number; h: number } {
	if (!isRecord(v)) return false;
	return (
		typeof v.x === "number" &&
		typeof v.y === "number" &&
		typeof v.w === "number" &&
		typeof v.h === "number"
	);
}
