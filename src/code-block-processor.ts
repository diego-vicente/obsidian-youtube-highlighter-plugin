import {MarkdownPostProcessorContext, Notice} from "obsidian";
import type YouTubeHighlighterPlugin from "./main";
import type {VideoData, TranscriptEntry, TranscriptDisplaySettings} from "./types";
import {CODE_BLOCK_LANGUAGE, DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS, normalizeManualBreaks} from "./types";
import {createPlayer, PlayerState} from "./player";
import type {PlayerWrapper} from "./player";
import {fetchTranscript, parseManualTranscript} from "./transcript";
import {createTranscriptView} from "./transcript-view";
import {setupHighlighting} from "./highlights";
import {createAnnotationsView} from "./annotations";
import {createProgressBar} from "./progress-bar";
import {TranscriptSettingsModal} from "./transcript-settings-modal";
import type {VideoDataStore, SyncLogEntry} from "./video-data-store";
import {secondsToTimestamp} from "./utils/time";

/** CSS class names used by the code block processor. */
/** Build timestamp injected by esbuild at compile time. */
declare const BUILD_TIMESTAMP: string;

const CSS = {
	widget: "yt-highlighter-widget",
	buildInfo: "yt-highlighter-build-info",
	infoRow: "yt-highlighter-info-row",
	progressDebug: "yt-highlighter-progress-debug",
	toggleTranscript: "yt-highlighter-toggle-transcript",
	transcriptBody: "yt-highlighter-transcript-body",
	transcriptBodyHidden: "yt-highlighter-transcript-body--hidden",
	error: "yt-highlighter-error",
	fetchingNotice: "yt-highlighter-fetching",
	manualPaste: "yt-highlighter-manual-paste",
	manualTextarea: "yt-highlighter-manual-textarea",
	manualButton: "yt-highlighter-manual-button",
	debugPanel: "yt-highlighter-debug-panel",
	debugToggle: "yt-highlighter-debug-toggle",
	debugBody: "yt-highlighter-debug-body",
	debugLogList: "yt-highlighter-debug-log-list",
	debugLogEntry: "yt-highlighter-debug-log-entry",
	debugLogTime: "yt-highlighter-debug-log-time",
	debugLogType: "yt-highlighter-debug-log-type",
	debugLogMsg: "yt-highlighter-debug-log-msg",
	debugSnapshot: "yt-highlighter-debug-snapshot",
} as const;

/**
 * Registers the `youtube-highlights` code block processor on the plugin.
 * When Obsidian encounters a fenced code block with this language,
 * it calls our handler to render the interactive widget.
 */
export function registerCodeBlockProcessor(plugin: YouTubeHighlighterPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(
		CODE_BLOCK_LANGUAGE,
		(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
			void renderWidget(source, el, ctx, plugin);
		},
	);
}

/**
 * Top-level render function: parses JSON, creates the player, fetches
 * the transcript, and assembles the full widget.
 *
 * Highlights and annotations are stored in the plugin data folder (via
 * VideoDataStore), NOT in the code block. This means the code block
 * content never changes during normal use, so Obsidian never triggers
 * a re-render — the player stays alive and the widget is stable.
 */
