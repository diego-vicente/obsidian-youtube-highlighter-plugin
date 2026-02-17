/** Data stored inside the ```youtube-highlights code block as JSON. */
export interface VideoData {
	videoId: string;
	title: string;
	highlights: Highlight[];
	annotations: Annotation[];
	/** "cached" means transcript is stored in the plugin data folder; "none" means not yet fetched. */
	transcript: "cached" | "none";
}

/** A highlighted excerpt of the transcript. Single color; exports as ==...== in markdown. */
export interface Highlight {
	id: string;
	startTime: number;   // seconds
	endTime: number;     // seconds
	text: string;        // the highlighted transcript text
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
		highlights: [],
		annotations: [],
		transcript: "none",
	};
}

/** The language identifier used with registerMarkdownCodeBlockProcessor. */
export const CODE_BLOCK_LANGUAGE = "youtube-highlights";
