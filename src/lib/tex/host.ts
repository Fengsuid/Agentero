/** Typed desktop LaTeX operations shared by build, editor and PDF surfaces. */
import { invoke } from "@tauri-apps/api/core";
import type { ApiResult, JobLane, JobSnapshot } from "@/lib/core/bindings";

export type LatexTool = {
	command: string;
	args: string[];
	env?: Record<string, string>;
	cwd?: string;
};
export type LatexRecipe = { name: string; tools: LatexTool[] };
export type LatexBuildOptions = {
	recipe?: LatexRecipe | null;
	outDir?: string;
	auxDir?: string;
	jobname?: string;
	force?: boolean;
	clean?: boolean;
};
export type LatexArtifacts = {
	pdfPath: string;
	logPath: string;
	synctexPath: string;
	flsPath: string;
	outDir: string;
	auxDir: string;
};
export type LatexProjectInfo = {
	rootPath: string;
	candidates: string[];
	texFiles: string[];
	bibFiles: string[];
	dependencies: string[];
};
export type LatexDiagnostic = {
	path: string;
	line: number;
	column: number;
	severity: "error" | "warning" | "info";
	message: string;
	source: string;
};
export type LatexCompileLog = { jobId: string; rootPath: string; line: string };
export type LatexCompileResult = {
	jobId: string;
	rootPath: string;
	success: boolean;
	pdfPath: string;
	logPath: string;
	synctexPath: string;
	dependencies: string[];
	diagnostics: LatexDiagnostic[];
};
export type LatexBuildFinishedEvent = LatexCompileResult;
export type SyncTexLocation = {
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
};
export type SyncTexSource = { path: string; line: number; column: number };

async function call<T>(
	command: string,
	args: Record<string, unknown>,
): Promise<T> {
	const result = await invoke<ApiResult<T>>(command, args);
	if (!result.ok) throw new Error(result.error?.message ?? command);
	return result.data as T;
}

export function enqueueLatexBuild(args: {
	vaultPath: string;
	texPath: string;
	engine: string;
	build?: LatexBuildOptions | null;
	lane?: JobLane | null;
	force?: boolean;
}): Promise<ApiResult<JobSnapshot>> {
	return invoke("job_latex_compile_enqueue", { args });
}
export const getLatexArtifacts = (
	rootPath: string,
	build?: LatexBuildOptions | null,
): Promise<LatexArtifacts> =>
	call("latex_build_artifacts", { rootPath, build: build ?? null });
export const inspectLatexProject = (
	texPath: string,
	vaultPath: string,
	rootPath?: string | null,
	build?: LatexBuildOptions | null,
): Promise<LatexProjectInfo> =>
	call("latex_project_inspect", {
		texPath,
		vaultPath,
		rootPath: rootPath ?? null,
		build: build ?? null,
	});
export const syncTexForward = (
	pdfPath: string,
	texPath: string,
	line: number,
	column = 1,
): Promise<SyncTexLocation[]> =>
	call("latex_synctex_forward", { pdfPath, texPath, line, column });
export const syncTexBackward = (
	pdfPath: string,
	page: number,
	x: number,
	y: number,
): Promise<SyncTexSource | null> =>
	call("latex_synctex_backward", { pdfPath, page, x, y });
export const cleanLatexArtifacts = (
	rootPath: string,
	build?: LatexBuildOptions | null,
): Promise<void> => call("latex_clean", { rootPath, build: build ?? null });
