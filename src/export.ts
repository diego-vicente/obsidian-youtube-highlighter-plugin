import {type Editor, type MarkdownView, Notice} from "obsidian";
import type YouTubeHighlighterPlugin from "./main";
import type {VideoData, Highlight, Annotation, VideoUserData, TranscriptEntry} from "./types";
import {CODE_BLOCK_LANGUAGE, normalizeManualBreaks} from "./types";
import {secondsToTimestamp} from "./utils/time";

const YOUTUBE_VIDEO_URL_BASE = "https://www.youtube.com/watch?v=";

/** Command ID (must not include plugin ID per Obsidian rules). */
const COMMAND_ID = "convert-to-markdown";
const COMMAND_NAME = "Convert to markdown";

/**
 * A single exportable item (highlight or annotation) positioned by timestamp.
 * Used to merge and sort highlights and annotations chronologically.
 */
interface ExportItem {
	timestamp: number;
	markdown: string;
}

/**
 * Registers the "Convert to markdown" command on the plugin.
 * Uses editorCheckCallback so it only activates when the active editor
 * contains a `youtube-highlights` code block.
 */
export function registerExportCommand(plugin: YouTubeHighlighterPlugin): void {
	plugin.addCommand({
		id: COMMAND_ID,
		name: COMMAND_NAME,
		editorCheckCallback: (checking: boolean, editor: Editor, view: MarkdownView) => {
			const codeBlock = findCodeBlock(editor);
			if (!codeBlock) return false;
			if (checking) return true;

			const videoData = parseVideoDataFromBlock(codeBlock.content);
			if (!videoData) {
				new Notice("Could not parse video data from the code block.");
				return true;
			}

			// Load user data (highlights/annotations) and cached transcript
			// from the data store, then perform the conversion.
			void plugin.dataStore.load(videoData.videoId).then(async (userData) => {
				const entries = await loadCachedTranscript(videoData.videoId, plugin);
				const breaks = normalizeManualBreaks(userData.manualBreaks);
				const breakTimestamps = resolveBreakTimestamps(breaks, entries ?? []);
				const markdown = convertToMarkdown(videoData, userData, breakTimestamps);
				replaceCodeBlock(editor, codeBlock, markdown);
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- "markdown" is a proper noun here
				new Notice("Converted to markdown.");
			});

			return true;
		},
	});
}

// ─── Code block detection ────────────────────────────────────────────

/** Represents the location of a code block in the editor. */
interface CodeBlockLocation {
	/** The JSON content inside the fences (excluding the ``` lines). */
	content: string;
	/** Line number of the opening ``` fence (0-indexed). */
	startLine: number;
	/** Line number of the closing ``` fence (0-indexed). */
	endLine: number;
}

/** The opening fence pattern for our code block. */
const CODE_FENCE_OPEN = "```" + CODE_BLOCK_LANGUAGE;
const CODE_FENCE_CLOSE = "```";

/**
 * Finds the `youtube-highlights` code block nearest to the cursor.
 * If the cursor is inside a code block, returns that one. Otherwise,
 * returns the first code block in the document.
 * Returns null if none exists.
 */
function findCodeBlock(editor: Editor): CodeBlockLocation | null {
	const blocks = findAllCodeBlocks(editor);
	if (blocks.length === 0) return null;

	// If there's only one, return it.
	if (blocks.length === 1) return blocks[0] ?? null;

	// If the cursor is inside a code block, return that one.
	const cursorLine = editor.getCursor().line;
	for (const block of blocks) {
		if (cursorLine >= block.startLine && cursorLine <= block.endLine) {
			return block;
		}
	}

	// Default to the first block.
	return blocks[0] ?? null;
}

/**
 * Finds all `youtube-highlights` code blocks in the editor.
 */
function findAllCodeBlocks(editor: Editor): CodeBlockLocation[] {
	const lineCount = editor.lineCount();
	const blocks: CodeBlockLocation[] = [];
	let startLine = -1;

	for (let i = 0; i < lineCount; i++) {
		const line = editor.getLine(i).trim();

		if (startLine === -1) {
			if (line === CODE_FENCE_OPEN) {
				startLine = i;
			}
		} else {
			if (line === CODE_FENCE_CLOSE) {
				const contentLines: string[] = [];
				for (let j = startLine + 1; j < i; j++) {
					contentLines.push(editor.getLine(j));
				}
				blocks.push({
					content: contentLines.join("\n"),
					startLine,
					endLine: i,
				});
				startLine = -1;
			}
		}
	}

	return blocks;
}

/**
 * Parses VideoData from the raw JSON content of a code block.
 */
function parseVideoDataFromBlock(content: string): VideoData | null {
	const sanitized = sanitizeSmartQuotes(content);
	try {
		const parsed = JSON.parse(sanitized) as VideoData;
		if (typeof parsed.videoId !== "string") return null;
		return parsed;
	} catch {
		return parseVideoDataFallback(sanitized);
	}
}

/** Replace smart/curly quotes with their ASCII equivalents. */
function sanitizeSmartQuotes(raw: string): string {
	return raw
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/[\u2018\u2019]/g, "'");
}

/**
 * Fallback parser for when JSON.parse fails (e.g. unescaped quotes in
 * the title value).  Extracts videoId and title via regex.
 */
