import type {TranscriptEntry} from "./types";
import type {PlayerWrapper} from "./player";
import {PlayerState} from "./player";

const SYNC_POLL_INTERVAL_MS = 250;
const SCROLL_CENTER_DIVISOR = 2;

/** Speaker change marker that YouTube uses at the start of subtitle text. */
const SPEAKER_CHANGE_PREFIX = "- ";

/**
 * Fallback: maximum segments per paragraph when no speaker markers are present.
 * Prevents a single wall-of-text paragraph for videos without speaker indicators.
 */
const MAX_SEGMENTS_PER_PARAGRAPH = 6;

/** CSS class names used by the transcript view. */
const CSS = {
	container: "yt-highlighter-transcript",
	paragraph: "yt-highlighter-transcript-paragraph",
	segment: "yt-highlighter-transcript-segment",
	segmentActive: "yt-highlighter-transcript-segment--active",
	empty: "yt-highlighter-transcript-empty",
} as const;

export interface TranscriptView {
	/** The container element holding the transcript. */
	containerEl: HTMLElement;
	/** Map from original entry index → array of rendered spans (for highlights). */
	entrySpanMap: HTMLElement[][];
	/** Start polling for sync with the player. */
	startSync(): void;
	/** Stop polling. */
	stopSync(): void;
	/** Clean up all resources. */
	destroy(): void;
}

// ─── Paragraph grouping (display only) ───────────────────────────────

/** Regex to split on mid-text speaker changes like "- Right. - C is a constant." */
const MID_TEXT_SPEAKER_SPLIT = /\s+(?=- )/;

/**
 * A display segment maps to one or more visual spans. When a single transcript
 * entry contains multiple speakers (e.g. "- Right. - C is a constant."),
 * it gets split into separate display segments that share the same offset.
 * The `sourceIndex` tracks which original entry this came from (for sync).
 */
interface DisplaySegment {
	text: string;
	offset: number;
	sourceIndex: number;
}

/**
 * Splits transcript entries that contain multiple speakers into
 * separate display segments. Purely for rendering — the underlying
 * transcript data is not modified.
 */
function splitMultiSpeakerEntries(entries: TranscriptEntry[]): DisplaySegment[] {
	const segments: DisplaySegment[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const parts = entry.text.split(MID_TEXT_SPEAKER_SPLIT);
		for (const part of parts) {
			if (part.trim()) {
				segments.push({text: part, offset: entry.offset, sourceIndex: i});
			}
		}
	}

	return segments;
}

/** A paragraph is a group of consecutive display segments rendered as flowing text. */
interface DisplayParagraph {
	segments: DisplaySegment[];
}

/**
 * Groups display segments into paragraphs.
 *
 * Primary signal: speaker changes (text starts with "- ").
 * Fallback: if no speaker markers exist in the transcript, groups are
 * capped at MAX_SEGMENTS_PER_PARAGRAPH to avoid walls of text.
 */
function groupIntoParagraphs(segments: DisplaySegment[]): DisplayParagraph[] {
	if (segments.length === 0) return [];

	const hasSpeakerMarkers = segments.some(s => s.text.startsWith(SPEAKER_CHANGE_PREFIX));

	const paragraphs: DisplayParagraph[] = [];
	let current: DisplaySegment[] = [];

	for (const segment of segments) {
		const isFirst = current.length === 0;

		if (!isFirst) {
			const shouldBreak = hasSpeakerMarkers
				? segment.text.startsWith(SPEAKER_CHANGE_PREFIX)
				: current.length >= MAX_SEGMENTS_PER_PARAGRAPH;

			if (shouldBreak) {
				paragraphs.push({segments: current});
				current = [];
			}
		}

		current.push(segment);
	}

	if (current.length > 0) {
		paragraphs.push({segments: current});
	}

	return paragraphs;
}

// ─── View ────────────────────────────────────────────────────────────

/**
 * Renders a scrolling transcript panel synced to a YouTube player.
 * Entries are grouped into paragraphs of flowing text.
 * The currently active segment is highlighted inline (karaoke-style).
 * No timestamps are shown — the text reads as prose.
 */
