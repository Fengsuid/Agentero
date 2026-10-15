/**
 * Citation URIs returned by the context tools. The same strings the agent is
 * asked to cite, opened through the existing paper jump.
 */
import { openCitation } from "@/lib/workspace/actions";

function sourceLabel(source: string): string {
	const trimmed = source.trim();
	const hash = trimmed.lastIndexOf("#");
	const path = hash >= 0 ? trimmed.slice(0, hash) : trimmed;
	const fragment = hash >= 0 ? trimmed.slice(hash) : "";
	const name = path.split("/").filter(Boolean).pop() || path;
	return `${name}${fragment}`;
}

export function ContextSourceLinks({ sources }: { sources: string[] }) {
	const unique = sources.map((source) => source.trim()).filter(Boolean);
	if (!unique.length) return null;
	return (
		<div className="flex flex-wrap gap-1">
			{unique.map((source) => (
				<button
					key={source}
					type="button"
					className="max-w-full truncate rounded-md border border-border px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:text-foreground"
					title={source}
					aria-label={source}
					onClick={() => openCitation(source)}
				>
					{sourceLabel(source)}
				</button>
			))}
		</div>
	);
}
