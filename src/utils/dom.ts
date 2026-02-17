/**
 * Creates a debounced function that delays invoking `fn` until `delayMs`
 * milliseconds have elapsed since the last invocation.
 */
export function debounce<T extends (...args: unknown[]) => void>(
	fn: T,
	delayMs: number,
): (...args: Parameters<T>) => void {
	let timer: number | null = null;

	return (...args: Parameters<T>) => {
		if (timer !== null) {
			window.clearTimeout(timer);
		}
		timer = window.setTimeout(() => {
			timer = null;
			fn(...args);
		}, delayMs);
	};
}
