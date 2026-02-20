import type {TranscriptEntry, TranscriptDisplaySettings, SeparatorRule, ManualBreak, DisplayMode} from "./types";
import {DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS} from "./types";
import type {PlayerWrapper} from "./player";
import {PlayerState} from "./player";
import {secondsToTimestamp} from "./utils/time";

const SYNC_POLL_INTERVAL_MS = 250;
const SCROLL_CENTER_DIVISOR = 2;

/** Default display mode when none is specified. */
const DEFAULT_DISPLAY_MODE: DisplayMode = "paragraphs";

/** CSS class names used by the transcript view. */
const CSS = {
	container: "yt-highlighter-transcript",
	containerBreakMode: "yt-highlighter-transcript--break-mode",
	containerSubtitleMode: "yt-highlighter-transcript--subtitle-mode",
	paragraph: "yt-highlighter-transcript-paragraph",
	segment: "yt-highlighter-transcript-segment",
	segmentActive: "yt-highlighter-transcript-segment--active",
	breakMarker: "yt-highlighter-transcript-segment--break",
	empty: "yt-highlighter-transcript-empty",
	subtitleRow: "yt-highlighter-subtitle-row",
	subtitleTimestamp: "yt-highlighter-subtitle-timestamp",
	subtitleText: "yt-highlighter-subtitle-text",
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
	/** Re-render the transcript with new settings and breaks. Returns the new entrySpanMap. */
	rerender(settings: TranscriptDisplaySettings, manualBreaks: ManualBreak[]): HTMLElement[][];
	/**
	 * When true, clicking a segment inserts/removes a manual break instead of seeking.
	 * The `onBreakToggle` callback is called with the entry index and character offset.
	 */
	breakMode: boolean;
	/** Set the callback for break toggle clicks (called with entry index + char offset). */
	setBreakToggleHandler(handler: (entryIndex: number, charOffset: number) => void): void;
	/** The current display mode ("paragraphs" or "subtitles"). */
	displayMode: DisplayMode;
	/** Switch between display modes. Triggers a full re-render. Returns the new entrySpanMap. */
	setDisplayMode(mode: DisplayMode): HTMLElement[][];
	/** Clean up all resources. */
	destroy(): void;
}

// ─── Separator compilation ───────────────────────────────────────────

/** Escapes special regex characters in a plain string. */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Converts a SeparatorRule's pattern to a regex source string. */
function ruleToRegexSource(rule: SeparatorRule): string | null {
	if (!rule.pattern) return null;
	try {
		const source = rule.isRegex ? rule.pattern : escapeRegExp(rule.pattern);
		// Validate the regex by constructing it.
		new RegExp(source);
		return source;
	} catch {
		return null;
	}
}

/**
 * Compiled separator info used during rendering.
 * Pre-computes combined regex patterns from all separator rules.
 */
interface CompiledSeparators {
	/** Combined lookahead pattern for splitting mid-text separators (all rules). */
	midTextSplitPattern: RegExp | null;
	/** Combined pattern for detecting paragraph breaks (all rules). */
	startsWithPattern: RegExp | null;
	/** Pattern matching hidden separators only, for stripping from display text. */
	hiddenStripPattern: RegExp | null;
}

/**
 * Compiles all separator rules into combined regex patterns.
 * Combines multiple rules with alternation (|).
 */
function compileSeparators(rules: SeparatorRule[]): CompiledSeparators {
	const allSources: string[] = [];
	const hiddenSources: string[] = [];

	for (const rule of rules) {
		const source = ruleToRegexSource(rule);
		if (!source) continue;
		allSources.push(source);
		if (rule.hidden) {
			hiddenSources.push(source);
		}
	}

	const combinedSource = allSources.length > 0
		? allSources.map(s => `(?:${s})`).join("|")
		: null;

	let midTextSplitPattern: RegExp | null = null;
	let startsWithPattern: RegExp | null = null;

	if (combinedSource) {
		try {
			midTextSplitPattern = new RegExp(`\\s+(?=${combinedSource})`);
		} catch { /* ignore */ }
		try {
			startsWithPattern = new RegExp(`^(?:${combinedSource})`);
		} catch { /* ignore */ }
	}

	let hiddenStripPattern: RegExp | null = null;
	if (hiddenSources.length > 0) {
		const hiddenCombined = hiddenSources.map(s => `(?:${s})`).join("|");
		try {
			hiddenStripPattern = new RegExp(`^(?:${hiddenCombined})`);
		} catch { /* ignore */ }
	}

	return {midTextSplitPattern, startsWithPattern, hiddenStripPattern};
}

