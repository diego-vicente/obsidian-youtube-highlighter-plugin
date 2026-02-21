import {Platform} from "obsidian";
import type {Annotation} from "./types";
import type {VideoDataStore} from "./video-data-store";
import type {PlayerWrapper} from "./player";
import type {HighlightHandle} from "./highlights";
import type {TranscriptView} from "./transcript-view";
import {secondsToTimestamp} from "./utils/time";

/** CSS class names used by the annotations UI. */
const CSS = {
	container: "yt-highlighter-annotations",
	item: "yt-highlighter-annotation",
	timestamp: "yt-highlighter-annotation-timestamp",
	text: "yt-highlighter-annotation-text",
	deleteButton: "yt-highlighter-annotation-delete",
	addButton: "yt-highlighter-annotation-add",
	goToFurthestButton: "yt-highlighter-goto-furthest",
	highlightButton: "yt-highlighter-highlight-button",
	highlightButtonActive: "yt-highlighter-highlight-button--active",
	breakButton: "yt-highlighter-break-button",
	breakButtonActive: "yt-highlighter-break-button--active",
	displayModeButton: "yt-highlighter-display-mode-button",
	displayModeButtonActive: "yt-highlighter-display-mode-button--active",
	autoScrollButton: "yt-highlighter-autoscroll-button",
	autoScrollButtonActive: "yt-highlighter-autoscroll-button--active",
	settingsButton: "yt-highlighter-settings-button",
	input: "yt-highlighter-annotation-input",
	toolbar: "yt-highlighter-toolbar",
} as const;

/** Prefix for generating unique annotation IDs. */
const ANNOTATION_ID_PREFIX = "a";

/** Handle returned by createAnnotationsView for external updates. */
export interface AnnotationsViewHandle {
	/** Update the "Go to" button label with the current furthest-watched time. */
	updateFurthestButton(): void;
}

/**
 * Renders the annotations panel and toolbar below the transcript.
 * - Shows existing annotations sorted by timestamp.
 * - "Add annotation" button creates a note at the current playback time.
 * - On mobile, a "Highlight" button applies a highlight to the current
 *   text selection in the transcript.
 * - Each annotation can be edited inline or deleted.
 */
