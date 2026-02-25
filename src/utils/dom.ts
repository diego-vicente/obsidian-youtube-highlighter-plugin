/**
 * A debounced function with additional control methods.
 * - Call it normally to schedule a debounced invocation.
 * - `cancel()` — drops any pending invocation without calling `fn`.
 * - `flushIfPending()` — if a call is pending, fires `fn` immediately
 *   and clears the timer; otherwise does nothing.
 */
export interface DebouncedFn<T extends (...args: unknown[]) => void> {
	(...args: Parameters<T>): void;
	/** Cancel any pending invocation without calling fn. */
	cancel(): void;
	/**
	 * If a call is pending, invoke fn immediately and clear the timer.
	 * No-op if nothing is pending.
	 */
	flushIfPending(): void;
}

/**
 * Creates a debounced function that delays invoking `fn` until `delayMs`
 * milliseconds have elapsed since the last invocation.
 *
 * The returned function also exposes `cancel()` and `flushIfPending()`
 * for explicit lifecycle control (e.g. flushing on plugin unload,
 * cancelling before a merge from external sync).
 */
export function debounce<T extends (...args: unknown[]) => void>(
	fn: T,
	delayMs: number,
): DebouncedFn<T> {
	let timer: number | null = null;
	let pendingArgs: Parameters<T> | null = null;

	const clearTimer = (): void => {
		if (timer !== null) {
			window.clearTimeout(timer);
			timer = null;
		}
	};

	const debounced = ((...args: Parameters<T>) => {
		clearTimer();
		pendingArgs = args;
		timer = window.setTimeout(() => {
			timer = null;
			pendingArgs = null;
			fn(...args);
		}, delayMs);
	}) as DebouncedFn<T>;

	debounced.cancel = () => {
		clearTimer();
		pendingArgs = null;
	};

	debounced.flushIfPending = () => {
		if (timer !== null && pendingArgs !== null) {
			const args = pendingArgs;
			clearTimer();
			pendingArgs = null;
			fn(...args);
		}
	};

	return debounced;
}
