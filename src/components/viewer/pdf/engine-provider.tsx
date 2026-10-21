import type { PdfEngine } from "@embedpdf/models";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { createPdfEngine, disposePdfEngine } from "@/lib/pdf/engine";

type PdfEngineContextValue = {
	engine: PdfEngine | null;
	isLoading: boolean;
	error: Error | null;
};

const PdfEngineContext = createContext<PdfEngineContextValue>({
	engine: null,
	isLoading: true,
	error: null,
});

function useAgenteroPdfEngine(): PdfEngineContextValue {
	const [state, setState] = useState<PdfEngineContextValue>({
		engine: null,
		isLoading: true,
		error: null,
	});

	useEffect(() => {
		const controller = new AbortController();
		let current: PdfEngine | null = null;

		createPdfEngine(controller.signal)
			.then((engine) => {
				if (controller.signal.aborted) {
					disposePdfEngine(engine);
					return;
				}
				current = engine;
				setState({ engine, isLoading: false, error: null });
			})
			.catch((error: unknown) => {
				if (controller.signal.aborted) return;
				setState({
					engine: null,
					isLoading: false,
					error: error instanceof Error ? error : new Error(String(error)),
				});
			});

		return () => {
			controller.abort();
			if (current) disposePdfEngine(current);
			current = null;
		};
	}, []);

	return state;
}

/**
 * Creates the PDFium (WASM) engine once for the whole workspace window and
 * shares it with every PDF tab via context. PDFium holds many documents
 * concurrently, so a single engine backs all `<EmbedPDF>` providers.
 */
export function PdfEngineHost({ children }: { children: ReactNode }) {
	const { engine, isLoading, error } = useAgenteroPdfEngine();
	return (
		<PdfEngineContext.Provider value={{ engine, isLoading, error }}>
			{children}
		</PdfEngineContext.Provider>
	);
}

export function usePdfEngineContext(): PdfEngineContextValue {
	return useContext(PdfEngineContext);
}
