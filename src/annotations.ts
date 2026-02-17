import type {Annotation} from "./types";
import type {VideoDataStore} from "./video-data-store";
import type {PlayerWrapper} from "./player";
import {secondsToTimestamp} from "./utils/time";

/** CSS class names used by the annotations UI. */
const CSS = {
	container: "yt-highlighter-annotations",
	item: "yt-highlighter-annotation",
	timestamp: "yt-highlighter-annotation-timestamp",
	text: "yt-highlighter-annotation-text",
	deleteButton: "yt-highlighter-annotation-delete",
	addButton: "yt-highlighter-annotation-add",
	input: "yt-highlighter-annotation-input",
	toolbar: "yt-highlighter-toolbar",
} as const;

/** Prefix for generating unique annotation IDs. */
const ANNOTATION_ID_PREFIX = "a";

/**
 * Renders the annotations panel and toolbar below the transcript.
 * - Shows existing annotations sorted by timestamp.
 * - "Add annotation" button creates a note at the current playback time.
 * - Each annotation can be edited inline or deleted.
 */
export function createAnnotationsView(
	parentEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
): void {
	const toolbarEl = parentEl.createDiv({cls: CSS.toolbar});
	const annotationsEl = parentEl.createDiv({cls: CSS.container});

	// Add annotation button.
	const addButton = toolbarEl.createEl("button", {
		cls: CSS.addButton,
		text: "Add annotation",
	});

	addButton.addEventListener("click", () => {
		void player.getCurrentTime().then((currentTime) => {
			const annotation = createAnnotation(currentTime);
			store.get(videoId).annotations.push(annotation);
			store.requestSave(videoId);
			renderAnnotations(annotationsEl, videoId, store, player);
		});
	});

	// Render existing annotations.
	renderAnnotations(annotationsEl, videoId, store, player);
}

/** Renders all annotations sorted by timestamp. */
function renderAnnotations(
	containerEl: HTMLElement,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
): void {
	containerEl.empty();

	const annotations = store.get(videoId).annotations;
	if (annotations.length === 0) return;

	// Sort by timestamp for display (don't mutate the original array).
	const sorted = [...annotations].sort((a, b) => a.timestamp - b.timestamp);

	for (const annotation of sorted) {
		renderAnnotationItem(containerEl, annotation, videoId, store, player);
	}
}

/** Renders a single annotation item with timestamp, editable text, and delete button. */
function renderAnnotationItem(
	containerEl: HTMLElement,
	annotation: Annotation,
	videoId: string,
	store: VideoDataStore,
	player: PlayerWrapper,
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
			renderAnnotations(containerEl.parentElement ?? containerEl, videoId, store, player);
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
