/**
 * publish.js — Read-only YouTube Highlighter widget for Obsidian Publish.
 *
 * Renders a streamlined view of your highlights and annotations:
 *   1. Embedded YouTube player (via IFrame API for seekTo control)
 *   2. Progress bar with highlight ranges and annotation markers
 *   3. Chronological list of highlights (==text==) and annotations
 *      with clickable timestamps that seek the player
 *
 * No full transcript, no karaoke sync, no editing. Just your curated items.
 *
 * Requirements:
 *   - Code blocks must be enriched via the auto-sync (publish key present)
 *   - Publish site must use a custom domain for publish.js to execute
 */

// ─── Types ───────────────────────────────────────────────────────────

interface Highlight {
	id: string;
	text: string;
	/** User-edited display text override, one string per entry (supports inline markdown). */
	displayText?: string[];
	startTime: number;
	endTime: number;
}

interface Annotation {
	id: string;
	timestamp: number;
	text: string;
}

interface PublishData {
	videoId: string;
	title: string;
	publish?: {
		highlights: Highlight[];
		annotations: Annotation[];
	};
}

// ─── Constants ───────────────────────────────────────────────────────

const CODE_BLOCK_LANGUAGE = "youtube-highlights";
const YOUTUBE_NOCOOKIE_HOST = "https://www.youtube-nocookie.com";

/** CSS class names for the publish widget. */
const CLS = {
	widget: "yt-pub-widget",
	player: "yt-pub-player",
	progressBar: "yt-pub-progress-bar",
	progressTrack: "yt-pub-progress-track",
	progressHighlight: "yt-pub-progress-highlight",
	progressAnnotation: "yt-pub-progress-annotation",
	progressPlayhead: "yt-pub-progress-playhead",
	items: "yt-pub-items",
	item: "yt-pub-item",
	itemHighlight: "yt-pub-item--highlight",
	itemAnnotation: "yt-pub-item--annotation",
	timestamp: "yt-pub-timestamp",
	timestampRange: "yt-pub-timestamp-range",
	highlightText: "yt-pub-highlight-text",
	annotationText: "yt-pub-annotation-text",
	empty: "yt-pub-empty",
	fallback: "yt-pub-fallback",
} as const;

// ─── Timestamp formatting ────────────────────────────────────────────

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const TIMESTAMP_PAD_LENGTH = 2;