async function renderWidget(
	source: string,
	el: HTMLElement,
	ctx: MarkdownPostProcessorContext,
	plugin: YouTubeHighlighterPlugin,
): Promise<void> {
	const videoData = parseVideoData(source);
	if (!videoData) {
		renderError(el, source);
		return;
	}

	const {videoId} = videoData;
	const store = plugin.dataStore;

	// Load user data (highlights, annotations) from the data store.
	// Also migrates any legacy annotations that were stored inline in the code block.
	await store.load(videoId);
	if (videoData.annotations?.length) {
		await store.importLegacyAnnotations(videoId, videoData.annotations);
	}

	const widgetEl = el.createDiv({cls: CSS.widget});

	// 1. Embed the YouTube player.
	const player = createPlayer(widgetEl, videoId);

	// 1b. Restore saved playback position and track progress.
	const infoRowEl = widgetEl.createDiv({cls: CSS.infoRow});
	const progressDebugEl = infoRowEl.createDiv({cls: CSS.progressDebug});
	setupPlaybackProgress(player, videoId, store, progressDebugEl);

	// 1c. Progress bar (slim timeline below the player).
	// Use a late-bound reference so the progress bar can notify the
	// "Go to" button (created later in the annotations toolbar).
	let onFurthestWatchedChange: (() => void) | undefined;
	const progressBar = createProgressBar(
		widgetEl, player, videoId, store,
		() => onFurthestWatchedChange?.(),
	);

	// Wrapper for transcript + toolbar + annotations so the toggle can
	// hide/show them as a group while keeping the progress bar visible.
	const transcriptBodyEl = widgetEl.createDiv({cls: CSS.transcriptBody});

	// Toggle button in the info row — hides/shows the transcript body.
	const ICON_SHOW = "\u25BC"; // ▼
	const ICON_HIDE = "\u25B2"; // ▲
	const toggleButton = infoRowEl.createEl("button", {
		cls: CSS.toggleTranscript,
		text: ICON_HIDE,
		attr: {"aria-label": "Toggle transcript"},
	});

	toggleButton.addEventListener("click", () => {
		const isHidden = transcriptBodyEl.hasClass(CSS.transcriptBodyHidden);
		if (isHidden) {
			transcriptBodyEl.removeClass(CSS.transcriptBodyHidden);
			toggleButton.textContent = ICON_HIDE;
		} else {
			transcriptBodyEl.addClass(CSS.transcriptBodyHidden);
			toggleButton.textContent = ICON_SHOW;
		}
	});

	// 2. Fetch or load the transcript.
	const entries = await loadTranscript(transcriptBodyEl, videoData, plugin);

	// 3. Render the synced transcript view.
	if (entries && entries.length > 0) {
		const userData = store.get(videoId);
		const currentSettings = userData.transcriptSettings ?? DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
		const manualBreaks = normalizeManualBreaks(userData.manualBreaks);

		const transcriptView = createTranscriptView(
			transcriptBodyEl, entries, player, currentSettings, manualBreaks,
		);

		// 4. Set up highlighting (text selection → highlight creation).
		const onHighlightChange = (): void => progressBar.updateMarkers();
		let highlightHandle = setupHighlighting(
			transcriptView.containerEl, transcriptView.entrySpanMap, entries, videoId, store,
			onHighlightChange,
		);

		/** Re-renders transcript and re-applies highlights with current data. */
		const rerenderTranscript = (): void => {
			const latestData = store.get(videoId);
			const settings = latestData.transcriptSettings ?? DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
			const breaks = normalizeManualBreaks(latestData.manualBreaks);

			const newEntrySpanMap = transcriptView.rerender(settings, breaks);
			transcriptView.entrySpanMap = newEntrySpanMap;

			highlightHandle = setupHighlighting(
				transcriptView.containerEl, newEntrySpanMap, entries, videoId, store,
				onHighlightChange,
			);
		};

		// 5. Render annotations panel and toolbar.
		const onSettingsButtonClick = (): void => {
			const latestSettings = store.get(videoId).transcriptSettings ?? DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
			new TranscriptSettingsModal(plugin.app, latestSettings, (newSettings: TranscriptDisplaySettings) => {
				store.get(videoId).transcriptSettings = newSettings;
				store.requestSave(videoId);
				rerenderTranscript();
			}).open();
		};

		const onBreakToggle = (entryIndex: number, charOffset: number): void => {
			const data = store.get(videoId);
			const breaks = normalizeManualBreaks(data.manualBreaks);

			const existingIdx = breaks.findIndex(
				b => b.entryIndex === entryIndex && b.charOffset === charOffset,
			);

			if (existingIdx === -1) {
				// Insert new break, maintaining sorted order.
				breaks.push({entryIndex, charOffset});
				breaks.sort((a, b) => a.entryIndex - b.entryIndex || a.charOffset - b.charOffset);
			} else {
				breaks.splice(existingIdx, 1);
			}

			data.manualBreaks = breaks;
			store.requestSave(videoId);
			rerenderTranscript();
		};

		const onDisplayModeToggle = (): void => {
			const newMode = transcriptView.displayMode === "paragraphs" ? "subtitles" : "paragraphs";
			const newEntrySpanMap = transcriptView.setDisplayMode(newMode);
			transcriptView.entrySpanMap = newEntrySpanMap;

			// Re-apply highlights only in paragraph mode (subtitles are read-only).
			if (newMode === "paragraphs") {
				highlightHandle = setupHighlighting(
					transcriptView.containerEl, newEntrySpanMap, entries, videoId, store,
					onHighlightChange,
				);
			}
		};

		const onAnnotationChange = (): void => progressBar.updateMarkers();
		const annotationsHandle = createAnnotationsView(
			transcriptBodyEl, videoId, store, player,
			highlightHandle, onSettingsButtonClick, transcriptView, onBreakToggle,
			onDisplayModeToggle, onAnnotationChange,
		);

		// Now that the annotations toolbar exists, wire up the late-bound
		// callback so the progress bar tick updates the "Go to" button label.
		onFurthestWatchedChange = () => annotationsHandle.updateFurthestButton();
	}

	// Debug panel — collapsible sync log and data snapshot.
	createDebugPanel(widgetEl, videoId, store);
}

