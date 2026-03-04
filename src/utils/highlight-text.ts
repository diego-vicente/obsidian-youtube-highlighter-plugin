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
 * at entry boundaries. This requires the transcript entries to
 * reconstruct the per-entry portions using the stored offsets.
 *
 * Returns an array of length `endEntryIndex - startEntryIndex + 1`,
 * where each element is the original text that fell within that entry.
 */
export function getOriginalTextPerEntry(
	highlight: Highlight,
	entries: import("../types").TranscriptEntry[],
): string[] {
	const entryCount = highlight.endEntryIndex - highlight.startEntryIndex + 1;
	const perEntry: string[] = [];

	for (let i = 0; i < entryCount; i++) {
		const entryIndex = highlight.startEntryIndex + i;
		const entry = entries[entryIndex];
		if (!entry) {
			perEntry.push("");
			continue;
		}

		const entryText = entry.text;
		let start = 0;
		let end = entryText.length;

		// First entry: starts at startCharOffset.
		if (i === 0) {
			start = highlight.startCharOffset;
		}
		// Last entry: ends at endCharOffset.
		if (i === entryCount - 1) {
			end = highlight.endCharOffset;
		}

		perEntry.push(entryText.slice(start, end));
	}

	return perEntry;
}
