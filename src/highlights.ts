import {type App, Platform} from "obsidian";
import type {Highlight, TranscriptEntry} from "./types";
import type {VideoDataStore} from "./video-data-store";
import {showHighlightEditor} from "./highlight-editor";
import {renderInlineMarkdown} from "./utils/inline-markdown";

/** CSS class applied to highlight <mark> elements. */
const CSS_HIGHLIGHT = "yt-highlighter-highlight";

/** Prefix for generating unique highlight IDs. */
const HIGHLIGHT_ID_PREFIX = "h";

/** HTML tag used for highlight wrappers. Using <span> instead of <mark>
 *  to avoid Obsidian's default mark styling (border-radius, padding). */
const HIGHLIGHT_TAG = "span";

/** Data attribute storing the highlight ID on highlight elements. */
const DATA_HIGHLIGHT_ID = "highlightId";



/** Handle returned by setupHighlighting for external interaction. */
export interface HighlightHandle {
	/**
	 * Apply a highlight to the currently stashed selection range.
	 * Returns true if a highlight was created, false if no valid selection.
	 * Used by the mobile highlight button.
	 */
	highlightStashedSelection(): boolean;
	/** Whether there is a valid stashed selection ready to highlight. */
	hasStashedSelection(): boolean;
	/** Register a callback for when stashed selection availability changes. */
	onSelectionAvailabilityChange(handler: (available: boolean) => void): void;
}

/**
 * Sets up highlight functionality on the transcript view.
 *
 * - Desktop: selecting text wraps it immediately on mouseup (word-level precision).
 * - Mobile: selection is stashed on selectionchange; a toolbar button triggers highlighting.
 * - Clicking/tapping an existing highlight opens an inline editor popover
 *   where the user can edit the display text or delete the highlight.
 * - Highlights are persisted to the VideoDataStore with entry indices and
 *   character offsets so they can be restored on reload.
 *
 * @param containerEl  The transcript scroll container.
 * @param entrySpanMap Map from entry index → array of rendered spans.
 * @param entries      The original transcript entries (for time lookup).
 * @param videoId      The video ID (for data store keying).
 * @param store        The data store for persisting highlights.
 */