function secondsToTimestamp(totalSeconds: number): string {
	const rounded = Math.floor(totalSeconds);
	const hours = Math.floor(rounded / SECONDS_PER_HOUR);
	const minutes = Math.floor((rounded % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const seconds = rounded % SECONDS_PER_MINUTE;

	const paddedSeconds = String(seconds).padStart(TIMESTAMP_PAD_LENGTH, "0");
	const paddedMinutes = String(minutes).padStart(TIMESTAMP_PAD_LENGTH, "0");

	if (hours > 0) return `${hours}:${paddedMinutes}:${paddedSeconds}`;
	return `${minutes}:${paddedSeconds}`;
}

// ─── YouTube IFrame API ──────────────────────────────────────────────

interface SimplePlayer {
	getCurrentTime(): number;
	getDuration(): number;
	seekTo(seconds: number, allowSeekAhead: boolean): void;
}

interface YTEvent {
	data: number;
	target: SimplePlayer;
}

const PlayerState = {
	PLAYING: 1,
} as const;

function ensureYouTubeApi(): Promise<void> {
	return new Promise((resolve) => {
		if ((window as any).YT?.Player) {
			resolve();
			return;
		}

		const existingCallback = (window as any).onYouTubeIframeAPIReady;
		(window as any).onYouTubeIframeAPIReady = () => {
			existingCallback?.();
			resolve();
		};

		if (!document.querySelector('script[src*="youtube.com/iframe_api"]')) {
			const tag = document.createElement("script");
			tag.src = "https://www.youtube.com/iframe_api";
			document.head.appendChild(tag);
		}
	});
}

function createYouTubePlayer(
	containerEl: HTMLElement,
	videoId: string,
): {player: SimplePlayer | null; ready: Promise<SimplePlayer>; onStateChange: (handler: (state: number) => void) => void} {
	const stateChangeHandlers: Array<(state: number) => void> = [];
	let resolvedPlayer: SimplePlayer | null = null;

	const ready = ensureYouTubeApi().then(() => {
		return new Promise<SimplePlayer>((resolve) => {
			const targetDiv = document.createElement("div");
			containerEl.appendChild(targetDiv);

			new (window as any).YT.Player(targetDiv, {
				videoId,
				width: "100%",
				height: "100%",
				playerVars: {
					autoplay: 0,
					modestbranding: 1,
					rel: 0,
					playsinline: 1,
				},
				host: YOUTUBE_NOCOOKIE_HOST,
				events: {
					onReady: (event: YTEvent) => {
						resolvedPlayer = event.target;
						resolve(event.target);
					},
					onStateChange: (event: YTEvent) => {
						for (const handler of stateChangeHandlers) {
							handler(event.data);
						}
					},
				},
			});
		});
	});

	return {
		get player() { return resolvedPlayer; },
		ready,
		onStateChange(handler: (state: number) => void) {
			stateChangeHandlers.push(handler);
		},
	};
}

// ─── Merged item type for chronological sorting ──────────────────────

interface DisplayItem {
	/** Sort key — start time for highlights, timestamp for annotations. */
	time: number;
	kind: "highlight" | "annotation";
	highlight?: Highlight;
	annotation?: Annotation;
}

function buildSortedItems(highlights: Highlight[], annotations: Annotation[]): DisplayItem[] {
	const items: DisplayItem[] = [];

	for (const h of highlights) {
		items.push({time: h.startTime, kind: "highlight", highlight: h});
	}
	for (const a of annotations) {
		items.push({time: a.timestamp, kind: "annotation", annotation: a});
	}

	items.sort((a, b) => a.time - b.time);
	return items;
}

// ─── Widget rendering ────────────────────────────────────────────────

function renderPublishWidget(source: string, el: HTMLElement): void {
	let data: PublishData;
	try {
		data = JSON.parse(source);
	} catch {
		el.textContent = "Invalid youtube-highlights data.";
		return;
	}

	if (!data.publish) {
		// Fallback: show a plain link to the video.
		const fallback = document.createElement("div");
		fallback.className = CLS.fallback;
		const link = document.createElement("a");
		link.href = `https://www.youtube.com/watch?v=${data.videoId}`;
		link.textContent = data.title || `YouTube: ${data.videoId}`;
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		fallback.appendChild(link);
		el.appendChild(fallback);
		return;
	}

	const {videoId} = data;
	const pub = data.publish;
	const highlights = Array.isArray(pub.highlights) ? pub.highlights : [];
	const annotations = Array.isArray(pub.annotations) ? pub.annotations : [];
	const items = buildSortedItems(highlights, annotations);

	const widgetEl = document.createElement("div");
	widgetEl.className = CLS.widget;
	el.appendChild(widgetEl);

	// 1. YouTube player.
	const playerEl = document.createElement("div");
	playerEl.className = CLS.player;
	widgetEl.appendChild(playerEl);

	const ytPlayer = createYouTubePlayer(playerEl, videoId);

	// 2. Progress bar.
	const progressBarEl = document.createElement("div");
	progressBarEl.className = CLS.progressBar;
	widgetEl.appendChild(progressBarEl);

	const trackEl = document.createElement("div");
	trackEl.className = CLS.progressTrack;
	progressBarEl.appendChild(trackEl);

	const playheadEl = document.createElement("div");
	playheadEl.className = CLS.progressPlayhead;
	trackEl.appendChild(playheadEl);

	// 3. Highlights + annotations list.
	if (items.length === 0) {
		const emptyEl = document.createElement("div");
		emptyEl.className = CLS.empty;
		emptyEl.textContent = "No highlights or annotations.";
		widgetEl.appendChild(emptyEl);
	} else {
		const listEl = document.createElement("div");
		listEl.className = CLS.items;
		widgetEl.appendChild(listEl);

		for (const item of items) {
			if (item.kind === "highlight" && item.highlight) {
				renderHighlightItem(listEl, item.highlight, ytPlayer);
			} else if (item.kind === "annotation" && item.annotation) {
				renderAnnotationItem(listEl, item.annotation, ytPlayer);
			}
		}
	}

	// 4. Progress bar markers + playhead sync (once player is ready).
	void ytPlayer.ready.then((player) => {
		const duration = player.getDuration();
		const MIN_DURATION = 1;
		if (duration <= MIN_DURATION) return;

		const MAX_PERCENT = 100;
		const toPercent = (seconds: number): number =>
			Math.max(0, Math.min(MAX_PERCENT, (seconds / duration) * MAX_PERCENT));

		// Highlight ranges on progress bar.
		for (const h of highlights) {
			const left = toPercent(h.startTime);
			const right = toPercent(h.endTime);
			const MIN_WIDTH = 0.3;
			const width = Math.max(right - left, MIN_WIDTH);

			const hlEl = document.createElement("div");
			hlEl.className = CLS.progressHighlight;
			hlEl.style.left = `${left}%`;
			hlEl.style.width = `${width}%`;
			trackEl.appendChild(hlEl);
		}

		// Annotation markers on progress bar.
		for (const a of annotations) {
			const markerEl = document.createElement("div");
			markerEl.className = CLS.progressAnnotation;
			markerEl.style.left = `${toPercent(a.timestamp)}%`;
			trackEl.appendChild(markerEl);
		}

		// Click-to-seek on progress bar.
		progressBarEl.addEventListener("click", (event) => {
			const rect = progressBarEl.getBoundingClientRect();
			const fraction = (event.clientX - rect.left) / rect.width;
			player.seekTo(fraction * duration, true);
		});

		// Playhead sync.
		const SYNC_POLL_MS = 250;
		let syncInterval: number | null = null;

		function updatePlayhead(): void {
			if (!ytPlayer.player) return;
			const time = ytPlayer.player.getCurrentTime();
			playheadEl.style.left = `${toPercent(time)}%`;
		}

		ytPlayer.onStateChange((state) => {
			if (state === PlayerState.PLAYING) {
				if (syncInterval === null) {
					syncInterval = window.setInterval(updatePlayhead, SYNC_POLL_MS);
				}
			} else {
				if (syncInterval !== null) {
					window.clearInterval(syncInterval);
					syncInterval = null;
				}
				updatePlayhead();
			}
		});
	});
}

// ─── Inline markdown rendering ───────────────────────────────────────

/**
 * Inline regex for Obsidian-flavored markdown (wikilinks, bold, italic).
 * Groups: 1 = wiki target, 2 = wiki display, 3 = bold, 4 = italic.
 */
const PUB_GROUP_WIKI_TARGET = 1;
const PUB_GROUP_WIKI_DISPLAY = 2;
const PUB_GROUP_BOLD = 3;
const PUB_GROUP_ITALIC = 4;

const PUB_INLINE_PATTERN = new RegExp(
	[
		/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/.source,
		/\*\*([^*]+?)\*\*/.source,
		/\*([^*]+?)\*/.source,
	].join("|"),
	"g",
);

const WIKILINK_CLASS = "internal-link";

/**
 * Renders inline Obsidian markdown into a container element using DOM
 * methods. Used by the publish widget to display formatted highlight text.
 */
function renderPublishInlineMarkdown(container: HTMLElement, markdown: string): void {
	let lastIndex = 0;
	PUB_INLINE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = PUB_INLINE_PATTERN.exec(markdown)) !== null) {
		if (match.index > lastIndex) {
			container.appendChild(document.createTextNode(markdown.slice(lastIndex, match.index)));
		}

		if (match[PUB_GROUP_WIKI_TARGET] !== undefined) {
			const target = match[PUB_GROUP_WIKI_TARGET];
			const display = match[PUB_GROUP_WIKI_DISPLAY] ?? target;
			const link = document.createElement("a");
			link.className = WIKILINK_CLASS;
			link.setAttribute("data-href", target);
			link.textContent = display;
			container.appendChild(link);
		} else if (match[PUB_GROUP_BOLD] !== undefined) {
			const strong = document.createElement("strong");
			strong.textContent = match[PUB_GROUP_BOLD];
			container.appendChild(strong);
		} else if (match[PUB_GROUP_ITALIC] !== undefined) {
			const em = document.createElement("em");
			em.textContent = match[PUB_GROUP_ITALIC];
			container.appendChild(em);
		}

		lastIndex = match.index + match[0].length;
	}

	if (lastIndex < markdown.length) {
		container.appendChild(document.createTextNode(markdown.slice(lastIndex)));
	}
}

