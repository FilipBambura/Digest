// Auto-resizing <textarea> behavior. Deliberately JS-driven rather than a
// pure CSS flex/height:100% chain - that chain is fragile on mobile, where
// the layout-vs-visual-viewport split (keyboard open) breaks height
// propagation through ancestor elements.

function verticalBoxExtras(style: CSSStyleDeclaration): number {
	return (
		parseFloat(style.paddingTop) +
		parseFloat(style.paddingBottom) +
		parseFloat(style.borderTopWidth) +
		parseFloat(style.borderBottomWidth)
	);
}

function rowsToPx(textarea: HTMLTextAreaElement, rows: number): number {
	const style = window.getComputedStyle(textarea);
	const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
	return rows * lineHeight + verticalBoxExtras(style);
}

/**
 * Grows the textarea with its content between `minRows` and `maxRows`,
 * showing a scrollbar once content exceeds `maxRows`.
 */
export function autosizeClamped(textarea: HTMLTextAreaElement, minRows: number, maxRows: number): () => void {
	const resize = () => {
		const minPx = rowsToPx(textarea, minRows);
		const maxPx = rowsToPx(textarea, maxRows);
		textarea.style.height = "auto";
		const contentPx = textarea.scrollHeight;
		const targetPx = Math.min(Math.max(contentPx, minPx), maxPx);
		textarea.style.height = `${targetPx}px`;
		textarea.style.overflowY = contentPx > maxPx ? "auto" : "hidden";
	};

	textarea.style.minHeight = `${rowsToPx(textarea, minRows)}px`;
	textarea.addEventListener("input", resize);
	resize();

	return () => textarea.removeEventListener("input", resize);
}

/**
 * Grows the textarea to fill the visible space below it, down to the
 * bottom of the on-screen viewport - re-fitting when the on-screen
 * keyboard opens/closes (visualViewport resize/scroll) or the window
 * resizes. Content beyond that height scrolls natively inside the textarea.
 */
export function autosizeFillAvailable(textarea: HTMLTextAreaElement, minRows: number): () => void {
	const bottomMargin = 16;

	const resize = () => {
		const minPx = rowsToPx(textarea, minRows);
		const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
		const top = textarea.getBoundingClientRect().top;
		const availablePx = viewportHeight - top - bottomMargin;
		textarea.style.height = `${Math.max(minPx, availablePx)}px`;
	};

	textarea.style.minHeight = `${rowsToPx(textarea, minRows)}px`;
	window.addEventListener("resize", resize);
	window.visualViewport?.addEventListener("resize", resize);
	window.visualViewport?.addEventListener("scroll", resize);
	window.setTimeout(resize, 0);

	return () => {
		window.removeEventListener("resize", resize);
		window.visualViewport?.removeEventListener("resize", resize);
		window.visualViewport?.removeEventListener("scroll", resize);
	};
}

/**
 * Caps `el`'s height to the visible viewport (shrinking as the on-screen
 * keyboard opens) and makes it scroll internally past that cap, so content
 * hidden behind the keyboard can always be reached by scrolling. Deliberately
 * ignores the element's own position (no `getBoundingClientRect`) and uses
 * only `visualViewport.height` - on iOS, a stacked modal on top of another
 * can make `visualViewport.offsetTop` drift, but the height itself stays
 * reliable.
 */
export function bindScrollableHeight(el: HTMLElement, marginPx = 96): () => void {
	const resize = () => {
		const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
		el.style.maxHeight = `${Math.max(viewportHeight - marginPx, 160)}px`;
	};

	el.style.overflowY = "auto";
	window.addEventListener("resize", resize);
	window.visualViewport?.addEventListener("resize", resize);
	window.visualViewport?.addEventListener("scroll", resize);
	resize();

	return () => {
		window.removeEventListener("resize", resize);
		window.visualViewport?.removeEventListener("resize", resize);
		window.visualViewport?.removeEventListener("scroll", resize);
	};
}
