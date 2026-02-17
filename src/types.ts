/**
 * Data stored inside the ```youtube-highlights code block as JSON.
 * Intentionally minimal — only identity fields that never change during use.
 * Highlights and annotations are stored separately in the plugin data folder
 * to avoid code block writes that trigger Obsidian re-renders.
 */
export interface VideoData {
	videoId: string;
	title: string;
	/**
	 * Legacy fields from earlier versions. If present when loading, they are
	 * migrated to the data store and removed from the code block.
	 */
	highlights?: Highlight[];
	annotations?: Annotation[];
	transcript?: "cached" | "none";
}

/**
 * User data stored in the plugin data folder, keyed by videoId.
 * Separated from the code block to avoid re-render on every change.
 */
export interface VideoUserData {
	highlights: Highlight[];
	annotations: Annotation[];
}

/**
 * A highlighted excerpt of the transcript. Supports sub-entry (word-level)
 * selections. Single color; exports as ==...== in markdown.
 *
 * The highlight stores the exact selected text and the entry indices it spans,
 * plus character offsets within the first and last entries for precise restoration.
 */
export interface Highlight {
	id: string;
	/** The exact text the user selected (for display and export). */
	text: string;
	/** Index of the first transcript entry touched by this highlight. */
	startEntryIndex: number;
	/** Character offset within the first entry's text where the highlight starts. */
	startCharOffset: number;
	/** Index of the last transcript entry touched by this highlight. */
	endEntryIndex: number;
	/** Character offset within the last entry's text where the highlight ends. */
	endCharOffset: number;
	/** Start time in seconds (derived from startEntryIndex, cached for export). */
	startTime: number;
	/** End time in seconds (derived from endEntryIndex, cached for export). */
	endTime: number;
}

/** A free-text note attached to a specific timestamp. Independent from highlights. */
export interface Annotation {
	id: string;
	timestamp: number;   // seconds
	text: string;        // user's note
}

/** A single line/segment of the YouTube transcript. */
export interface TranscriptEntry {
	text: string;
	offset: number;      // start time in seconds
	duration: number;    // duration in seconds
}

/** Creates an empty VideoData with sensible defaults. */
export function createEmptyVideoData(videoId: string, title = ""): VideoData {
	return {
		videoId,
		title,
	};
}

/** Creates an empty VideoUserData. */
export function createEmptyUserData(): VideoUserData {
	return {
		highlights: [],
		annotations: [],
	};
}

/** The language identifier used with registerMarkdownCodeBlockProcessor. */
export const CODE_BLOCK_LANGUAGE = "youtube-highlights";
