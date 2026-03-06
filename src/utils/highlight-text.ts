import type {Highlight} from "../types";

/**
 * Returns the full display text as a single joined string.
 * If the user has edited the highlight text (non-empty `displayText` array),
 * the entries are joined with a space. Otherwise falls back to the original
 * verbatim selection.
 */
export function getHighlightDisplayText(highlight: Highlight): string {
	if (highlight.displayText && highlight.displayText.length > 0) {
		return highlight.displayText.join(" ");
	}
	return highlight.text;
}

/**
 * Returns true if the highlight has a user-edited display text array.
 */
export function hasCustomDisplayText(highlight: Highlight): boolean {
	return highlight.displayText !== undefined && highlight.displayText.length > 0;
}

/**
 * Returns the original text per entry by splitting `highlight.text`
 * at entry boundaries.
 *
 * ### Why we can't just slice `entry.text` with the stored offsets
 *
 * The stored character offsets (`startCharOffset`, `endCharOffset`) are
 * DOM-relative — in paragraph mode the renderer prepends a synthetic
 * leading space to every non-first segment's span (see
 * `transcript-view.ts` `renderParagraphs`).  Because `entry.text` does
 * not contain that space, naively slicing the raw text with DOM offsets
 * shifts the window and drops (or gains) a character.
 *
 * Instead we use `highlight.text` (captured from `range.toString()` and
 * therefore consistent with the DOM offsets) as the single source of
 * truth and split it into per-entry chunks.
 *
 * Returns an array of length `endEntryIndex - startEntryIndex + 1`,
 * where each element is the original text that fell within that entry.
 */
export function getOriginalTextPerEntry(
	highlight: Highlight,
	entries: import("../types").TranscriptEntry[],
): string[] {
	const entryCount = highlight.endEntryIndex - highlight.startEntryIndex + 1;

	// ── Single-entry: the full stored text belongs to one entry ─────
	if (entryCount === 1) {
		return [highlight.text];
	}

	// ── Multi-entry split ───────────────────────────────────────────
	//
	// `highlight.text` is the concatenation of each entry's DOM span
	// text for the selected portion.  Non-first segments within a
	// paragraph carry a synthetic leading space, so boundaries between
	// entries may (or may not) include an extra space character.
	//
	// Strategy:
	//  • Middle entries (neither first nor last) contributed their full
	//    raw text plus an optional leading space.  We detect the space
	//    by probing `highlight.text` at the expected cursor position.
	//  • The last entry contributed `endCharOffset` DOM characters.
	//  • The first entry gets whatever characters remain.
	//
	// We process entries from right to left so that each step's cursor
	// position is known without needing the first entry's length.

	// Accumulate per-entry chunks (filled right to left, indexed 0..N-1).
	const chunks = new Array<string>(entryCount).fill("");

	// Start the reverse cursor at the end of `highlight.text`.
	let rEnd = highlight.text.length;

	// Last entry: `endCharOffset` DOM characters from its span.
	const lastIdx = entryCount - 1;
	const lastChunkLen = highlight.endCharOffset;
	const lastStart = rEnd - lastChunkLen;
	chunks[lastIdx] = highlight.text.slice(lastStart, rEnd);
	rEnd = lastStart;

	// Middle entries (right to left).
	for (let i = lastIdx - 1; i >= 1; i--) {
		const entryIndex = highlight.startEntryIndex + i;
		const entry = entries[entryIndex];
		if (!entry) continue;

		const rawLen = entry.text.length;

		// Probe one position before the raw text to detect the
		// synthetic leading space the renderer may have added.
		const probePos = rEnd - rawLen - 1;
		const hasLeadingSpace =
			probePos >= 0 &&
			highlight.text[probePos] === " " &&
			rawLen > 0 &&
			entry.text[0] !== " ";
		const chunkLen = rawLen + (hasLeadingSpace ? 1 : 0);

		const chunkStart = rEnd - chunkLen;
		chunks[i] = highlight.text.slice(chunkStart, rEnd);
		rEnd = chunkStart;
	}

	// First entry: everything that remains at the front.
	chunks[0] = highlight.text.slice(0, rEnd);

	// Strip the inter-segment leading space artefact from non-first
	// entries (it comes from the renderer, not the transcript text).
	return chunks.map((t, i) => (i === 0 ? t : t.replace(/^ /, "")));
}