/**
 * Attempts to load the transcript: first from cache, then auto-fetch,
 * then shows a manual paste fallback if both fail.
 */
async function loadTranscript(
	widgetEl: HTMLElement,
	videoData: VideoData,
	plugin: YouTubeHighlighterPlugin,
): Promise<TranscriptEntry[] | null> {
	// Try loading from cache first.
	const cached = await loadCachedTranscript(videoData.videoId, plugin);
	if (cached && cached.length > 0) {
		return cached;
	}

	// Auto-fetch from YouTube.
	const fetchingEl = widgetEl.createDiv({cls: CSS.fetchingNotice, text: "Fetching transcript..."});
	const lang = plugin.settings.transcriptLanguage;
	const result = await fetchTranscript(videoData.videoId, lang);
	fetchingEl.remove();

	if (result.success) {
		await cacheTranscript(videoData.videoId, result.entries, plugin);
		return result.entries;
	}

	// Auto-fetch failed — show manual paste UI.
	return new Promise<TranscriptEntry[] | null>((resolve) => {
		renderManualPasteUI(widgetEl, videoData.videoId, plugin, result.error, resolve);
	});
}

/**
 * Renders a textarea + button for the user to manually paste a transcript
 * when auto-fetch fails.
 */
function renderManualPasteUI(
	parentEl: HTMLElement,
	videoId: string,
	plugin: YouTubeHighlighterPlugin,
	errorMessage: string,
	onParsed: (entries: TranscriptEntry[] | null) => void,
): void {
	const container = parentEl.createDiv({cls: CSS.manualPaste});

	container.createEl("p", {
		text: `Could not auto-fetch transcript: ${errorMessage}`,
	});
	container.createEl("p", {
		text: "Paste the transcript from YouTube below (timestamps will be parsed automatically).",
	});

	const textarea = container.createEl("textarea", {
		cls: CSS.manualTextarea,
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder shows timestamp format example
		attr: {rows: "10", placeholder: "0:00\nFirst line of text\n0:15\nSecond line of text\n..."},
	});

	const button = container.createEl("button", {
		cls: CSS.manualButton,
		text: "Load transcript",
	});

	button.addEventListener("click", () => {
		const rawText = textarea.value.trim();
		if (!rawText) {
			new Notice("Please paste a transcript first.");
			return;
		}

		const entries = parseManualTranscript(rawText);
		if (entries.length === 0) {
			new Notice("Could not parse any transcript entries. Check the format and try again.");
			return;
		}

		void cacheTranscript(videoId, entries, plugin).then(() => {
			container.remove();
			onParsed(entries);
		});
	});
}