export function setupHighlighting(
	containerEl: HTMLElement,
	entrySpanMap: HTMLElement[][],
	entries: TranscriptEntry[],
	videoId: string,
	store: VideoDataStore,
	app: App,
	onChange?: () => void,
): HighlightHandle {
	// Apply existing highlights from the data store on load.
	restoreHighlights(entrySpanMap, entries, videoId, store, containerEl);

	/**
	 * Stashed selection range for mobile. Updated on every selectionchange
	 * while the selection is inside the transcript container. Consumed by
	 * the highlight button.
	 */
	let stashedRange: Range | null = null;
	const selectionChangeHandlers: Array<(available: boolean) => void> = [];

	function setStashedRange(range: Range | null): void {
		const hadSelection = stashedRange !== null;
		stashedRange = range;
		const hasSelection = stashedRange !== null;
		if (hadSelection !== hasSelection) {
			for (const handler of selectionChangeHandlers) {
				handler(hasSelection);
			}
		}
	}

	/**
	 * Guards against opening multiple editor popovers simultaneously.
	 * Set to true while an editor is open; reset when it closes.
	 */
	let editorOpen = false;

	/**
	 * Opens the highlight editor popover for a clicked highlight.
	 * Handles the result: deletion removes the highlight from DOM and store.
	 */
	async function openHighlightEditor(highlightEl: HTMLElement): Promise<void> {
		if (editorOpen) return;

		const highlightId = highlightEl.dataset[DATA_HIGHLIGHT_ID];
		if (!highlightId) return;

		const highlight = store.get(videoId).highlights.find(h => h.id === highlightId);
		if (!highlight) return;

		editorOpen = true;

		const result = await showHighlightEditor(
			app, highlight, entries, videoId, store,
		);

		editorOpen = false;

		if (result === "deleted") {
			removeHighlight(highlightId, containerEl, videoId, store);
			onChange?.();
		} else if (result === "saved") {
			// Replace the visible text in highlight spans with displayText.
			applyDisplayText(highlightId, highlight, containerEl);
			// displayText may have been updated — notify for progress bar / publish sync.
			onChange?.();
		}
	}

	// ── Desktop: immediate highlight on mouseup ──────────────────────

	if (!Platform.isMobile) {
		containerEl.addEventListener("mouseup", (event) => {
			const selection = window.getSelection();

			// Collapsed selection = click. Check if it's on a highlight to edit it.
			if (!selection || selection.isCollapsed) {
				const highlightEl = findParentHighlight(event.target as Node);
				if (highlightEl) {
					void openHighlightEditor(highlightEl);
				}
				return;
			}

			const range = selection.getRangeAt(0);
			if (!containerEl.contains(range.commonAncestorContainer)) return;

			const created = applyHighlightFromRange(range, entrySpanMap, entries, videoId, store);
			if (created) onChange?.();
			selection.removeAllRanges();
		});
	}

	// ── Mobile: stash selection + tap-to-edit ────────────────────────

	if (Platform.isMobile) {
		// Track the current selection so the highlight button can use it.
		// selectionchange fires on the document, not on individual elements.
		const onSelectionChange = (): void => {
			const selection = window.getSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setStashedRange(null);
				return;
			}

			const range = selection.getRangeAt(0);
			if (containerEl.contains(range.commonAncestorContainer)) {
				// Clone the range so it survives the selection being collapsed.
				setStashedRange(range.cloneRange());
			} else {
				setStashedRange(null);
			}
		};

		document.addEventListener("selectionchange", onSelectionChange);

		// Tap-to-edit on mobile: use click (which fires after touch).
		containerEl.addEventListener("click", (event) => {
			const selection = window.getSelection();
			// Only handle taps, not selections.
			if (selection && !selection.isCollapsed) return;

			const highlightEl = findParentHighlight(event.target as Node);
			if (highlightEl) {
				void openHighlightEditor(highlightEl);
			}
		});
	}

	return {
		highlightStashedSelection(): boolean {
			if (!stashedRange) return false;

			const created = applyHighlightFromRange(
				stashedRange, entrySpanMap, entries, videoId, store,
			);

			// Clear the stash and any remaining browser selection.
			setStashedRange(null);
			window.getSelection()?.removeAllRanges();
			if (created) onChange?.();
			return created;
		},

		hasStashedSelection(): boolean {
			return stashedRange !== null;
		},

		onSelectionAvailabilityChange(handler: (available: boolean) => void): void {
			selectionChangeHandlers.push(handler);
		},
	};
}

// ─── Shared highlight creation from a Range ──────────────────────────

/**
 * Creates a highlight from a DOM Range: maps it to entry offsets, wraps
 * the selected text in highlight spans, and persists to the data store.
 * Returns true if a highlight was successfully created.
 */
function applyHighlightFromRange(
	range: Range,
	entrySpanMap: HTMLElement[][],
	entries: TranscriptEntry[],
	videoId: string,
	store: VideoDataStore,
): boolean {
	const mapping = mapRangeToEntryOffsets(range, entrySpanMap);
	if (!mapping) return false;

	const selectedText = range.toString();
	if (!selectedText.trim()) return false;

	const startEntry = entries[mapping.startEntryIndex];
	const endEntry = entries[mapping.endEntryIndex];
	if (!startEntry || !endEntry) return false;

	const highlight: Highlight = {
		id: `${HIGHLIGHT_ID_PREFIX}${Date.now()}`,
		text: selectedText,
		startEntryIndex: mapping.startEntryIndex,
		startCharOffset: mapping.startCharOffset,
		endEntryIndex: mapping.endEntryIndex,
		endCharOffset: mapping.endCharOffset,
		startTime: startEntry.offset,
		endTime: endEntry.offset + endEntry.duration,
	};

	wrapRangeInHighlightSpans(range, highlight.id);

	store.get(videoId).highlights.push(highlight);
	store.requestSave(videoId);

	return true;
}

// ─── DOM range → entry mapping ───────────────────────────────────────

interface EntryOffsetMapping {
	startEntryIndex: number;
	startCharOffset: number;
	endEntryIndex: number;
	endCharOffset: number;
}

/**
 * Maps a DOM Range to transcript entry indices and character offsets.
 *
 * Walks through the entrySpanMap to find which span contains the start
 * and end of the range, then computes the character offset within each
 * span's text content.
 */