function parseVideoDataFallback(source: string): VideoData | null {
	const videoIdMatch = source.match(/"videoId"\s*:\s*"([^"]+)"/);
	const videoId = videoIdMatch?.[1];
	if (!videoId) return null;

	const titleMatch = source.match(/"title"\s*:\s*"([\s\S]+)"\s*\}$/);
	const title = titleMatch?.[1] ?? "";

	return { videoId, title };
}

// ─── Markdown conversion ─────────────────────────────────────────────

/**
 * Converts video metadata + user data into portable Obsidian markdown.
 *
 * Format:
 * ```
 * ## [Video Title](https://www.youtube.com/watch?v=ID)
 *
 * > [MM:SS](url&t=S) ==highlighted text==
 * > [MM:SS](url&t=S) annotation text
 * ```
 *
 * Highlights and annotations are merged and sorted by timestamp.
 * If `breakTimestamps` is provided, a blank line is inserted between
 * consecutive items whenever a manual break falls between them.
 */
function convertToMarkdown(
	videoData: VideoData,
	userData: VideoUserData,
	breakTimestamps: number[] = [],
): string {
	const videoUrl = `${YOUTUBE_VIDEO_URL_BASE}${videoData.videoId}`;
	const lines: string[] = [];

	// Title heading with link.
	const title = videoData.title || videoData.videoId;
	lines.push(`## [${title}](${videoUrl})`);
	lines.push("");

	// Merge highlights and annotations into a single sorted list.
	const items: ExportItem[] = [];

	for (const highlight of userData.highlights) {
		items.push(highlightToExportItem(highlight, videoUrl));
	}

	for (const annotation of userData.annotations) {
		items.push(annotationToExportItem(annotation, videoUrl));
	}

	// Sort by timestamp; if equal, highlights before annotations (arbitrary but consistent).
	items.sort((a, b) => a.timestamp - b.timestamp);

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (!item) continue;

		// Insert a blank line if a manual break falls between this item and the previous one.
		if (i > 0) {
			const prevItem = items[i - 1];
			if (prevItem && hasBreakBetween(prevItem.timestamp, item.timestamp, breakTimestamps)) {
				lines.push("");
			}
		}

		lines.push(item.markdown);
	}

	// Ensure trailing newline.
	if (items.length === 0) {
		// No highlights or annotations — just the heading.
		lines.push("*No highlights or annotations.*");
	}

	return lines.join("\n");
}

/**
 * Returns true if any break timestamp falls strictly between `startTime` and `endTime`.
 * Both arrays are assumed sorted in ascending order.
 */
function hasBreakBetween(startTime: number, endTime: number, breakTimestamps: number[]): boolean {
	for (const bt of breakTimestamps) {
		if (bt > startTime && bt <= endTime) return true;
		if (bt > endTime) break;
	}
	return false;
}

/**
 * Creates a timestamped YouTube link: `[MM:SS](url&t=S)`
 */
function timestampLink(timestamp: number, videoUrl: string): string {
	const display = secondsToTimestamp(timestamp);
	const totalSeconds = Math.floor(timestamp);
	return `[${display}](${videoUrl}&t=${totalSeconds})`;
}

function highlightToExportItem(highlight: Highlight, videoUrl: string): ExportItem {
	const link = timestampLink(highlight.startTime, videoUrl);
	return {
		timestamp: highlight.startTime,
		markdown: `> ${link} ==${highlight.text}==`,
	};
}

function annotationToExportItem(annotation: Annotation, videoUrl: string): ExportItem {
	const link = timestampLink(annotation.timestamp, videoUrl);
	return {
		timestamp: annotation.timestamp,
		markdown: `> ${link} ${annotation.text}`,
	};
}

// ─── Editor manipulation ─────────────────────────────────────────────

/**
 * Replaces the code block in the editor with the generated markdown.
 */
function replaceCodeBlock(
	editor: Editor,
	codeBlock: CodeBlockLocation,
	markdown: string,
): void {
	const from = {line: codeBlock.startLine, ch: 0};
	const lastLine = editor.getLine(codeBlock.endLine);
	const to = {line: codeBlock.endLine, ch: lastLine.length};
	editor.replaceRange(markdown, from, to);
}

// ─── Transcript cache helpers ────────────────────────────────────────

const TRANSCRIPT_CACHE_DIR = "transcripts";

/**
 * Loads the cached transcript entries for a video, if available.
 */
async function loadCachedTranscript(
	videoId: string,
	plugin: YouTubeHighlighterPlugin,
): Promise<TranscriptEntry[] | null> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) return null;

	const adapter = plugin.app.vault.adapter;
	const filePath = `${pluginDir}/${TRANSCRIPT_CACHE_DIR}/${videoId}.json`;

	if (!(await adapter.exists(filePath))) {
		return null;
	}

	try {
		const raw = await adapter.read(filePath);
		return JSON.parse(raw) as TranscriptEntry[];
	} catch {
		return null;
	}
}

/**
 * Converts manual breaks to their corresponding transcript timestamps.
 * Returns a sorted array of timestamps. Mid-entry breaks map to the
 * same entry's offset (the break is visual, not temporal).
 */
function resolveBreakTimestamps(
	manualBreaks: import("./types").ManualBreak[],
	entries: TranscriptEntry[],
): number[] {
	if (entries.length === 0 || manualBreaks.length === 0) return [];

	const timestamps: number[] = [];
	for (const brk of manualBreaks) {
		if (brk.entryIndex >= 0 && brk.entryIndex < entries.length) {
			const entry = entries[brk.entryIndex];
			if (entry) {
				timestamps.push(entry.offset);
			}
		}
	}

	return timestamps;
}
