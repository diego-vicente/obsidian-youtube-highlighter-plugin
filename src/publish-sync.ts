/**
 * Automatic publish data sync.
 *
 * Keeps the `publish` key inside `youtube-highlights` code blocks up to
 * date with the latest transcript, highlights, and annotations. The write
 * only happens when the note is **no longer visible** in any editor leaf,
 * preventing the re-render that would destroy the live player widget.
 *
 * On plugin unload (Obsidian close / plugin disable), any remaining dirty
 * notes are flushed synchronously via `vault.process()`.
 */

import type {TFile, WorkspaceLeaf} from "obsidian";
import type YouTubeHighlighterPlugin from "./main";
import {CODE_BLOCK_LANGUAGE} from "./types";

// ─── Constants ───────────────────────────────────────────────────────

const TRANSCRIPT_CACHE_DIR = "transcripts";

/** Opening fence for our code block. */
const CODE_FENCE_OPEN = "```" + CODE_BLOCK_LANGUAGE;
const CODE_FENCE_CLOSE = "```";

// ─── Dirty tracking ─────────────────────────────────────────────────

/**
 * Tracks which files contain video code blocks that need their `publish`
 * data refreshed. Keyed by file path → set of videoIds in that file.
 */
const dirtyFiles = new Map<string, Set<string>>();

/**
 * Marks a video note as needing its `publish` data refreshed.
 * Called by the code block processor whenever the transcript is loaded
 * or user data (highlights, annotations, settings, breaks) changes.
 */
export function markPublishDirty(filePath: string, videoId: string): void {
	let ids = dirtyFiles.get(filePath);
	if (!ids) {
		ids = new Set();
		dirtyFiles.set(filePath, ids);
	}
	ids.add(videoId);
}

// ─── Lifecycle ───────────────────────────────────────────────────────

/**
 * Registers the auto-sync lifecycle hooks on the plugin.
 * - On `layout-change`: checks if any dirty files are no longer visible
 *   and writes their enriched data.
 * - On plugin unload: flushes all remaining dirty files.
 */
export function registerPublishSync(plugin: YouTubeHighlighterPlugin): void {
	// Fire on layout-change (covers leaf close, tab switch, pane rearrangement).
	plugin.registerEvent(
		plugin.app.workspace.on("layout-change", () => {
			void syncClosedDirtyFiles(plugin);
		}),
	);
}

/**
 * Flushes publish data for ALL dirty files, regardless of whether they
 * are open. Called on plugin unload to ensure nothing is lost.
 */
export async function flushAllPublishData(plugin: YouTubeHighlighterPlugin): Promise<void> {
	const paths = Array.from(dirtyFiles.keys());
	for (const filePath of paths) {
		await enrichFile(filePath, plugin);
	}
}

// ─── Sync logic ──────────────────────────────────────────────────────

/**
 * Checks all dirty files and enriches any that are no longer visible
 * in any workspace leaf.
 */
async function syncClosedDirtyFiles(plugin: YouTubeHighlighterPlugin): Promise<void> {
	const visiblePaths = getVisibleFilePaths(plugin);

	for (const filePath of Array.from(dirtyFiles.keys())) {
		if (!visiblePaths.has(filePath)) {
			await enrichFile(filePath, plugin);
		}
	}
}

/**
 * Returns the set of file paths currently visible in any workspace leaf.
 */
function getVisibleFilePaths(plugin: YouTubeHighlighterPlugin): Set<string> {
	const paths = new Set<string>();
	plugin.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
		const file = (leaf.view as any)?.file as TFile | undefined;
		if (file?.path) {
			paths.add(file.path);
		}
	});
	return paths;
}

// ─── File enrichment ─────────────────────────────────────────────────

/**
 * Reads the file, finds all `youtube-highlights` code blocks, enriches
 * them with publish data, and writes the file back. Removes the file
 * from the dirty set on success.
 */
async function enrichFile(filePath: string, plugin: YouTubeHighlighterPlugin): Promise<void> {
	const videoIds = dirtyFiles.get(filePath);
	if (!videoIds || videoIds.size === 0) {
		dirtyFiles.delete(filePath);
		return;
	}

	const file = plugin.app.vault.getAbstractFileByPath(filePath);
	if (!file || !("extension" in file)) {
		dirtyFiles.delete(filePath);
		return;
	}

	try {
		await plugin.app.vault.process(file as TFile, (content: string) => {
			return enrichCodeBlocks(content, videoIds, plugin);
		});
		dirtyFiles.delete(filePath);
	} catch {
		// File may have been deleted or locked — leave it dirty for retry.
	}
}

/**
 * Finds and enriches all `youtube-highlights` code blocks in the given
 * markdown content. Returns the modified content.
 *
 * This is a synchronous string transform (required by `vault.process()`).
 * Transcript and user data are loaded from in-memory caches.
 */
function enrichCodeBlocks(
	content: string,
	videoIds: Set<string>,
	plugin: YouTubeHighlighterPlugin,
): string {
	const lines = content.split("\n");
	const result: string[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];

		if (line !== undefined && line.trim() === CODE_FENCE_OPEN) {
			// Found opening fence. Collect the code block content.
			const startLine = i;
			result.push(line);
			i++;

			const blockLines: string[] = [];
			while (i < lines.length && lines[i]?.trim() !== CODE_FENCE_CLOSE) {
				blockLines.push(lines[i]!);
				i++;
			}

			// Try to enrich.
			const blockContent = blockLines.join("\n");
			const enriched = tryEnrichBlock(blockContent, videoIds, plugin);

			if (enriched !== null) {
				result.push(enriched);
			} else {
				// Keep original content unchanged.
				for (const bl of blockLines) {
					result.push(bl);
				}
			}

			// Push the closing fence.
			if (i < lines.length) {
				result.push(lines[i]!);
				i++;
			}
		} else {
			result.push(line ?? "");
			i++;
		}
	}

	return result.join("\n");
}

/**
 * Attempts to enrich a single code block's JSON content with publish data.
 * Only embeds highlights and annotations (no transcript needed).
 * Returns the enriched JSON string, or null if enrichment isn't possible.
 */
function tryEnrichBlock(
	blockContent: string,
	videoIds: Set<string>,
	plugin: YouTubeHighlighterPlugin,
): string | null {
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(blockContent) as Record<string, unknown>;
	} catch {
		return null;
	}

	const videoId = parsed["videoId"];
	if (typeof videoId !== "string" || !videoIds.has(videoId)) {
		return null;
	}

	// Load user data from the data store (in-memory, synchronous).
	const userData = plugin.dataStore.get(videoId);

	// Build the publish payload — only highlights and annotations.
	const publishPayload: Record<string, unknown> = {
		highlights: userData.highlights,
		annotations: userData.annotations,
	};

	// Serialize with videoId and title readable, but the publish payload
	// compact on a single line. This keeps the code block short enough
	// that Obsidian doesn't defer rendering for off-viewport blocks.
	const compactPublish = JSON.stringify(publishPayload);
	return [
		"{",
		`  "videoId": ${JSON.stringify(parsed["videoId"])},`,
		`  "title": ${JSON.stringify(parsed["title"] ?? "")},`,
		`  "publish": ${compactPublish}`,
		"}",
	].join("\n");
}