export function createAnnotationsView(
	parentEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
	highlightHandle?: HighlightHandle,
	onSettingsClick?: () => void,
	transcriptView?: TranscriptView,
	onBreakToggle?: (entryIndex: number, charOffset: number) => void,
	onDisplayModeToggle?: () => void,
	onAnnotationChange?: () => void,
): AnnotationsViewHandle {
	const toolbarEl = parentEl.createDiv({cls: CSS.toolbar});
	const annotationsEl = parentEl.createDiv({cls: CSS.container});

	/**
	 * Buttons that are only meaningful in paragraph mode. These get
	 * disabled when the user switches to subtitle mode.
	 */
	const paragraphModeButtons: HTMLButtonElement[] = [];

	/**
	 * Buttons that should be completely hidden in subtitle mode.
	 */
	const paragraphModeHiddenButtons: HTMLButtonElement[] = [];

	// ── Display mode toggle button (first in toolbar) ────────────────

	if (transcriptView && onDisplayModeToggle) {
		/** U+00B6 pilcrow ¶ — shown when in paragraph mode (click to switch to subtitles). */
		const ICON_PARAGRAPHS = "\u00B6";
		/** U+2261 triple bar ≡ — shown when in subtitle mode (click to switch to paragraphs). */
		const ICON_SUBTITLES = "\u2261";

		const displayModeButton = toolbarEl.createEl("button", {
			cls: CSS.displayModeButton,
			text: ICON_PARAGRAPHS,
			attr: {"aria-label": "Toggle subtitle view"},
		});

		displayModeButton.addEventListener("click", () => {
			onDisplayModeToggle();
			const isSubtitleMode = transcriptView.displayMode === "subtitles";
			displayModeButton.textContent = isSubtitleMode ? ICON_SUBTITLES : ICON_PARAGRAPHS;
			if (isSubtitleMode) {
				displayModeButton.addClass(CSS.displayModeButtonActive);
			} else {
				displayModeButton.removeClass(CSS.displayModeButtonActive);
			}
			// Disable paragraph-only buttons in subtitle mode.
			for (const btn of paragraphModeButtons) {
				btn.disabled = isSubtitleMode;
			}
			// Hide paragraph-only buttons in subtitle mode.
			for (const btn of paragraphModeHiddenButtons) {
				btn.style.display = isSubtitleMode ? "none" : "";
			}
		});
	}

	// ── Auto-scroll toggle button ────────────────────────────────────

	if (transcriptView) {
		const autoScrollButton = toolbarEl.createEl("button", {
			cls: `${CSS.autoScrollButton} ${CSS.autoScrollButtonActive}`,
			// U+21E3 downwards dashed arrow ⇣
			text: "\u21E3",
			attr: {"aria-label": "Toggle auto-scroll"},
		});

		autoScrollButton.addEventListener("click", () => {
			transcriptView.enableAutoScroll();
		});

		// React to auto-scroll changes (e.g. user scrolled during playback).
		transcriptView.onAutoScrollChange((enabled) => {
			if (enabled) {
				autoScrollButton.addClass(CSS.autoScrollButtonActive);
			} else {
				autoScrollButton.removeClass(CSS.autoScrollButtonActive);
			}
		});
	}

	// ── Highlight button (mobile only) ───────────────────────────────

	if (Platform.isMobile && highlightHandle) {
		const highlightButton = toolbarEl.createEl("button", {
			cls: CSS.highlightButton,
			text: "Highlight",
		});

		// Start disabled; enabled when a text selection is detected.
		highlightButton.disabled = true;

		highlightHandle.onSelectionAvailabilityChange((available) => {
			highlightButton.disabled = !available;
			if (available) {
				highlightButton.addClass(CSS.highlightButtonActive);
			} else {
				highlightButton.removeClass(CSS.highlightButtonActive);
			}
		});

		highlightButton.addEventListener("click", () => {
			highlightHandle.highlightStashedSelection();
		});

		paragraphModeButtons.push(highlightButton);
	}

	// ── Add annotation button ────────────────────────────────────────

	const addButton = toolbarEl.createEl("button", {
		cls: CSS.addButton,
		text: "Add annotation",
	});

	addButton.addEventListener("click", () => {
		void player.getCurrentTime().then((currentTime) => {
			const annotation = createAnnotation(currentTime);
			store.get(videoId).annotations.push(annotation);
			store.requestSave(videoId);
			renderAnnotations(annotationsEl, videoId, store, player, onAnnotationChange);
			onAnnotationChange?.();
		});
	});

	// ── "Go to furthest" button ─────────────────────────────────────

	/**
	 * If the player is within this many seconds of the furthest-watched
	 * point, the button is hidden (the user is already "there").
	 */
	const NEAR_FURTHEST_THRESHOLD_SECONDS = 3;

	const goToFurthestButton = toolbarEl.createEl("button", {
		cls: CSS.goToFurthestButton,
		text: "",
		attr: {"aria-label": "Seek to furthest watched position"},
	});
	// Hidden by default until we know there's a meaningful furthest point.
	goToFurthestButton.style.display = "none";

	goToFurthestButton.addEventListener("click", () => {
		const furthest = store.get(videoId).furthestWatched ?? 0;
		if (furthest > 0) {
			void player.seekTo(furthest);
		}
	});

	/**
	 * Updates the button label and visibility. Called on every progress
	 * bar tick so the button hides when the player reaches the furthest
	 * point and reappears when the user seeks away.
	 */
	function updateFurthestButton(): void {
		const furthest = store.get(videoId).furthestWatched ?? 0;
		if (furthest <= 0) {
			goToFurthestButton.style.display = "none";
			return;
		}

		void player.getCurrentTime().then((currentTime) => {
			const nearFurthest = Math.abs(currentTime - furthest) < NEAR_FURTHEST_THRESHOLD_SECONDS;
			goToFurthestButton.style.display = nearFurthest ? "none" : "";
			goToFurthestButton.textContent = `Go to ${secondsToTimestamp(furthest)}`;
		});
	}

	// Run once on load to set initial state.
	updateFurthestButton();

	// ── Break mode toggle button ─────────────────────────────────────

	if (transcriptView && onBreakToggle) {
		const breakButton = toolbarEl.createEl("button", {
			cls: CSS.breakButton,
			text: "Break",
			attr: {"aria-label": "Toggle break mode"},
		});

		// Wire the break handler into the transcript view.
		transcriptView.setBreakToggleHandler(onBreakToggle);

		breakButton.addEventListener("click", () => {
			transcriptView.breakMode = !transcriptView.breakMode;
			if (transcriptView.breakMode) {
				breakButton.addClass(CSS.breakButtonActive);
				transcriptView.containerEl.addClass("yt-highlighter-transcript--break-mode");
			} else {
				breakButton.removeClass(CSS.breakButtonActive);
				transcriptView.containerEl.removeClass("yt-highlighter-transcript--break-mode");
			}
		});

		paragraphModeButtons.push(breakButton);
		paragraphModeHiddenButtons.push(breakButton);
	}

	// ── Transcript settings button ───────────────────────────────────

	if (onSettingsClick) {
		const settingsButton = toolbarEl.createEl("button", {
			cls: CSS.settingsButton,
			// U+2699 gear character
			text: "\u2699",
			attr: {
				"aria-label": "Transcript settings",
			},
		});

		settingsButton.addEventListener("click", onSettingsClick);
		paragraphModeButtons.push(settingsButton);
	}

	// Render existing annotations.
	renderAnnotations(annotationsEl, videoId, store, player, onAnnotationChange);

	return {updateFurthestButton};
}