// ─── Item renderers ──────────────────────────────────────────────────

function renderHighlightItem(
	parent: HTMLElement,
	highlight: Highlight,
	ytPlayer: {player: SimplePlayer | null},
): void {
	const itemEl = document.createElement("div");
	itemEl.className = `${CLS.item} ${CLS.itemHighlight}`;
	parent.appendChild(itemEl);

	// Timestamp range: "1:23 – 1:45"
	const tsEl = document.createElement("span");
	tsEl.className = `${CLS.timestamp} ${CLS.timestampRange}`;
	tsEl.textContent = `${secondsToTimestamp(highlight.startTime)} – ${secondsToTimestamp(highlight.endTime)}`;
	tsEl.addEventListener("click", () => {
		ytPlayer.player?.seekTo(highlight.startTime, true);
	});
	itemEl.appendChild(tsEl);

	// Highlighted text with ==marks==, supporting inline markdown.
	const textEl = document.createElement("span");
	textEl.className = CLS.highlightText;
	const mark = document.createElement("mark");
	// displayText is string[] (per-entry); join with space for display.
	const hasCustomText = highlight.displayText !== undefined && highlight.displayText.length > 0;
	const displayText = hasCustomText
		? highlight.displayText!.join(" ")
		: highlight.text;
	if (hasCustomText) {
		renderPublishInlineMarkdown(mark, displayText);
	} else {
		mark.textContent = displayText;
	}
	textEl.appendChild(mark);
	itemEl.appendChild(textEl);
}