// ─── Playback progress ───────────────────────────────────────────────

/** How often (ms) the playback position is persisted while the video is playing. */
const PROGRESS_SAVE_INTERVAL_MS = 5000;

/** Minimum elapsed seconds before we bother persisting a position (avoids saving 0). */
const PROGRESS_MIN_SECONDS = 2;

/**
 * Restores the saved playback position on load and periodically persists
 * the current position while the video is playing. When the video reaches
 * the ENDED state, the saved position is reset to 0 so the next open
 * starts from the beginning.
 *
 * Also updates a debug display element showing the stored position.
 */
function setupPlaybackProgress(
	player: PlayerWrapper,
	videoId: string,
	store: VideoDataStore,
	debugEl: HTMLElement,
): void {
	function updateDebugDisplay(positionSeconds: number): void {
		const timestamp = secondsToTimestamp(positionSeconds);
		debugEl.textContent = `Saved position: ${timestamp} (${Math.round(positionSeconds)}s)`;
	}

	// ── Restore position on load ─────────────────────────────────────
	const savedPosition = store.get(videoId).playbackPosition ?? 0;
	updateDebugDisplay(savedPosition);

	/**
	 * True while we are restoring the saved position. During this window
	 * any PLAYING state triggered by seekTo is suppressed with a pause,
	 * so the video doesn't autoplay on load.
	 */
	let restoringPosition = savedPosition >= PROGRESS_MIN_SECONDS;

	if (restoringPosition) {
		// Mute before seeking so the brief play→pause transition is silent.
		// Wait for the player to be ready before seeking — on iOS the bridge
		// iframe must finish loading before it can accept commands.
		void player.ready.then(async () => {
			await player.mute();
			await player.seekTo(savedPosition);
		});
	}

	// ── Periodic save while playing ──────────────────────────────────
	let progressInterval: number | null = null;

	function saveCurrentPosition(): void {
		void player.getCurrentTime().then((time) => {
			const data = store.get(videoId);
			if (time >= PROGRESS_MIN_SECONDS) {
				data.playbackPosition = time;
				// Track the high-water mark for the progress bar.
				const previousFurthest = data.furthestWatched ?? 0;
				if (time > previousFurthest) {
					data.furthestWatched = time;
				}
				store.requestSave(videoId);
				updateDebugDisplay(time);
			}
		});
	}

	function startProgressTracking(): void {
		if (progressInterval !== null) return;
		progressInterval = window.setInterval(saveCurrentPosition, PROGRESS_SAVE_INTERVAL_MS);
	}

	function stopProgressTracking(): void {
		if (progressInterval !== null) {
			window.clearInterval(progressInterval);
			progressInterval = null;
		}
	}

	player.onStateChange((state) => {
		if (state === PlayerState.PLAYING) {
			if (restoringPosition) {
				// The seek triggered playback — pause immediately so the
				// video doesn't autoplay when restoring a saved position.
				// Then unmute so normal playback has sound.
				restoringPosition = false;
				void player.pause().then(() => player.unMute());
				return;
			}
			startProgressTracking();
		} else if (state === PlayerState.PAUSED) {
			stopProgressTracking();
			// Save immediately on pause so the position isn't stale.
			// Skip if we're still in the restore flow (the pause we just sent).
			if (!restoringPosition) {
				saveCurrentPosition();
			}
		} else if (state === PlayerState.ENDED) {
			stopProgressTracking();
			// Video finished — reset so next open starts from the beginning.
			const data = store.get(videoId);
			data.playbackPosition = 0;
			store.requestSave(videoId);
			updateDebugDisplay(0);
		}
	});
}

