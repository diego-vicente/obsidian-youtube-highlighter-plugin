import {MarkdownPostProcessorContext, Notice} from "obsidian";
import type YouTubeHighlighterPlugin from "./main";
import type {VideoData, TranscriptEntry} from "./types";
import {CODE_BLOCK_LANGUAGE} from "./types";
import {createPlayer} from "./player";
import {fetchTranscript, parseManualTranscript} from "./transcript";
import {createTranscriptView} from "./transcript-view";
import {setupHighlighting} from "./highlights";
import {createAnnotationsView} from "./annotations";

/** CSS class names used by the code block processor. */
/** Build timestamp injected by esbuild at compile time. */
declare const BUILD_TIMESTAMP: string;

const CSS = {
	widget: "yt-highlighter-widget",
	buildInfo: "yt-highlighter-build-info",
	error: "yt-highlighter-error",
	fetchingNotice: "yt-highlighter-fetching",
	manualPaste: "yt-highlighter-manual-paste",
	manualTextarea: "yt-highlighter-manual-textarea",
	manualButton: "yt-highlighter-manual-button",
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

	// 2. Fetch or load the transcript.
	const entries = await loadTranscript(widgetEl, videoData, plugin);

	// 3. Render the synced transcript view.
	if (entries && entries.length > 0) {
		const transcriptView = createTranscriptView(widgetEl, entries, player);

		// 4. Set up highlighting (text selection → highlight creation).
		setupHighlighting(transcriptView.containerEl, transcriptView.entrySpanMap, entries, videoId, store);

		// 5. Render annotations panel and toolbar.
		createAnnotationsView(widgetEl, videoId, store, player);
	}

	// Build info for debugging sync issues.
	widgetEl.createDiv({cls: CSS.buildInfo, text: `Build: ${BUILD_TIMESTAMP}`});
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

function parseVideoData(source: string): VideoData | null {
	try {
		const parsed: unknown = JSON.parse(source);
		if (!isVideoData(parsed)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
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
