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
 * A single separator rule for paragraph grouping.
 * Each rule defines a pattern that triggers a paragraph break when found
 * at the start of a transcript segment.
 */
export interface SeparatorRule {
	/** The separator string or regex pattern. */
	pattern: string;
	/** If true, `pattern` is treated as a regex. */
	isRegex: boolean;
	/** If true, matched text is stripped from the rendered transcript. */
	hidden: boolean;
}

/**
 * Per-video settings that control how the transcript is grouped into paragraphs.
 * Stored alongside highlights/annotations in the data store.
 */
export interface TranscriptDisplaySettings {
	/** List of separator rules. Any match triggers a paragraph break. */
	separators: SeparatorRule[];
}

/** The default separator matching YouTube's speaker change marker. */
const DEFAULT_SEPARATOR_RULE: SeparatorRule = {
	pattern: "- ",
	isRegex: false,
	hidden: false,
};

/** Sensible defaults matching the original hard-coded behavior ("- " prefix). */
export const DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS: TranscriptDisplaySettings = {
	separators: [DEFAULT_SEPARATOR_RULE],
};

/** Creates a new empty separator rule. */
export function createEmptySeparatorRule(): SeparatorRule {
	return {pattern: "", isRegex: false, hidden: false};
}

/**
 * Migrates old single-separator settings format to the new array format.
 * Returns the input unchanged if already in the new format.
 */
export function migrateTranscriptSettings(
	raw: Record<string, unknown> | undefined,
): TranscriptDisplaySettings | undefined {
	if (!raw) return undefined;

	// Current format: has `separators` array.
	if (Array.isArray(raw["separators"])) {
		return {separators: raw["separators"] as SeparatorRule[]};
	}

	// Oldest format: single `separator` string + `isRegex` boolean.
	if (typeof raw["separator"] === "string") {
		const oldSeparator = String(raw["separator"]);
		const oldIsRegex = raw["isRegex"] === true;

		const separators: SeparatorRule[] = oldSeparator
			? [{pattern: oldSeparator, isRegex: oldIsRegex, hidden: false}]
			: [];

		return {separators};
	}

	return undefined;
}

/**
 * A manually placed paragraph break at a specific position in the transcript.
 * Can break between entries (charOffset === 0) or mid-entry at a word boundary.
 */
export interface ManualBreak {
	/** Transcript entry index where the break occurs. */
	entryIndex: number;
	/**
	 * Character offset within the entry's text. 0 means "before the entire entry"
	 * (equivalent to legacy entry-level breaks). A positive value splits the entry
	 * at that character position — text before the offset stays in the preceding
	 * paragraph, text from the offset onward starts a new paragraph.
	 */
	charOffset: number;
}

/**
 * User data stored in the plugin data folder, keyed by videoId.
 * Separated from the code block to avoid re-render on every change.
 */
export interface VideoUserData {
	highlights: Highlight[];
	annotations: Annotation[];
	/** Per-video transcript display settings. Optional for backward compat. */
	transcriptSettings?: TranscriptDisplaySettings;
	/**
	 * Manually placed paragraph breaks. Sorted by (entryIndex, charOffset).
	 * Can be either the new ManualBreak[] format or the legacy number[] format.
	 */
	manualBreaks?: ManualBreak[] | number[];
	/**
	 * Last known playback position in seconds. Persisted so the video
	 * resumes where the user left off. When the video has been watched
	 * to completion (ENDED state), this is reset to 0 on next load.
	 */
	playbackPosition?: number;
}

/**
 * Normalizes `manualBreaks` from either the legacy number[] format or the
 * current ManualBreak[] format into ManualBreak[]. Returns a new sorted array.
 */
export function normalizeManualBreaks(raw: ManualBreak[] | number[] | undefined): ManualBreak[] {
	if (!raw || raw.length === 0) return [];

	// Legacy format: plain array of entry indices.
	if (typeof raw[0] === "number") {
		return (raw as number[]).map(idx => ({entryIndex: idx, charOffset: 0}));
	}

	// Current format.
	return [...(raw as ManualBreak[])];
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

/**
 * Top-level structure persisted via `plugin.saveData()` into `data.json`.
 * Combines plugin-wide settings and all per-video user data in a single
 * object so that Obsidian Sync covers everything.
 */
export interface PluginData {
	/** Plugin-wide settings (transcript language, etc.). */
	settings: PluginSettings;
	/** Per-video user data keyed by videoId. */
	videoData: Record<string, VideoUserData>;
}

/** Plugin-wide settings stored inside PluginData. */
export interface PluginSettings {
	/** Preferred language code for auto-fetched transcripts (e.g. "en", "es"). */
	transcriptLanguage: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	transcriptLanguage: "en",
};

export function createEmptyPluginData(): PluginData {
	return {
		settings: {...DEFAULT_SETTINGS},
		videoData: {},
	};
}

/** The language identifier used with registerMarkdownCodeBlockProcessor. */
export const CODE_BLOCK_LANGUAGE = "youtube-highlights";