// ─── Debug panel ─────────────────────────────────────────────────────

/** Time format for the sync log: "HH:MM:SS". */
function formatLogTime(date: Date): string {
	return date.toLocaleTimeString("en-GB", {hour12: false});
}

/**
 * Creates a collapsible debug panel at the bottom of the widget.
 * Shows the build timestamp, a live sync event log, and a snapshot
 * of the current in-memory data for this video.
 *
 * The panel subscribes to `store.onSyncLogUpdate()` so new entries
 * appear in real-time without manual refresh.
 */
function createDebugPanel(
	parentEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
): void {
	const panelEl = parentEl.createDiv({cls: CSS.debugPanel});

	// ── Toggle header ────────────────────────────────────────────
	const LABEL_COLLAPSED = `\u25B6 Debug (Build: ${BUILD_TIMESTAMP})`;  // ▶
	const LABEL_EXPANDED  = `\u25BC Debug (Build: ${BUILD_TIMESTAMP})`;  // ▼
	const toggleEl = panelEl.createEl("button", {
		cls: CSS.debugToggle,
		text: LABEL_COLLAPSED,
	});

	// ── Body (hidden by default) ─────────────────────────────────
	const bodyEl = panelEl.createDiv({cls: CSS.debugBody});
	bodyEl.style.display = "none";

	toggleEl.addEventListener("click", () => {
		const isHidden = bodyEl.style.display === "none";
		bodyEl.style.display = isHidden ? "block" : "none";
		toggleEl.textContent = isHidden ? LABEL_EXPANDED : LABEL_COLLAPSED;
		if (isHidden) {
			renderSnapshot();
			renderLog();
		}
	});

	// ── Data snapshot section ────────────────────────────────────
	const snapshotHeader = bodyEl.createEl("strong", {text: "Data snapshot"});
	snapshotHeader.style.display = "block";
	snapshotHeader.style.marginTop = "4px";
	const snapshotEl = bodyEl.createEl("pre", {cls: CSS.debugSnapshot});

	function renderSnapshot(): void {
		const data = store.get(videoId);
		const snapshot = {
			videoId,
			playbackPosition: data.playbackPosition ?? 0,
			furthestWatched: data.furthestWatched ?? 0,
			highlights: data.highlights.length,
			annotations: data.annotations.length,
			hasTranscriptSettings: !!data.transcriptSettings,
			manualBreaks: Array.isArray(data.manualBreaks) ? data.manualBreaks.length : 0,
		};
		snapshotEl.textContent = JSON.stringify(snapshot, null, 2);
	}

	// ── Sync log section ────────────────────────────────────────
	bodyEl.createEl("strong", {text: "Sync log"}).style.display = "block";
	const logListEl = bodyEl.createDiv({cls: CSS.debugLogList});

	function renderLogEntry(entry: SyncLogEntry): HTMLElement {
		const row = createDiv({cls: CSS.debugLogEntry});
		row.createSpan({cls: CSS.debugLogTime, text: formatLogTime(entry.timestamp)});
		row.createSpan({cls: CSS.debugLogType, text: entry.type});

		const msgText = entry.videoId
			? `[${entry.videoId}] ${entry.message}`
			: entry.message;
		row.createSpan({cls: CSS.debugLogMsg, text: msgText});

		return row;
	}

	function renderLog(): void {
		logListEl.empty();
		for (const entry of store.syncLog) {
			logListEl.appendChild(renderLogEntry(entry));
		}
		// Auto-scroll to the bottom.
		logListEl.scrollTop = logListEl.scrollHeight;
	}

	// Live updates — when the panel is open, new entries appear automatically.
	const onLogUpdate = (): void => {
		if (bodyEl.style.display === "none") return;
		renderLog();
		renderSnapshot();
	};

	store.onSyncLogUpdate(onLogUpdate);

	// Clean up the listener when the widget is removed from the DOM.
	// MutationObserver on the parent watches for removal.
	const observer = new MutationObserver((mutations) => {
		for (const mutation of mutations) {
			for (const removed of Array.from(mutation.removedNodes)) {
				if (removed === panelEl || removed.contains(panelEl)) {
					store.offSyncLogUpdate(onLogUpdate);
					observer.disconnect();
					return;
				}
			}
		}
	});
	if (parentEl.parentElement) {
		observer.observe(parentEl.parentElement, {childList: true, subtree: true});
	}
}

