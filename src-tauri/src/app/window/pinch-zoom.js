// WebView2 must enable pinch recognition to dispatch its synthetic Ctrl+wheel.
// Cancel its default page-scale zoom in capture, before PDF target listeners.
// This tiny Windows-only guard never scrolls, changes layout, or updates React.
(() => {
	let controlPressed = false;
	const updateControl = (event) => {
		controlPressed = event.ctrlKey;
	};
	window.addEventListener("keydown", updateControl, true);
	window.addEventListener("keyup", updateControl, true);
	window.addEventListener("blur", () => {
		controlPressed = false;
	});
	window.addEventListener(
		"wheel",
		(event) => {
			if (!event.ctrlKey) return;
			// A precision touchpad synthesizes Control without a key press. The
			// delta bound also keeps a mouse notch safe if Ctrl predates this page.
			if (!controlPressed && event.deltaMode === 0 && Math.abs(event.deltaY) < 40) {
				Object.defineProperty(event, "agenteroPinch", { value: true });
			}
			if (event.cancelable) event.preventDefault();
		},
		{ capture: true, passive: false },
	);
})();