/** Renders all annotations sorted by timestamp. */
function renderAnnotations(
	containerEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
	onAnnotationChange?: () => void,
): void {
	containerEl.empty();

	const annotations = store.get(videoId).annotations;
	if (annotations.length === 0) return;

	// Sort by timestamp for display (don't mutate the original array).
	const sorted = [...annotations].sort((a, b) => a.timestamp - b.timestamp);

	for (const annotation of sorted) {
		renderAnnotationItem(containerEl, annotation, videoId, store, player, onAnnotationChange);
	}
}

/** Renders a single annotation item with timestamp, editable text, and delete button. */
function renderAnnotationItem(
	containerEl: HTMLElement,
	annotation: Annotation,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
	onAnnotationChange?: () => void,
): void {
	const itemEl = containerEl.createDiv({cls: CSS.item});

	// Clickable timestamp — seeks to that time.
	const timestampEl = itemEl.createSpan({
		cls: CSS.timestamp,
		text: secondsToTimestamp(annotation.timestamp),
	});
	timestampEl.addEventListener("click", () => {
		void player.seekTo(annotation.timestamp);
	});

	// Editable text input.
	const inputEl = itemEl.createEl("input", {
		cls: CSS.input,
		type: "text",
		value: annotation.text,
		attr: {placeholder: "Add a note..."},
	});

	inputEl.addEventListener("change", () => {
		annotation.text = inputEl.value;
		store.requestSave(videoId);
	});

	// Auto-focus if the annotation was just created (empty text).
	if (!annotation.text) {
		window.setTimeout(() => inputEl.focus(), 0);
	}

	// Delete button.
	const deleteEl = itemEl.createSpan({
		cls: CSS.deleteButton,
		text: "\u00D7", // × character
	});
	deleteEl.addEventListener("click", () => {
		const data = store.get(videoId);
		const index = data.annotations.findIndex(a => a.id === annotation.id);
		if (index !== -1) {
			data.annotations.splice(index, 1);
			store.requestSave(videoId);
			renderAnnotations(containerEl.parentElement ?? containerEl, videoId, store, player, onAnnotationChange);
			onAnnotationChange?.();
		}
	});
}

function createAnnotation(timestamp: number): Annotation {
	return {
		id: `${ANNOTATION_ID_PREFIX}${Date.now()}`,
		timestamp,
		text: "",
	};
}