function mapRangeToEntryOffsets(
	range: Range,
	entrySpanMap: HTMLElement[][],
): EntryOffsetMapping | null {
	const startInfo = findEntryAndOffset(range.startContainer, range.startOffset, entrySpanMap);
	const endInfo = findEntryAndOffset(range.endContainer, range.endOffset, entrySpanMap);

	if (!startInfo || !endInfo) return null;

	return {
		startEntryIndex: startInfo.entryIndex,
		startCharOffset: startInfo.charOffset,
		endEntryIndex: endInfo.entryIndex,
		endCharOffset: endInfo.charOffset,
	};
}

/**
 * Given a DOM node + offset (from a Range boundary), finds the transcript
 * entry index and the character offset within that entry's span.
 */
function findEntryAndOffset(
	node: Node,
	offset: number,
	entrySpanMap: HTMLElement[][],
): {entryIndex: number; charOffset: number} | null {
	// Walk up from the node to find the parent span that's in our entrySpanMap.
	const span = findContainingSpan(node, entrySpanMap);
	if (!span) return null;

	// Find which entry this span belongs to.
	for (let i = 0; i < entrySpanMap.length; i++) {
		const spans = entrySpanMap[i];
		if (!spans) continue;

		for (const s of spans) {
			if (s === span || s.contains(node)) {
				// Compute the character offset within the span's full text.
				const charOffset = computeCharOffset(s, node, offset);
				return {entryIndex: i, charOffset};
			}
		}
	}

	return null;
}

/**
 * Walks up the DOM tree from `node` to find the entry span that contains it.
 */
function findContainingSpan(node: Node, entrySpanMap: HTMLElement[][]): HTMLElement | null {
	let current: Node | null = node;
	while (current) {
		if (current instanceof HTMLElement) {
			for (const spans of entrySpanMap) {
				if (!spans) continue;
				for (const span of spans) {
					if (span === current || span.contains(current)) {
						return span;
					}
				}
			}
		}
		current = current.parentNode;
	}
	return null;
}

/**
 * Computes the character offset within `rootEl`'s text content where
 * the given `node` + `offset` points to.
 *
 * This handles the case where the span contains nested elements
 * (e.g., from previous <mark> wrapping) by doing a tree walk.
 */
function computeCharOffset(rootEl: HTMLElement, targetNode: Node, targetOffset: number): number {
	let charCount = 0;

	const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
	let textNode: Text | null;
	while ((textNode = walker.nextNode() as Text | null)) {
		if (textNode === targetNode) {
			return charCount + targetOffset;
		}
		charCount += textNode.length;
	}

	// Fallback: if targetNode is the element itself (not a text node),
	// the offset refers to child index.
	if (targetNode === rootEl || rootEl.contains(targetNode)) {
		return charCount;
	}

	return 0;
}

// ─── Wrapping / unwrapping ───────────────────────────────────────────

/**
 * Wraps the contents of a Range in highlight <span> elements tagged with the highlight ID.
 *
 * If the range spans multiple text nodes (across entry boundaries),
 * each contiguous text segment gets its own highlight span.
 */
function wrapRangeInHighlightSpans(range: Range, highlightId: string): void {
	// Collect all text nodes within the range.
	const textNodes = getTextNodesInRange(range);

	for (const textNode of textNodes) {
		// Determine the portion of this text node that falls within the range.
		let startOffset = 0;
		let endOffset = textNode.length;

		if (textNode === range.startContainer) {
			startOffset = range.startOffset;
		}
		if (textNode === range.endContainer) {
			endOffset = range.endOffset;
		}

		if (startOffset >= endOffset) continue;

		// Split the text node if needed and wrap the selected portion.
		const selectedNode = splitAndExtract(textNode, startOffset, endOffset);
		if (selectedNode) {
			const wrapper = document.createElement(HIGHLIGHT_TAG);
			wrapper.addClass(CSS_HIGHLIGHT);
			wrapper.dataset[DATA_HIGHLIGHT_ID] = highlightId;
			selectedNode.parentNode?.insertBefore(wrapper, selectedNode);
			wrapper.appendChild(selectedNode);
		}
	}
}

/**
 * Splits a text node at the given offsets and returns the middle portion.
 * The original node is modified in place (split into up to 3 parts).
 */
function splitAndExtract(textNode: Text, startOffset: number, endOffset: number): Text | null {
	if (startOffset === 0 && endOffset === textNode.length) {
		// The entire text node is selected — no splitting needed.
		return textNode;
	}

	// Split off the end first (so start offset stays valid).
	if (endOffset < textNode.length) {
		textNode.splitText(endOffset);
	}

	// Split off the beginning.
	if (startOffset > 0) {
		return textNode.splitText(startOffset);
	}

	return textNode;
}