export function createTranscriptView(
	parentEl: HTMLElement,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
): TranscriptView {
	const containerEl = parentEl.createDiv({cls: CSS.container});

	if (entries.length === 0) {
		containerEl.createDiv({cls: CSS.empty, text: "No transcript available."});
		return {containerEl, entrySpanMap: [], startSync: noop, stopSync: noop, destroy: noop};
	}

	const displaySegments = splitMultiSpeakerEntries(entries);
	const paragraphs = groupIntoParagraphs(displaySegments);
	const entrySpanMap = renderParagraphs(containerEl, paragraphs, entries, player);

	let syncInterval: number | null = null;
	let activeIndex = -1;

	function updateActiveLineFromTime(currentTime: number): void {
		const newIndex = findActiveEntryIndex(entries, currentTime);
		if (newIndex === activeIndex) return;

		// Remove highlight from all spans of the previous active entry.
		if (activeIndex >= 0 && activeIndex < entrySpanMap.length) {
			for (const span of entrySpanMap[activeIndex] ?? []) {
				span.removeClass(CSS.segmentActive);
			}
		}

		activeIndex = newIndex;

		// Highlight all spans of the new active entry and scroll into view.
		if (activeIndex >= 0 && activeIndex < entrySpanMap.length) {
			const spans = entrySpanMap[activeIndex] ?? [];
			for (const span of spans) {
				span.addClass(CSS.segmentActive);
			}
			const firstSpan = spans[0];
			if (firstSpan) {
				const paragraph = firstSpan.parentElement;
				if (paragraph) {
					scrollToElementInContainer(containerEl, paragraph);
				}
			}
		}
	}

	function startSync(): void {
		if (syncInterval !== null) return;

		syncInterval = window.setInterval(() => {
			// Stop polling if the container has been removed from the DOM
			// (e.g., during a code block re-render).
			if (!containerEl.isConnected) {
				stopSync();
				return;
			}

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

	// Auto-start/stop sync with player state.
	player.onStateChange((state) => {
		if (state === PlayerState.PLAYING) {
			startSync();
		} else if (state === PlayerState.PAUSED || state === PlayerState.ENDED) {
			stopSync();
		}
	});

	return {containerEl, entrySpanMap, startSync, stopSync, destroy};
}

// ─── Rendering ───────────────────────────────────────────────────────

/**
 * Renders paragraphs as flowing prose. Each display segment is a <span>
 * so it can be individually highlighted. Returns a map from original
 * entry index → array of span elements. When a single entry was split
 * into multiple display segments (multi-speaker), all fragments are
 * included so they highlight together during sync.
 */
function renderParagraphs(
	containerEl: HTMLElement,
	paragraphs: DisplayParagraph[],
	allEntries: TranscriptEntry[],
	player: PlayerWrapper,
): HTMLElement[][] {
	const entrySpanMap: HTMLElement[][] = allEntries.map(() => []);

	for (const paragraph of paragraphs) {
		const paragraphEl = containerEl.createEl("p", {cls: CSS.paragraph});

		for (let i = 0; i < paragraph.segments.length; i++) {
			const segment = paragraph.segments[i];
			if (!segment) continue;

			// Collapse internal newlines (YouTube subtitle line wrapping) into spaces.
			// Prepend a space separator for non-first segments so the space lives
			// inside the span — this avoids orphan text nodes that create visual
			// gaps when highlights cross entry boundaries.
			const isFirstSegment = i === 0;
			const displayText = (isFirstSegment ? "" : " ") + segment.text.replace(/\n/g, " ");

			const segmentSpan = paragraphEl.createSpan({
				cls: CSS.segment,
				text: displayText,
			});

			// Click to seek to this segment's timestamp.
			const offset = segment.offset;
			segmentSpan.addEventListener("click", () => {
				void player.seekTo(offset);
			});

			// Map back to original entry index — collect all fragments.
			entrySpanMap[segment.sourceIndex]?.push(segmentSpan);
		}
	}

	return entrySpanMap;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Binary search for the transcript entry active at the given time.
 * Returns the index of the last entry whose offset is <= currentTime.
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
 * Scrolls the container so the target element is vertically centered,
 * without affecting the scroll position of the surrounding note.
 */
function scrollToElementInContainer(container: HTMLElement, target: HTMLElement): void {
	const targetTop = target.offsetTop - container.offsetTop;
	const centeredPosition = targetTop - container.clientHeight / SCROLL_CENTER_DIVISOR + target.clientHeight / SCROLL_CENTER_DIVISOR;
	container.scrollTo({top: centeredPosition, behavior: "smooth"});
}

function noop(): void {
	// intentionally empty
}