// ─── Paragraph grouping (display only) ───────────────────────────────

/**
 * A display segment maps to one or more visual spans. When a single transcript
 * entry contains multiple speakers or a manual break, it gets split into separate
 * display segments that share the same offset. The `sourceIndex` tracks which
 * original entry this came from (for sync). `sourceCharStart` and `sourceCharEnd`
 * track the character range within the original entry's text.
 */
interface DisplaySegment {
	text: string;
	offset: number;
	sourceIndex: number;
	/** Start character offset within the source entry's text (inclusive). */
	sourceCharStart: number;
	/** End character offset within the source entry's text (exclusive). */
	sourceCharEnd: number;
}

/**
 * Splits transcript entries that contain multiple separators into
 * separate display segments. Purely for rendering — the underlying
 * transcript data is not modified. Tracks character ranges for each fragment.
 */
function splitMultiSeparatorEntries(
	entries: TranscriptEntry[],
	splitPattern: RegExp | null,
): DisplaySegment[] {
	const segments: DisplaySegment[] = [];

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		if (splitPattern) {
			const parts = entry.text.split(splitPattern);
			let charPos = 0;
			for (const part of parts) {
				// Find where this part starts in the original text.
				const partStart = entry.text.indexOf(part, charPos);
				const partEnd = partStart + part.length;
				if (part.trim()) {
					segments.push({
						text: part, offset: entry.offset, sourceIndex: i,
						sourceCharStart: partStart, sourceCharEnd: partEnd,
					});
				}
				charPos = partEnd;
			}
		} else {
			if (entry.text.trim()) {
				segments.push({
					text: entry.text, offset: entry.offset, sourceIndex: i,
					sourceCharStart: 0, sourceCharEnd: entry.text.length,
				});
			}
		}
	}

	return segments;
}

/**
 * Applies mid-entry manual breaks to display segments. A break with charOffset > 0
 * splits the affected segment into two parts at that character position.
 * Entry-level breaks (charOffset === 0) are handled later in groupIntoParagraphs.
 */
function applyMidEntryBreaks(
	segments: DisplaySegment[],
	manualBreaks: ManualBreak[],
): DisplaySegment[] {
	// Collect mid-entry breaks (charOffset > 0) keyed by entry index.
	const midBreaksByEntry = new Map<number, number[]>();
	for (const brk of manualBreaks) {
		if (brk.charOffset > 0) {
			const existing = midBreaksByEntry.get(brk.entryIndex) ?? [];
			existing.push(brk.charOffset);
			midBreaksByEntry.set(brk.entryIndex, existing);
		}
	}

	if (midBreaksByEntry.size === 0) return segments;

	const result: DisplaySegment[] = [];

	for (const segment of segments) {
		const breakOffsets = midBreaksByEntry.get(segment.sourceIndex);
		if (!breakOffsets) {
			result.push(segment);
			continue;
		}

		// Filter to break offsets that fall within this segment's character range.
		const relevantOffsets = breakOffsets
			.filter(off => off > segment.sourceCharStart && off < segment.sourceCharEnd)
			.sort((a, b) => a - b);

		if (relevantOffsets.length === 0) {
			result.push(segment);
			continue;
		}

		// Split the segment text at each break offset.
		let currentStart = segment.sourceCharStart;
		let currentTextStart = 0;

		for (const breakOffset of relevantOffsets) {
			const localOffset = breakOffset - segment.sourceCharStart;
			const partText = segment.text.slice(currentTextStart, localOffset);
			if (partText.trim()) {
				result.push({
					text: partText,
					offset: segment.offset,
					sourceIndex: segment.sourceIndex,
					sourceCharStart: currentStart,
					sourceCharEnd: breakOffset,
				});
			}
			currentStart = breakOffset;
			currentTextStart = localOffset;
		}

		// Remaining tail.
		const tailText = segment.text.slice(currentTextStart);
		if (tailText.trim()) {
			result.push({
				text: tailText,
				offset: segment.offset,
				sourceIndex: segment.sourceIndex,
				sourceCharStart: currentStart,
				sourceCharEnd: segment.sourceCharEnd,
			});
		}
	}

	return result;
}

