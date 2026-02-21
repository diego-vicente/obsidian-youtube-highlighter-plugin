import type {PlayerWrapper} from "./player";
import {PlayerState} from "./player";
import type {Highlight, Annotation} from "./types";
import type {VideoDataStore} from "./video-data-store";

// ─── CSS class names ─────────────────────────────────────────────────

const CSS = {
	container: "yt-highlighter-progress-bar",
	track: "yt-highlighter-progress-track",
	furthestWatched: "yt-highlighter-progress-furthest",
	highlightRange: "yt-highlighter-progress-highlight",
	annotationMarker: "yt-highlighter-progress-annotation",
	playhead: "yt-highlighter-progress-playhead",
} as const;

// ─── Timing constants ────────────────────────────────────────────────

/** How often (ms) we poll the player to update the progress bar while playing. */
const POLL_INTERVAL_MS = 250;

/** Minimum duration (seconds) before the bar becomes functional. */
const MIN_DURATION_SECONDS = 1;

// ─── Public interface ────────────────────────────────────────────────

export interface ProgressBar {
	/** The root DOM element for the progress bar. */
	containerEl: HTMLElement;
	/**
	 * Refresh the highlight ranges and annotation markers from current data.
	 * Call after highlights or annotations change.
	 */
	updateMarkers(): void;
	/** Start polling the player for playhead / furthest-watched updates. */
	startSync(): void;
	/** Stop polling (e.g. when the widget is destroyed). */
	stopSync(): void;
}

/**
 * Creates a slim progress bar element and inserts it into `parentEl`.
 *
 * Layers (bottom to top):
 * 1. Track background (full width)
 * 2. Furthest-watched fill (dim accent, 0 → high-water mark)
 * 3. Highlight ranges (colored blocks for each highlight's time span)
 * 4. Annotation markers (thin vertical lines at each annotation time)
 * 5. Playhead (current position indicator)
 *
 * The bar is clickable for seeking.
 */
