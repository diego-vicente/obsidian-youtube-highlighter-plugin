import type YouTubeHighlighterPlugin from "./main";
import type {VideoUserData} from "./types";
import {createEmptyUserData} from "./types";
import {debounce} from "./utils/dom";

/** Directory within the plugin folder for per-video user data files. */
const USER_DATA_DIR = "data";

/** Delay before flushing changes to disk (batches rapid edits). */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persists highlights and annotations per video in the plugin data folder.
 *
 * Data is stored at `<pluginDir>/data/<videoId>.json`, completely separate
 * from the code block. This means changes never trigger Obsidian's code
 * block re-render cycle.
 *
 * Each video gets its own in-memory cache and debounced save.
 */
export class VideoDataStore {
	private plugin: YouTubeHighlighterPlugin;

	/** In-memory cache of loaded video data. */
	private cache = new Map<string, VideoUserData>();

	/** Per-video debounced save functions. */
	private debouncedSaves = new Map<string, () => void>();

	constructor(plugin: YouTubeHighlighterPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Loads user data for a video. Returns cached version if available,
	 * otherwise reads from disk. Returns empty data if no file exists.
	 */
	async load(videoId: string): Promise<VideoUserData> {
		const cached = this.cache.get(videoId);
		if (cached) return cached;

		const data = await this.readFromDisk(videoId);
		this.cache.set(videoId, data);
		return data;
	}

	/**
	 * Returns the in-memory data for a video. Must call `load()` first.
	 * Returns empty data if not yet loaded (defensive).
	 */
	get(videoId: string): VideoUserData {
		return this.cache.get(videoId) ?? createEmptyUserData();
	}

	/**
	 * Schedules a debounced save of the video's data to disk.
	 * Call this after mutating the data returned by `get()` or `load()`.
	 */
	requestSave(videoId: string): void {
		let save = this.debouncedSaves.get(videoId);
		if (!save) {
			save = debounce(() => { void this.writeToDisk(videoId); }, SAVE_DEBOUNCE_MS);
			this.debouncedSaves.set(videoId, save);
		}
		save();
	}

	/**
	 * Imports legacy annotations from a code block's VideoData (annotations
	 * that were stored inline). Merges into the data store if not already present.
	 *
	 * Legacy highlights are not imported — they used a different data model
	 * (whole-entry time ranges) incompatible with the current word-level format.
	 */
	async importLegacyAnnotations(
		videoId: string,
		annotations: Array<{id: string; timestamp: number; text: string}>,
	): Promise<void> {
		if (annotations.length === 0) return;

		const data = await this.load(videoId);

		// Only import if the data store has no annotations yet (first migration).
		if (data.annotations.length === 0) {
			data.annotations.push(...annotations);
			await this.writeToDisk(videoId);
		}
	}

	// ─── Disk I/O ────────────────────────────────────────────────────

	private dataFilePath(videoId: string): string {
		return `${this.plugin.manifest.dir}/${USER_DATA_DIR}/${videoId}.json`;
	}

	private async ensureDataDir(): Promise<void> {
		const pluginDir = this.plugin.manifest.dir;
		if (!pluginDir) return;

		const dir = `${pluginDir}/${USER_DATA_DIR}`;
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(dir))) {
			await adapter.mkdir(dir);
		}
	}

	private async readFromDisk(videoId: string): Promise<VideoUserData> {
		const pluginDir = this.plugin.manifest.dir;
		if (!pluginDir) return createEmptyUserData();

		const adapter = this.plugin.app.vault.adapter;
		const path = this.dataFilePath(videoId);

		if (!(await adapter.exists(path))) {
			return createEmptyUserData();
		}

		try {
			const raw = await adapter.read(path);
			return JSON.parse(raw) as VideoUserData;
		} catch {
			return createEmptyUserData();
		}
	}

	private async writeToDisk(videoId: string): Promise<void> {
		const pluginDir = this.plugin.manifest.dir;
		if (!pluginDir) return;

		const data = this.cache.get(videoId);
		if (!data) return;

		await this.ensureDataDir();
		const adapter = this.plugin.app.vault.adapter;
		await adapter.write(this.dataFilePath(videoId), JSON.stringify(data, null, 2));
	}
}