function renderAnnotationItem(
	parent: HTMLElement,
	annotation: Annotation,
	ytPlayer: {player: SimplePlayer | null},
): void {
	const itemEl = document.createElement("div");
	itemEl.className = `${CLS.item} ${CLS.itemAnnotation}`;
	parent.appendChild(itemEl);

	// Single timestamp.
	const tsEl = document.createElement("span");
	tsEl.className = CLS.timestamp;
	tsEl.textContent = secondsToTimestamp(annotation.timestamp);
	tsEl.addEventListener("click", () => {
		ytPlayer.player?.seekTo(annotation.timestamp, true);
	});
	itemEl.appendChild(tsEl);

	// Annotation text.
	const textEl = document.createElement("span");
	textEl.className = CLS.annotationText;
	textEl.textContent = annotation.text;
	itemEl.appendChild(textEl);
}

// ─── Registration ────────────────────────────────────────────────────

declare const publish: {
	registerMarkdownCodeBlockProcessor(
		language: string,
		handler: (source: string, el: HTMLElement, ctx: unknown) => Promise<void> | void,
	): void;
};

if (typeof publish !== "undefined" && publish.registerMarkdownCodeBlockProcessor) {
	publish.registerMarkdownCodeBlockProcessor(
		CODE_BLOCK_LANGUAGE,
		(source: string, el: HTMLElement) => {
			renderPublishWidget(source, el);
		},
	);
}