// ─── Transcript caching ──────────────────────────────────────────────

const TRANSCRIPT_CACHE_DIR = "transcripts";

function transcriptCachePath(videoId: string): string {
	return `${TRANSCRIPT_CACHE_DIR}/${videoId}.json`;
}

async function cacheTranscript(
	videoId: string,
	entries: TranscriptEntry[],
	plugin: YouTubeHighlighterPlugin,
): Promise<void> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) return;

	const adapter = plugin.app.vault.adapter;
	const cacheDir = `${pluginDir}/${TRANSCRIPT_CACHE_DIR}`;

	// Ensure cache directory exists.
	if (!(await adapter.exists(cacheDir))) {
		await adapter.mkdir(cacheDir);
	}

	const filePath = `${pluginDir}/${transcriptCachePath(videoId)}`;
	await adapter.write(filePath, JSON.stringify(entries));
}

async function loadCachedTranscript(
	videoId: string,
	plugin: YouTubeHighlighterPlugin,
): Promise<TranscriptEntry[] | null> {
	const pluginDir = plugin.manifest.dir;
	if (!pluginDir) return null;

	const adapter = plugin.app.vault.adapter;
	const filePath = `${pluginDir}/${transcriptCachePath(videoId)}`;

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

// ─── Parsing helpers ─────────────────────────────────────────────────

/** Replace smart/curly quotes with their ASCII equivalents. */
function sanitizeSmartQuotes(raw: string): string {
	return raw
		.replace(/[\u201C\u201D]/g, '"')  // " " → "
		.replace(/[\u2018\u2019]/g, "'"); // ' ' → '
}

/**
 * Fallback parser for when JSON.parse fails (e.g. unescaped quotes in
 * the title value).  Extracts videoId and title via regex from the
 * known `{"videoId": "...", "title": "..."}` shape.
 */
function parseVideoDataFallback(source: string): VideoData | null {
	const videoIdMatch = source.match(/"videoId"\s*:\s*"([^"]+)"/);
	const videoId = videoIdMatch?.[1];
	if (!videoId) return null;

	// Title is trickier — grab everything between the last pair of
	// quotes that follows `"title":`.  The value may contain unescaped
	// quotes, so we match from after `"title": "` to the final `"}`.
	const titleMatch = source.match(/"title"\s*:\s*"([\s\S]+)"\s*\}$/);
	const title = titleMatch?.[1] ?? "";

	return { videoId, title };
}

function parseVideoData(source: string): VideoData | null {
	const sanitized = sanitizeSmartQuotes(source);
	try {
		const parsed: unknown = JSON.parse(sanitized);
		if (!isVideoData(parsed)) {
			return null;
		}
		return parsed;
	} catch {
		// JSON is malformed — attempt regex extraction
		return parseVideoDataFallback(sanitized);
	}
}

/** Minimal type guard — checks the required shape of VideoData. */
function isVideoData(value: unknown): value is VideoData {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const obj = value as Record<string, unknown>;
	return typeof obj["videoId"] === "string" && typeof obj["title"] === "string";
}

/** Shows a friendly error when the code block JSON is invalid. */
function renderError(el: HTMLElement, rawSource: string): void {
	const container = el.createDiv({cls: CSS.error});
	container.createEl("p", {
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "youtube-highlights" is a code block identifier
		text: "Invalid youtube-highlights data. Expected valid JSON with at least a \"videoId\" field.",
	});
	container.createEl("pre", {text: rawSource});
}