/**
 * Collects all text nodes that fall (wholly or partially) within a Range.
 */
function getTextNodesInRange(range: Range): Text[] {
	const textNodes: Text[] = [];
	const ancestor = range.commonAncestorContainer;

	if (ancestor.nodeType === Node.TEXT_NODE) {
		textNodes.push(ancestor as Text);
		return textNodes;
	}

	const walker = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		if (range.intersectsNode(node)) {
			textNodes.push(node);
		}
	}

	return textNodes;
}

// ─── Removing highlights ─────────────────────────────────────────────

/**
 * Removes a highlight by ID: unwraps all <mark> elements with that ID
 * and removes the highlight from the data store.
 */
function removeHighlight(
	highlightId: string,
	containerEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
): void {
	// Unwrap all highlight spans with this highlight ID.
	const highlights = containerEl.querySelectorAll(`.${CSS_HIGHLIGHT}[data-highlight-id="${highlightId}"]`);
	for (const el of Array.from(highlights)) {
		unwrapHighlightSpan(el);
	}

	// Remove from data store.
	const data = store.get(videoId);
	const index = data.highlights.findIndex(h => h.id === highlightId);
	if (index !== -1) {
		data.highlights.splice(index, 1);
		store.requestSave(videoId);
	}
}

/**
 * Unwraps a highlight span: replaces it with its text content,
 * merging adjacent text nodes.
 */
function unwrapHighlightSpan(el: Element): void {
	const parent = el.parentNode;
	if (!parent) return;

	while (el.firstChild) {
		parent.insertBefore(el.firstChild, el);
	}
	parent.removeChild(el);

	// Normalize to merge adjacent text nodes.
	parent.normalize();
}

/**
 * Finds the nearest ancestor highlight span with our highlight class.
 */
function findParentHighlight(node: Node): HTMLElement | null {
	let current: Node | null = node;
	while (current) {
		if (current instanceof HTMLElement && current.hasClass(CSS_HIGHLIGHT)) {
			return current;
		}
		current = current.parentNode;
	}
	return null;
}

// ─── Display text replacement ────────────────────────────────────────

/**
 * Replaces the visible text inside highlight spans with the user's
 * `displayText` array (one string per entry in the highlight range).
 *
 * Groups the highlight wrapper spans by their parent transcript segment,
 * mapping each group to the corresponding `displayText` element. The
 * first span in each group gets the rendered text; additional spans in
 * the same group are emptied.
 *
 * If the highlight has no custom displayText, this is a no-op.
 */
function applyDisplayText(
	highlightId: string,
	highlight: Highlight,
	containerEl: HTMLElement,
): void {
	if (!highlight.displayText || highlight.displayText.length === 0) return;

	const selector = `.${CSS_HIGHLIGHT}[data-highlight-id="${highlightId}"]`;
	const allSpans = Array.from(
		containerEl.querySelectorAll(selector),
	) as HTMLElement[];
	if (allSpans.length === 0) return;

	// Group highlight spans by parent transcript segment. Spans in DOM
	// order that share the same parent segment belong to the same entry.
	// When the parent changes, we advance to the next displayText entry.
	const groups = groupSpansBySegment(allSpans);

	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const text = highlight.displayText[i];

		if (text !== undefined) {
			// First span in the group gets the rendered markdown text.
			// Prepend a space for non-first groups to match the leading
			// space that transcript-view.ts adds to non-first segments.
			const isFirstGroup = i === 0;
			const spacedText = isFirstGroup ? text : ` ${text}`;
			group[0]!.textContent = "";
			renderInlineMarkdown(group[0]!, spacedText);
		}

		// Additional spans in the group are emptied.
		for (let j = 1; j < group.length; j++) {
			group[j]!.textContent = "";
		}
	}
}

/** CSS class on transcript segment spans (must match transcript-view.ts). */
const CSS_SEGMENT = "yt-highlighter-transcript-segment";

/**
 * Groups highlight spans by their nearest ancestor transcript segment.
 * Consecutive spans sharing the same parent segment are grouped together.
 * Returns an array of groups in DOM order.
 */