/** A paragraph is a group of consecutive display segments rendered as flowing text. */
interface DisplayParagraph {
	segments: DisplaySegment[];
}

/**
 * Groups display segments into paragraphs.
 *
 * Three signals trigger a paragraph break:
 * 1. **Separator match**: any configured separator found at the start of a segment.
 * 2. **Entry-level manual break** (charOffset === 0): break before the entire entry.
 * 3. **Mid-entry manual break** (charOffset > 0): the segment starts at the break's
 *    char offset within its source entry (already split by `applyMidEntryBreaks`).
 *
 * All signals are additive — any one causes a break.
 */
function groupIntoParagraphs(
	segments: DisplaySegment[],
	startsWithPattern: RegExp | null,
	manualBreaks: ManualBreak[],
): DisplayParagraph[] {
	if (segments.length === 0) return [];

	// Build a set of break keys for O(1) lookup.
	// Entry-level breaks: "entryIndex:0". Mid-entry breaks: "entryIndex:charOffset".
	const breakKeys = new Set(
		manualBreaks.map(b => `${b.entryIndex}:${b.charOffset}`),
	);

	const paragraphs: DisplayParagraph[] = [];
	let current: DisplaySegment[] = [];

	for (const segment of segments) {
		const isFirst = current.length === 0;

		if (!isFirst) {
			const separatorBreak = startsWithPattern !== null
				&& startsWithPattern.test(segment.text);
			const manualBreak = breakKeys.has(
				`${segment.sourceIndex}:${segment.sourceCharStart}`,
			);

			if (separatorBreak || manualBreak) {
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
	displaySettings?: TranscriptDisplaySettings,
	initialManualBreaks?: ManualBreak[],
): TranscriptView {
	const containerEl = parentEl.createDiv({cls: CSS.container});
	const settings = displaySettings ?? DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
	const breaks = initialManualBreaks ?? [];

	if (entries.length === 0) {
		containerEl.createDiv({cls: CSS.empty, text: "No transcript available."});
		return {
			containerEl,
			entrySpanMap: [],
			startSync: noop,
			stopSync: noop,
			rerender: () => [],
			breakMode: false,
			setBreakToggleHandler: (_handler: (entryIndex: number, charOffset: number) => void) => { /* noop */ },
			displayMode: DEFAULT_DISPLAY_MODE,
			setDisplayMode: () => [],
			destroy: noop,
		};
	}

	/** Mutable interaction state shared with segment click handlers. */
	const interactionState = {
		breakMode: false,
		breakToggleHandler: null as ((entryIndex: number, charOffset: number) => void) | null,
	};

	/** Tracks the current display mode and last-used paragraph settings/breaks. */
	let currentMode: DisplayMode = DEFAULT_DISPLAY_MODE;
	let lastSettings = settings;
	let lastBreaks = breaks;

	let entrySpanMap = renderForMode(containerEl, currentMode, entries, player, lastSettings, lastBreaks, interactionState);

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
				// In subtitle mode, scroll the row itself; in paragraph mode, scroll the paragraph.
				const scrollTarget = currentMode === "subtitles" ? firstSpan.parentElement : firstSpan.parentElement;
				if (scrollTarget) {
					scrollToElementInContainer(containerEl, scrollTarget);
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

			void player.getPlayerState().then(async (state) => {
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

	function fullRerender(): HTMLElement[][] {
		containerEl.empty();
		activeIndex = -1;
		entrySpanMap = renderForMode(containerEl, currentMode, entries, player, lastSettings, lastBreaks, interactionState);
		return entrySpanMap;
	}

	function rerender(newSettings: TranscriptDisplaySettings, manualBreaks: ManualBreak[]): HTMLElement[][] {
		lastSettings = newSettings;
		lastBreaks = manualBreaks;
		return fullRerender();
	}

	function setDisplayMode(mode: DisplayMode): HTMLElement[][] {
		currentMode = mode;
		// Toggle subtitle-mode CSS class on the container.
		if (mode === "subtitles") {
			containerEl.addClass(CSS.containerSubtitleMode);
		} else {
			containerEl.removeClass(CSS.containerSubtitleMode);
		}
		return fullRerender();
	}

	// Auto-start/stop sync with player state.
	player.onStateChange((state) => {
		if (state === PlayerState.PLAYING) {
			startSync();
		} else if (state === PlayerState.PAUSED || state === PlayerState.ENDED) {
			stopSync();
		}
	});

	return {
		containerEl, entrySpanMap, startSync, stopSync, rerender, destroy,
		get breakMode() { return interactionState.breakMode; },
		set breakMode(value: boolean) { interactionState.breakMode = value; },
		setBreakToggleHandler(handler: (entryIndex: number, charOffset: number) => void) {
			interactionState.breakToggleHandler = handler;
		},
		get displayMode() { return currentMode; },
		setDisplayMode,
	};
}

// ─── Rendering ───────────────────────────────────────────────────────

/**
 * Builds display segments, groups them into paragraphs, and renders them.
 * Returns the entrySpanMap for highlight and sync use.
 */
/** Shared mutable state for segment click behavior. */
interface InteractionState {
	breakMode: boolean;
	breakToggleHandler: ((entryIndex: number, charOffset: number) => void) | null;
}

/**
 * Dispatches rendering to the appropriate mode.
 * - "paragraphs": grouped prose with separator rules, breaks, and highlights.
 * - "subtitles": one row per entry with timestamp + text.
 */
function renderForMode(
	containerEl: HTMLElement,
	mode: DisplayMode,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
	settings: TranscriptDisplaySettings,
	manualBreaks: ManualBreak[],
	interactionState: InteractionState,
): HTMLElement[][] {
	if (mode === "subtitles") {
		return renderSubtitles(containerEl, entries, player);
	}
	return renderWithSettings(containerEl, entries, player, settings, manualBreaks, interactionState);
}

// ─── Subtitle mode ───────────────────────────────────────────────────

/**
 * Renders the transcript as a list of subtitle rows: each entry gets
 * its own row with a timestamp on the left and the text on the right.
 * Clicking the timestamp or text seeks to that point.
 */
function renderSubtitles(
	containerEl: HTMLElement,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
): HTMLElement[][] {
	const entrySpanMap: HTMLElement[][] = entries.map(() => []);

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		if (!entry) continue;

		const rowEl = containerEl.createDiv({cls: CSS.subtitleRow});

		const timestampEl = rowEl.createSpan({
			cls: CSS.subtitleTimestamp,
			text: secondsToTimestamp(entry.offset),
		});

		const textEl = rowEl.createSpan({
			cls: CSS.subtitleText,
			text: entry.text.replace(/\n/g, " "),
		});

		// Click anywhere on the row to seek.
		const offset = entry.offset;
		timestampEl.addEventListener("click", () => { void player.seekTo(offset); });
		textEl.addEventListener("click", () => { void player.seekTo(offset); });

		entrySpanMap[i]?.push(textEl);
	}

	return entrySpanMap;
}

// ─── Paragraph mode ─────────────────────────────────────────────────

function renderWithSettings(
	containerEl: HTMLElement,
	entries: TranscriptEntry[],
	player: PlayerWrapper,
	settings: TranscriptDisplaySettings,
	manualBreaks: ManualBreak[],
	interactionState: InteractionState,
): HTMLElement[][] {
	const compiled = compileSeparators(settings.separators);

	let displaySegments = splitMultiSeparatorEntries(entries, compiled.midTextSplitPattern);
	displaySegments = applyMidEntryBreaks(displaySegments, manualBreaks);
	const paragraphs = groupIntoParagraphs(
		displaySegments, compiled.startsWithPattern, manualBreaks,
	);
	return renderParagraphs(
		containerEl, paragraphs, entries, player, compiled.hiddenStripPattern,
		manualBreaks, interactionState,
	);
}

/**
 * Renders paragraphs as flowing prose. Each display segment is a <span>
 * so it can be individually highlighted. Returns a map from original
 * entry index → array of span elements. When a single entry was split
 * into multiple display segments, all fragments are included so they
 * highlight together during sync.
 *
 * If `hiddenStripPattern` is provided, matching separator text at the
 * start of segments is removed from the displayed text.
 */
function renderParagraphs(
	containerEl: HTMLElement,
	paragraphs: DisplayParagraph[],
	allEntries: TranscriptEntry[],
	player: PlayerWrapper,
	hiddenStripPattern: RegExp | null,
	manualBreaks: ManualBreak[],
	interactionState: InteractionState,
): HTMLElement[][] {
	const entrySpanMap: HTMLElement[][] = allEntries.map(() => []);

	// Build set of break keys for quick marking.
	const breakKeys = new Set(
		manualBreaks.map(b => `${b.entryIndex}:${b.charOffset}`),
	);

	for (const paragraph of paragraphs) {
		const paragraphEl = containerEl.createEl("p", {cls: CSS.paragraph});

		for (let i = 0; i < paragraph.segments.length; i++) {
			const segment = paragraph.segments[i];
			if (!segment) continue;

			// Collapse internal newlines (YouTube subtitle line wrapping) into spaces.
			let rawText = segment.text.replace(/\n/g, " ");

			// Strip hidden separators from the start of the segment text.
			if (hiddenStripPattern) {
				rawText = rawText.replace(hiddenStripPattern, "");
			}

			// Skip segments that became empty after stripping.
			if (!rawText.trim()) continue;

			// Prepend a space separator for non-first segments so the space lives
			// inside the span — this avoids orphan text nodes that create visual
			// gaps when highlights cross entry boundaries.
			const isFirstSegment = i === 0;
			const displayText = (isFirstSegment ? "" : " ") + rawText;

			const segmentSpan = paragraphEl.createSpan({
				cls: CSS.segment,
				text: displayText,
			});

			// Mark segments that have a manual break before them.
			if (breakKeys.has(`${segment.sourceIndex}:${segment.sourceCharStart}`)) {
				segmentSpan.addClass(CSS.breakMarker);
			}

			// Click: seek (default) or toggle break (in break mode).
			const entryIndex = segment.sourceIndex;
			const segSourceCharStart = segment.sourceCharStart;
			const offset = segment.offset;
			segmentSpan.addEventListener("click", (event) => {
				if (interactionState.breakMode && interactionState.breakToggleHandler) {
					const charOffset = resolveClickCharOffset(
						event, segmentSpan, entryIndex, segSourceCharStart, isFirstSegment,
					);
					interactionState.breakToggleHandler(entryIndex, charOffset);
				} else {
					void player.seekTo(offset);
				}
			});

			// Map back to original entry index — collect all fragments.
			entrySpanMap[segment.sourceIndex]?.push(segmentSpan);
		}
	}

	return entrySpanMap;
}

/**
 * Determines the character offset within the source entry where the user
 * clicked. Uses `caretPositionFromPoint` (or `caretRangeFromPoint` as
 * fallback) to find the click position within the span's text, then maps
 * it back to source entry coordinates.
 *
 * Snaps to the nearest word boundary so breaks always occur between words.
 */
function resolveClickCharOffset(
	event: MouseEvent,
	spanEl: HTMLSpanElement,
	_entryIndex: number,
	segSourceCharStart: number,
	isFirstSegment: boolean,
): number {
	const spanText = spanEl.textContent ?? "";

	// Determine the character offset within the span where the click landed.
	let localOffset = 0;

	// Use caretPositionFromPoint (modern) or caretRangeFromPoint (Safari fallback)
	// to determine where in the text the user clicked.
	const caretInfo = getCaretInfoFromPoint(event.clientX, event.clientY);
	if (caretInfo) {
		localOffset = computeCharOffsetInSpan(spanEl, caretInfo.node, caretInfo.offset);
	}

	// Account for the leading space prepended to non-first segments.
	const LEADING_SPACE_LEN = 1;
	const textOffset = isFirstSegment ? localOffset : Math.max(0, localOffset - LEADING_SPACE_LEN);

	// Snap to nearest word boundary (scan forward to next space or end).
	const wordBoundary = snapToWordBoundary(spanText, localOffset, isFirstSegment);

	// Map from span-local offset to source entry offset.
	const sourceOffset = segSourceCharStart + (isFirstSegment ? wordBoundary : Math.max(0, wordBoundary - LEADING_SPACE_LEN));

	// Never return 0 for a mid-entry click when the segment starts at char 0 —
	// that would be an entry-level break, which is handled separately.
	// If the click was near the very start, use the textOffset mapped to source.
	if (sourceOffset === 0 && textOffset > 0) {
		return segSourceCharStart + textOffset;
	}

	return sourceOffset;
}

/**
 * Computes the character offset within a span element where a given node + offset
 * points. Walks text nodes in the span until it finds the target.
 */
function computeCharOffsetInSpan(spanEl: HTMLElement, targetNode: Node, targetOffset: number): number {
	let charCount = 0;
	const walker = document.createTreeWalker(spanEl, NodeFilter.SHOW_TEXT);
	let textNode: Text | null;
	while ((textNode = walker.nextNode() as Text | null)) {
		if (textNode === targetNode) {
			return charCount + targetOffset;
		}
		charCount += textNode.length;
	}
	return charCount;
}

/**
 * Snaps a character offset to the nearest word boundary within the text.
 * Scans forward from the offset to find the next whitespace character.
 */
function snapToWordBoundary(text: string, offset: number, isFirstSegment: boolean): number {
	// Account for leading space in non-first segments.
	const LEADING_SPACE_LEN = 1;
	const textStart = isFirstSegment ? 0 : LEADING_SPACE_LEN;

	if (offset <= textStart) return textStart;
	if (offset >= text.length) return text.length;

	// Scan forward to next space (word boundary).
	let pos = offset;
	while (pos < text.length && text[pos] !== " ") {
		pos++;
	}

	// If we're at a space, skip past it so the break starts at the next word.
	while (pos < text.length && text[pos] === " ") {
		pos++;
	}

	return pos;
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

/**
 * Extended Document interface for `caretPositionFromPoint`, which is
 * available in modern browsers but not yet in all TypeScript DOM typings.
 */
interface CaretPositionDocument {
	caretPositionFromPoint?(x: number, y: number): {offsetNode: Node; offset: number} | null;
	caretRangeFromPoint?(x: number, y: number): Range | null;
}

/**
 * Gets the caret node + offset at a given screen point, using whichever
 * browser API is available. Returns null if neither API is present or
 * the call fails.
 */
function getCaretInfoFromPoint(x: number, y: number): {node: Node; offset: number} | null {
	const doc = document as unknown as CaretPositionDocument;

	if (doc.caretPositionFromPoint) {
		const pos = doc.caretPositionFromPoint(x, y);
		if (pos) return {node: pos.offsetNode, offset: pos.offset};
	} else if (doc.caretRangeFromPoint) {
		const range = doc.caretRangeFromPoint(x, y);
		if (range) return {node: range.startContainer, offset: range.startOffset};
	}

	return null;
}

function noop(): void {
	// intentionally empty
}
