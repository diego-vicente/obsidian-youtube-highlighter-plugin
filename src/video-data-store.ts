import type YouTubeHighlighterPlugin from "./main";
import type {VideoUserData, PluginData} from "./types";
import {createEmptyUserData, createEmptyPluginData, migrateTranscriptSettings} from "./types";
import {debounce} from "./utils/dom";

/**
 * Legacy directory within the plugin folder where per-video JSON files
 * were stored before the migration to plugin loadData/saveData.
 */
const LEGACY_DATA_DIR = "data";

/** Delay before flushing changes to disk (batches rapid edits). */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persists all per-video user data (highlights, annotations, playback
 * position, etc.) via Obsidian's `plugin.saveData()` mechanism.
 *
 * Data lives in `data.json` alongside plugin settings, which means
 * Obsidian Sync covers it automatically. The store keeps the full
 * `PluginData` object in memory and debounces writes.
 *
 * On first use it migrates any legacy per-video JSON files from the
 * old `data/` subfolder into the unified `data.json`.
 */
export class VideoDataStore {
	private plugin: YouTubeHighlighterPlugin;

	/** The full plugin data object (settings + all video data). */
	private pluginData: PluginData = createEmptyPluginData();

	/** Single debounced save for the entire plugin data blob. */
	private debouncedSave: () => void;

	constructor(plugin: YouTubeHighlighterPlugin) {
		this.plugin = plugin;
		this.debouncedSave = debounce(() => { void this.flush(); }, SAVE_DEBOUNCE_MS);
	}

	/**
	 * Initializes the store by loading `data.json` via `plugin.loadData()`
	 * and migrating any legacy per-video files from the `data/` subfolder.
	 * Must be called once during `onload()` before any other method.
	 */
	async initialize(): Promise<void> {
		const raw = await this.plugin.loadData() as Record<string, unknown> | null;
		this.pluginData = this.parsePluginData(raw);
		await this.migrateLegacyFiles();
	}

	/** Returns the plugin-wide settings object (mutable reference). */
	get settings(): PluginData["settings"] {
		return this.pluginData.settings;
	}

	/**
	 * Loads user data for a video. Returns existing data or creates an
	 * empty entry. No async I/O needed — everything is already in memory.
	 */
	async load(videoId: string): Promise<VideoUserData> {
		return this.getOrCreate(videoId);
	}

	/**
	 * Returns the in-memory data for a video (synchronous).
	 * Creates an empty entry if none exists yet.
	 */
	get(videoId: string): VideoUserData {
		return this.getOrCreate(videoId);
	}

	/**
	 * Schedules a debounced save of the entire plugin data to disk.
	 * Call this after mutating the data returned by `get()` or `load()`.
	 */
	requestSave(_videoId?: string): void {
		this.debouncedSave();
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

		const data = this.getOrCreate(videoId);

		// Only import if the data store has no annotations yet (first migration).
		if (data.annotations.length === 0) {
			data.annotations.push(...annotations);
			await this.flush();
		}
	}

	// ─── Persistence ─────────────────────────────────────────────────

	/** Immediately writes the full plugin data blob via saveData(). */
	async flush(): Promise<void> {
		await this.plugin.saveData(this.pluginData);
	}

	// ─── Internal helpers ────────────────────────────────────────────

	private getOrCreate(videoId: string): VideoUserData {
		let data = this.pluginData.videoData[videoId];
		if (!data) {
			data = createEmptyUserData();
			this.pluginData.videoData[videoId] = data;
		}
		return data;
	}

	/**
	 * Parses raw data from `loadData()` into a `PluginData` object.
	 * Handles three cases:
	 * 1. null / undefined → fresh install, return defaults.
	 * 2. Has `videoData` key → already in the new format.
	 * 3. Has `transcriptLanguage` key → old settings-only format, wrap it.
	 */
	private parsePluginData(raw: Record<string, unknown> | null): PluginData {
		if (!raw) return createEmptyPluginData();

		// New format: has videoData map.
		if (raw["videoData"] && typeof raw["videoData"] === "object") {
			const settings = (raw["settings"] as PluginData["settings"]) ?? {...createEmptyPluginData().settings};
			const videoData = raw["videoData"] as Record<string, VideoUserData>;

			// Migrate transcript settings within each video entry.
			for (const videoId of Object.keys(videoData)) {
				const entry = videoData[videoId];
				if (entry && entry.transcriptSettings) {
					const migrated = migrateTranscriptSettings(
						entry.transcriptSettings as unknown as Record<string, unknown>,
					);
					if (migrated) entry.transcriptSettings = migrated;
				}
			}

			return {settings, videoData};
		}

		// Old format: raw IS the settings object (e.g. { transcriptLanguage: "en" }).
		const result = createEmptyPluginData();
		if (typeof raw["transcriptLanguage"] === "string") {
			result.settings.transcriptLanguage = raw["transcriptLanguage"];
		}
		return result;
	}

	// ─── Legacy migration ────────────────────────────────────────────

	/**
	 * Reads any per-video JSON files from the old `data/` subfolder and
	 * merges them into `pluginData.videoData`. Only runs once — after
	 * migrating, the files are left in place but never read again
	 * (the in-memory data takes precedence).
	 */
	private async migrateLegacyFiles(): Promise<void> {
		const pluginDir = this.plugin.manifest.dir;
		if (!pluginDir) return;

		const adapter = this.plugin.app.vault.adapter;
		const legacyDir = `${pluginDir}/${LEGACY_DATA_DIR}`;

		if (!(await adapter.exists(legacyDir))) return;

		try {
			const listing = await adapter.list(legacyDir);
			const jsonFiles = listing.files.filter(f => f.endsWith(".json"));

			if (jsonFiles.length === 0) return;

			let migrated = false;

			for (const filePath of jsonFiles) {
				// Extract videoId from filename: "data/XKSjCOKDtpk.json" → "XKSjCOKDtpk"
				const fileName = filePath.split("/").pop() ?? "";
				const videoId = fileName.replace(/\.json$/, "");
				if (!videoId) continue;

				// Skip if we already have data for this video in the new store.
				if (this.pluginData.videoData[videoId]) continue;

				try {
					const raw = await adapter.read(filePath);
					const parsed = JSON.parse(raw) as Record<string, unknown>;

					// Migrate old transcript settings format.
					if (parsed["transcriptSettings"]) {
						parsed["transcriptSettings"] = migrateTranscriptSettings(
							parsed["transcriptSettings"] as Record<string, unknown>,
						);
					}

					this.pluginData.videoData[videoId] = parsed as unknown as VideoUserData;
					migrated = true;
				} catch {
					// Skip files that can't be read/parsed.
				}
			}

			if (migrated) {
				await this.flush();
			}
		} catch {
			// If listing fails (e.g. directory not readable), just skip migration.
		}
	}
}
