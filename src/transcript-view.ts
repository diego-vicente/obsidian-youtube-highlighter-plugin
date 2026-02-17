import type {TranscriptEntry} from "./types";
import type {PlayerWrapper} from "./player";
import {PlayerState} from "./player";
import {secondsToTimestamp} from "./utils/time";

const SYNC_POLL_INTERVAL_MS = 250;
const SCROLL_CENTER_DIVISOR = 2;

/** CSS class names used by the transcript view. */
const CSS = {
	container: "yt-highlighter-transcript",
	line: "yt-highlighter-transcript-line",
	lineActive: "yt-highlighter-transcript-line--active",
	timestamp: "yt-highlighter-transcript-timestamp",
	text: "yt-highlighter-transcript-text",
	empty: "yt-highlighter-transcript-empty",
} as const;

export interface TranscriptView {
	/** The container element holding the transcript. */
	containerEl: HTMLElement;
	/** Start polling for sync with the player. */
	startSync(): void;
	/** Stop polling. */
	stopSync(): void;
	/** Clean up all resources. */
	destroy(): void;
}

/**
 * Renders a scrolling transcript panel synced to a YouTube player.
 * - Each line shows a timestamp and transcript text.
 * - The currently playing line is highlighted (karaoke-style).
 * - Clicking a line seeks the video to that timestamp.
 */
export function createTranscriptView(
	parentEl: HTMLElement,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
): TranscriptView {
	const containerEl = parentEl.createDiv({cls: CSS.container});

	if (entries.length === 0) {
		containerEl.createDiv({cls: CSS.empty, text: "No transcript available."});
		return {containerEl, startSync: noop, stopSync: noop, destroy: noop};
	}

	const lineElements = renderLines(containerEl, entries, player);

	let syncInterval: number | null = null;
	let activeIndex = -1;

	function updateActiveLineFromTime(currentTime: number): void {
		const newIndex = findActiveEntryIndex(entries, currentTime);
		if (newIndex === activeIndex) return;

		// Remove highlight from previous active line.
		if (activeIndex >= 0 && activeIndex < lineElements.length) {
			lineElements[activeIndex]?.removeClass(CSS.lineActive);
		}

		activeIndex = newIndex;

		// Add highlight to new active line and scroll it into view within the container.
		if (activeIndex >= 0 && activeIndex < lineElements.length) {
			const activeLine = lineElements[activeIndex];
			activeLine?.addClass(CSS.lineActive);
			if (activeLine) {
				scrollToLineInContainer(containerEl, activeLine);
			}
		}
	}

	function startSync(): void {
		if (syncInterval !== null) return;

		syncInterval = window.setInterval(() => {
			void player.instance.getPlayerState().then(async (state) => {
				if (state === PlayerState.PLAYING) {
					const currentTime = await player.getCurrentTime();
					updateActiveLineFromTime(currentTime);
				}
			});
		}, SYNC_POLL_INTERVAL_MS);
	}

	function stopSync(): void {
		if (syncInterval !== null) {
			window.clearInterval(syncInterval);
			syncInterval = null;
		}
	}

	function destroy(): void {
		stopSync();
	}

	// Auto-start sync when the player begins playing.
	player.onStateChange((state) => {
		if (state === PlayerState.PLAYING) {
			startSync();
		} else if (state === PlayerState.PAUSED || state === PlayerState.ENDED) {
			stopSync();
		}
	});

	return {containerEl, startSync, stopSync, destroy};
}

/**
 * Renders all transcript lines into the container.
 * Returns an array of line elements (indexed parallel to entries).
 */
function renderLines(
	containerEl: HTMLElement,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
): HTMLElement[] {
	return entries.map((entry) => {
		const lineEl = containerEl.createDiv({cls: CSS.line});

		lineEl.createSpan({
			cls: CSS.timestamp,
			text: secondsToTimestamp(entry.offset),
		});

		lineEl.createSpan({
			cls: CSS.text,
			text: entry.text,
		});

		// Click to seek.
		lineEl.addEventListener("click", () => {
			void player.seekTo(entry.offset);
		});

		return lineEl;
	});
}

/**
 * Binary search for the transcript entry active at the given time.
 * Returns the index of the entry whose offset is ≤ currentTime
 * and whose end (offset + duration) is > currentTime.
 * Falls back to the last entry whose offset ≤ currentTime.
 */
function findActiveEntryIndex(entries: TranscriptEntry[], currentTime: number): number {
	if (entries.length === 0) return -1;

	let low = 0;
	let high = entries.length - 1;
	let result = -1;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const entry = entries[mid];
		if (!entry) break;

		if (entry.offset <= currentTime) {
			result = mid;
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	return result;
}

/**
 * Scrolls the container so the target line is vertically centered,
 * without affecting the scroll position of the surrounding note.
 */
function scrollToLineInContainer(container: HTMLElement, line: HTMLElement): void {
	const lineTop = line.offsetTop - container.offsetTop;
	const centeredPosition = lineTop - container.clientHeight / SCROLL_CENTER_DIVISOR + line.clientHeight / SCROLL_CENTER_DIVISOR;
	container.scrollTo({top: centeredPosition, behavior: "smooth"});
}

function noop(): void {
	// intentionally empty
}