export function createProgressBar(
	parentEl: HTMLElement,
	player: PlayerWrapper,
	videoId: string,
	store: VideoDataStore,
	onFurthestWatchedChange?: () => void,
): ProgressBar {
	// ── DOM structure ────────────────────────────────────────────────

	const containerEl = parentEl.createDiv({cls: CSS.container});
	const trackEl = containerEl.createDiv({cls: CSS.track});
	const furthestEl = trackEl.createDiv({cls: CSS.furthestWatched});
	const playheadEl = trackEl.createDiv({cls: CSS.playhead});

	// ── State ────────────────────────────────────────────────────────

	/** Cached video duration. 0 means "not yet known". */
	let videoDuration = 0;
	let pollInterval: number | null = null;

	// ── Helpers ──────────────────────────────────────────────────────

	/** Convert a time in seconds to a percentage of the video duration. */
	function toPercent(seconds: number): number {
		if (videoDuration <= MIN_DURATION_SECONDS) return 0;
		const percent = (seconds / videoDuration) * 100;
		return Math.max(0, Math.min(100, percent));
	}

	/**
	 * Renders highlight ranges and annotation markers from the current
	 * store data. Removes previous markers before re-rendering.
	 */
	function updateMarkers(): void {
		// Remove old markers (keep furthestEl and playheadEl).
		trackEl.querySelectorAll(
			`.${CSS.highlightRange}, .${CSS.annotationMarker}`,
		).forEach(el => el.remove());

		if (videoDuration <= MIN_DURATION_SECONDS) return;

		const userData = store.get(videoId);

		// Highlight ranges.
		for (const highlight of userData.highlights) {
			renderHighlightRange(highlight);
		}

		// Annotation markers.
		for (const annotation of userData.annotations) {
			renderAnnotationMarker(annotation);
		}
	}

	function renderHighlightRange(highlight: Highlight): void {
		const leftPercent = toPercent(highlight.startTime);
		const rightPercent = toPercent(highlight.endTime);
		// Ensure a minimum visible width so tiny highlights aren't invisible.
		const MIN_WIDTH_PERCENT = 0.3;
		const width = Math.max(rightPercent - leftPercent, MIN_WIDTH_PERCENT);

		const el = trackEl.createDiv({cls: CSS.highlightRange});
		el.style.left = `${leftPercent}%`;
		el.style.width = `${width}%`;
	}

	function renderAnnotationMarker(annotation: Annotation): void {
		const leftPercent = toPercent(annotation.timestamp);
		const el = trackEl.createDiv({cls: CSS.annotationMarker});
		el.style.left = `${leftPercent}%`;
	}

	// ── Playhead + furthest watched ─────────────────────────────────

	function updatePlayhead(currentTime: number): void {
		const percent = toPercent(currentTime);
		playheadEl.style.left = `${percent}%`;
	}

	function updateFurthestWatched(currentTime: number): void {
		const userData = store.get(videoId);
		const previousFurthest = userData.furthestWatched ?? 0;

		if (currentTime > previousFurthest) {
			userData.furthestWatched = currentTime;
			store.requestSave(videoId);
		}

		const furthest = Math.max(currentTime, previousFurthest);
		furthestEl.style.width = `${toPercent(furthest)}%`;

		// Always notify so the "Go to" button can show/hide based on
		// whether the player is near the furthest-watched point.
		onFurthestWatchedChange?.();
	}

	/**
	 * Single update tick: read current time, update playhead and
	 * furthest-watched fill.
	 */
	async function tick(): Promise<void> {
		// Lazily resolve duration on first tick (YouTube player may not
		// report it immediately).
		if (videoDuration <= MIN_DURATION_SECONDS) {
			videoDuration = await player.getDuration();
			if (videoDuration > MIN_DURATION_SECONDS) {
				// Duration now known — render markers that depend on it.
				updateMarkers();
				// Restore persisted furthest-watched.
				const saved = store.get(videoId).furthestWatched ?? 0;
				furthestEl.style.width = `${toPercent(saved)}%`;
			}
		}

		const currentTime = await player.getCurrentTime();
		updatePlayhead(currentTime);
		updateFurthestWatched(currentTime);
	}

	// ── Sync lifecycle ──────────────────────────────────────────────

	function startSync(): void {
		if (pollInterval !== null) return;
		pollInterval = window.setInterval(() => { void tick(); }, POLL_INTERVAL_MS);
	}

	function stopSync(): void {
		if (pollInterval !== null) {
			window.clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	// Start/stop based on player state.
	player.onStateChange((state) => {
		if (state === PlayerState.PLAYING) {
			startSync();
		} else {
			stopSync();
			// Do one final tick to capture the exact pause/end position.
			void tick();
		}
	});

	// ── Click-to-seek ───────────────────────────────────────────────

	containerEl.addEventListener("click", (event) => {
		if (videoDuration <= MIN_DURATION_SECONDS) return;

		const rect = containerEl.getBoundingClientRect();
		const clickX = event.clientX - rect.left;
		const fraction = clickX / rect.width;
		const seekTime = fraction * videoDuration;

		void player.seekTo(seekTime);
		updatePlayhead(seekTime);
	});

	// ── Initial render ──────────────────────────────────────────────

	// Try to get the duration immediately (may already be available).
	void player.ready.then(async () => {
		videoDuration = await player.getDuration();
		if (videoDuration > MIN_DURATION_SECONDS) {
			updateMarkers();
			const saved = store.get(videoId).furthestWatched ?? 0;
			furthestEl.style.width = `${toPercent(saved)}%`;
		}

		// Restore playhead to saved position.
		const savedPosition = store.get(videoId).playbackPosition ?? 0;
		updatePlayhead(savedPosition);
	});

	return {
		containerEl,
		updateMarkers,
		startSync,
		stopSync,
	};
}