function groupSpansBySegment(spans: HTMLElement[]): HTMLElement[][] {
	const groups: HTMLElement[][] = [];
	let currentParent: Element | null = null;
	let currentGroup: HTMLElement[] = [];

	for (const span of spans) {
		const parent = findAncestorSegment(span);
		if (parent !== currentParent) {
			if (currentGroup.length > 0) {
				groups.push(currentGroup);
			}
			currentGroup = [span];
			currentParent = parent;
		} else {
			currentGroup.push(span);
		}
	}

	if (currentGroup.length > 0) {
		groups.push(currentGroup);
	}

	return groups;
}

/**
 * Walks up the DOM from a highlight span to find the nearest ancestor
 * transcript segment span.
 */
function findAncestorSegment(el: HTMLElement): Element | null {
	let current: Element | null = el.parentElement;
	while (current) {
		if (current.classList.contains(CSS_SEGMENT)) {
			return current;
		}
		current = current.parentElement;
	}
	return null;
}

// ─── Restore on load ─────────────────────────────────────────────────

/**
 * Restores highlights from the data store by finding the text within
 * each entry span and wrapping the matching character range in <mark>.
 * Also inserts edited-highlight markers for highlights with custom displayText.
 */
function restoreHighlights(
	entrySpanMap: HTMLElement[][],
	entries: TranscriptEntry[],
	videoId: string,
	store: VideoDataStore,
	containerEl: HTMLElement,
): void {
	for (const highlight of store.get(videoId).highlights) {
		restoreHighlight(highlight, entrySpanMap, entries, containerEl);
	}
}

/**
 * Restores a single highlight by creating a DOM Range from the stored
 * entry indices and character offsets, then wrapping it in <mark> elements.
 *
 * When an entry is split into multiple spans (via separator or manual break
 * splitting), the character offset is resolved by walking through all spans
 * sequentially, treating them as a contiguous text range.
 */
function restoreHighlight(
	highlight: Highlight,
	entrySpanMap: HTMLElement[][],
	entries: TranscriptEntry[],
	containerEl: HTMLElement,
): void {
	const startSpans = entrySpanMap[highlight.startEntryIndex];
	const endSpans = entrySpanMap[highlight.endEntryIndex];
	if (!startSpans?.length || !endSpans?.length) return;

	// Find the text node + offset for the start boundary by walking all spans
	// for the start entry until we accumulate enough characters.
	const startPoint = findTextNodeAtOffsetAcrossSpans(startSpans, highlight.startCharOffset);
	const endPoint = findTextNodeAtOffsetAcrossSpans(endSpans, highlight.endCharOffset);
	if (!startPoint || !endPoint) return;

	try {
		const range = document.createRange();
		range.setStart(startPoint.node, startPoint.offset);
		range.setEnd(endPoint.node, endPoint.offset);

		if (!range.collapsed) {
			wrapRangeInHighlightSpans(range, highlight.id);
			// If the highlight has custom displayText, replace the span text.
			applyDisplayText(highlight.id, highlight, containerEl);
		}
	} catch {
		// Range may be invalid if the DOM doesn't match stored offsets.
		// Silently skip — the highlight won't be visible but data is preserved.
	}
}

/**
 * Finds a text node and local offset within a sequence of spans, treating
 * them as a contiguous text. Walks through all spans in order, accumulating
 * character counts until the target offset is reached.
 *
 * This handles the case where an entry is split into multiple spans
 * (e.g., by separator splitting or mid-entry manual breaks).
 */
function findTextNodeAtOffsetAcrossSpans(
	spans: HTMLElement[],
	charOffset: number,
): {node: Text; offset: number} | null {
	let remaining = charOffset;

	for (const span of spans) {
		const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
		let textNode: Text | null;
		while ((textNode = walker.nextNode() as Text | null)) {
			if (remaining <= textNode.length) {
				return {node: textNode, offset: remaining};
			}
			remaining -= textNode.length;
		}
	}

	// If offset is beyond the end, clamp to the last position.
	const lastSpan = spans[spans.length - 1];
	if (lastSpan) {
		const lastText = getLastTextNode(lastSpan);
		if (lastText) {
			return {node: lastText, offset: lastText.length};
		}
	}

	return null;
}

/** Returns the last text node descendant of an element. */
function getLastTextNode(el: HTMLElement): Text | null {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		last = node;
	}
	return last;
}


