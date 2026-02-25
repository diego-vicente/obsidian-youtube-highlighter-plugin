import type YouTubeHighlighterPlugin from "./main";
import type {VideoUserData, PluginData, Highlight, Annotation} from "./types";
import {createEmptyUserData, createEmptyPluginData, migrateTranscriptSettings} from "./types";
import {debounce} from "./utils/dom";
import type {DebouncedFn} from "./utils/dom";

/**
 * Legacy directory within the plugin folder where per-video JSON files
 * were stored before the migration to plugin loadData/saveData.
 */
const LEGACY_DATA_DIR = "data";

/** Delay before flushing changes to disk (batches rapid edits). */
const SAVE_DEBOUNCE_MS = 500;

/** Maximum number of sync log entries to keep (rolling window). */
const MAX_SYNC_LOG_ENTRIES = 50;

// ─── Sync log types ─────────────────────────────────────────────────

/** Possible sync event types. */
export type SyncEventType =
	| "initialized"
	| "save-requested"
	| "save-flushed"
	| "save-error"
	| "flush-on-unload"
	| "external-change-detected"
	| "merge-completed"
	| "merge-detail";

/** A single timestamped entry in the sync log. */
export interface SyncLogEntry {
	/** When this event occurred. */
	timestamp: Date;
	/** The type of event. */
	type: SyncEventType;
	/** Human-readable description of what happened. */
	message: string;
	/** Optional per-video detail (e.g. which video was affected). */
	videoId?: string;
}

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
	private debouncedSave: DebouncedFn<() => void>;

	/** Rolling log of sync-related events for debugging. */
	readonly syncLog: SyncLogEntry[] = [];

	/** Listeners notified whenever a new sync log entry is added. */
	private syncLogListeners: Array<() => void> = [];

	constructor(plugin: YouTubeHighlighterPlugin) {
		this.plugin = plugin;
		this.debouncedSave = debounce(() => {
			this.flush().catch((err) => {
				const errorMsg = err instanceof Error ? err.message : String(err);
				this.log("save-error", `saveData() failed: ${errorMsg}`);
				console.error("[YouTubeHighlighter] Failed to save plugin data:", err);
			});
		}, SAVE_DEBOUNCE_MS);
	}

	// ─── Sync log ───────────────────────────────────────────────────

	/** Registers a callback invoked whenever a new log entry is added. */
	onSyncLogUpdate(listener: () => void): void {
		this.syncLogListeners.push(listener);
	}

	/** Removes a previously registered sync log listener. */
	offSyncLogUpdate(listener: () => void): void {
		this.syncLogListeners = this.syncLogListeners.filter(l => l !== listener);
	}

	/** Appends a timestamped entry to the sync log and notifies listeners. */
	private log(type: SyncEventType, message: string, videoId?: string): void {
		this.syncLog.push({timestamp: new Date(), type, message, videoId});
		if (this.syncLog.length > MAX_SYNC_LOG_ENTRIES) {
			this.syncLog.splice(0, this.syncLog.length - MAX_SYNC_LOG_ENTRIES);
		}
		for (const listener of this.syncLogListeners) {
			listener();
		}
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

		const videoCount = Object.keys(this.pluginData.videoData).length;
		this.log("initialized", `Loaded data.json — ${videoCount} video(s) in store`);
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
	requestSave(videoId?: string): void {
		this.log("save-requested", "Debounced save scheduled", videoId);
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
		const videoCount = Object.keys(this.pluginData.videoData).length;
		this.log("save-flushed", `Wrote data.json to disk (${videoCount} video(s))`);
		await this.plugin.saveData(this.pluginData);
	}

	/**
	 * Fires the debounced save immediately if one is pending, then
	 * does a final flush. Safe to call from `onunload()` to ensure
	 * no in-flight changes are lost when the plugin is disabled or
	 * Obsidian is closed.
	 */
	flushPending(): void {
		this.log("flush-on-unload", "Plugin unloading — flushing pending writes");
		this.debouncedSave.flushIfPending();
	}

	/**
	 * Called when Obsidian detects that `data.json` was modified
	 * externally (e.g. by Obsidian Sync or iCloud). Re-reads the file
	 * and merges the incoming data with any unsaved in-memory mutations.
	 *
	 * Merge strategy per video:
	 * - `playbackPosition` / `furthestWatched`: use the larger value
	 *   (more recent progress wins).
	 * - `highlights`: union by id (both sides' additions are preserved).
	 * - `annotations`: union by id.
	 * - `transcriptSettings`, `manualBreaks`: prefer the incoming
	 *   (synced) version — these are rarely edited on two devices
	 *   simultaneously and the synced copy is "fresher".
	 * - Plugin-wide settings: prefer the incoming version.
	 */
	async reloadFromDisk(): Promise<void> {
		this.log("external-change-detected", "data.json modified externally — starting merge");

		// 1. Cancel any pending debounced write — we don't want a stale
		//    snapshot overwriting the freshly-merged result.
		this.debouncedSave.cancel();

		// 2. Snapshot what we currently have in memory (may contain
		//    unsaved mutations from the local session).
		const local = this.pluginData;

		// 3. Read the externally-modified file from disk.
		const raw = await this.plugin.loadData() as Record<string, unknown> | null;
		const incoming = this.parsePluginData(raw);

		// 4. Log merge details before merging.
		this.logMergeDetails(local, incoming);

		// 5. Merge incoming (synced) data with local in-memory data.
		this.pluginData = this.mergePluginData(local, incoming);

		const mergedVideoCount = Object.keys(this.pluginData.videoData).length;
		this.log("merge-completed", `Merge done — ${mergedVideoCount} video(s) in merged store`);

		// 6. Persist the merged result so both devices converge on the
		//    same state after the next sync cycle.
		await this.flush();
	}

	/** Logs per-video merge details so the debug panel shows what changed. */
	private logMergeDetails(local: PluginData, incoming: PluginData): void {
		const localVideoIds = new Set(Object.keys(local.videoData));
		const incomingVideoIds = new Set(Object.keys(incoming.videoData));

		// Videos only on one side.
		for (const id of incomingVideoIds) {
			if (!localVideoIds.has(id)) {
				this.log("merge-detail", `New video from sync (not in local)`, id);
			}
		}
		for (const id of localVideoIds) {
			if (!incomingVideoIds.has(id)) {
				this.log("merge-detail", `Local-only video (not in sync)`, id);
			}
		}

		// Videos on both sides — log field-level diffs.
		for (const id of localVideoIds) {
			if (!incomingVideoIds.has(id)) continue;
			const l = local.videoData[id];
			const i = incoming.videoData[id];
			if (!l || !i) continue;

			const diffs: string[] = [];

			const localPos = l.playbackPosition ?? 0;
			const incomingPos = i.playbackPosition ?? 0;
			if (localPos !== incomingPos) {
				diffs.push(`pos: ${localPos.toFixed(1)}s→${incomingPos.toFixed(1)}s (keep ${Math.max(localPos, incomingPos).toFixed(1)}s)`);
			}

			const localFurthest = l.furthestWatched ?? 0;
			const incomingFurthest = i.furthestWatched ?? 0;
			if (localFurthest !== incomingFurthest) {
				diffs.push(`furthest: ${localFurthest.toFixed(1)}s→${incomingFurthest.toFixed(1)}s (keep ${Math.max(localFurthest, incomingFurthest).toFixed(1)}s)`);
			}

			if (l.highlights.length !== i.highlights.length) {
				diffs.push(`highlights: ${l.highlights.length}→${i.highlights.length}`);
			}
			if (l.annotations.length !== i.annotations.length) {
				diffs.push(`annotations: ${l.annotations.length}→${i.annotations.length}`);
			}

			if (diffs.length > 0) {
				this.log("merge-detail", diffs.join("; "), id);
			}
		}
	}

	// ─── Merge helpers ──────────────────────────────────────────────

	/**
	 * Merges two `PluginData` objects. `incoming` is the freshly-synced
	 * copy from disk; `local` is the in-memory version that may contain
	 * unsaved edits.
	 */
	private mergePluginData(local: PluginData, incoming: PluginData): PluginData {
		// Settings: prefer incoming (the synced device's settings are
		// considered authoritative for simple scalars).
		const settings = {...local.settings, ...incoming.settings};

		// Video data: merge per-video, covering videos that exist on
		// only one side as well as videos present on both.
		const allVideoIds = new Set([
			...Object.keys(local.videoData),
			...Object.keys(incoming.videoData),
		]);

		const videoData: Record<string, VideoUserData> = {};

		for (const videoId of allVideoIds) {
			const localVideo = local.videoData[videoId];
			const incomingVideo = incoming.videoData[videoId];

			if (localVideo && incomingVideo) {
				videoData[videoId] = this.mergeVideoData(localVideo, incomingVideo);
			} else {
				// Only exists on one side — take whichever we have.
				// The non-null assertion is safe: videoId came from one of
				// the two key sets, so at least one side has it.
				videoData[videoId] = (localVideo ?? incomingVideo)!;
			}
		}

		return {settings, videoData};
	}

	/**
	 * Merges two `VideoUserData` objects for the same video.
	 *
	 * - Numeric progress fields → max wins (both are monotonically
	 *   increasing during normal use).
	 * - Arrays with `id` fields (highlights, annotations) → union by id
	 *   so additions from both devices are preserved.
	 * - Structural settings (transcriptSettings, manualBreaks) → prefer
	 *   incoming, since the synced copy is newer.
	 */
	private mergeVideoData(local: VideoUserData, incoming: VideoUserData): VideoUserData {
		return {
			highlights: mergeById<Highlight>(local.highlights, incoming.highlights),
			annotations: mergeById<Annotation>(local.annotations, incoming.annotations),

			// Prefer incoming for structural/config fields — the synced
			// copy reflects the most recent intentional edit.
			transcriptSettings: incoming.transcriptSettings ?? local.transcriptSettings,
			manualBreaks: incoming.manualBreaks ?? local.manualBreaks,

			// Progress: take the higher value (more recently watched).
			playbackPosition: Math.max(
				local.playbackPosition ?? 0,
				incoming.playbackPosition ?? 0,
			),
			furthestWatched: Math.max(
				local.furthestWatched ?? 0,
				incoming.furthestWatched ?? 0,
			),
		};
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

// ─── Module-level merge utilities ────────────────────────────────────

/**
 * Merges two arrays of objects that have an `id` field. Returns a new
 * array containing the union — items from `b` that share an id with
 * items in `a` overwrite the `a` version (incoming wins on conflicts),
 * while items unique to either side are preserved.
 */
function mergeById<T extends {id: string}>(a: T[], b: T[]): T[] {
	const map = new Map<string, T>();

	// Seed with local items.
	for (const item of a) {
		map.set(item.id, item);
	}

	// Overlay incoming items — incoming wins on id collision.
	for (const item of b) {
		map.set(item.id, item);
	}

	return Array.from(map.values());
}
