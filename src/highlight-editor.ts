import {App, Modal, Setting} from "obsidian";
import type {Highlight, TranscriptEntry} from "./types";
import type {VideoDataStore} from "./video-data-store";
import {getOriginalTextPerEntry, hasCustomDisplayText} from "./utils/highlight-text";
import {renderInlineMarkdown} from "./utils/inline-markdown";
import {secondsToTimestamp} from "./utils/time";

// ─── CSS class names ─────────────────────────────────────────────────

const CSS = {
	modal: "yt-highlighter-editor-modal",
	entryRow: "yt-highlighter-editor-entry",
	entryTimestamp: "yt-highlighter-editor-entry-timestamp",
	entryOriginal: "yt-highlighter-editor-entry-original",
	entryInput: "yt-highlighter-editor-entry-input",
	preview: "yt-highlighter-editor-preview",
	previewLabel: "yt-highlighter-editor-preview-label",
	previewContent: "yt-highlighter-editor-preview-content",
	hint: "yt-highlighter-editor-hint",
} as const;

/** Debounce delay (ms) for updating the live preview while typing. */
const PREVIEW_DEBOUNCE_MS = 150;

/**
 * Result of the editor modal interaction.
 * - "saved": user confirmed edits (text may or may not have changed)
 * - "deleted": user chose to delete the highlight
 * - "cancelled": user dismissed without saving (closed the modal)
 */
export type HighlightEditorResult = "saved" | "deleted" | "cancelled";

/**
 * Opens an Obsidian Modal for editing the display text of a highlight.
 *
 * The modal shows one text input per transcript entry spanned by the
 * highlight. Each input is pre-filled with the current displayText
 * (or the original transcript text if not yet edited). A live preview
 * renders the combined result with inline markdown formatting.
 *
 * Returns a promise that resolves with the outcome of the interaction.
 */
export function showHighlightEditor(
	app: App,
	highlight: Highlight,
	entries: TranscriptEntry[],
	videoId: string,
	store: VideoDataStore,
): Promise<HighlightEditorResult> {
	return new Promise<HighlightEditorResult>((resolve) => {
		const modal = new HighlightEditorModal(
			app, highlight, entries, videoId, store,
			(result) => resolve(result),
		);
		modal.open();
	});
}

/**
 * Modal for editing the display text of a highlight, one field per
 * transcript entry. Follows the same pattern as TranscriptSettingsModal.
 */
class HighlightEditorModal extends Modal {
	private highlight: Highlight;
	private entries: TranscriptEntry[];
	private videoId: string;
	private store: VideoDataStore;
	private onResult: (result: HighlightEditorResult) => void;

	/** Working copy of per-entry display text. */
	private editTexts: string[];
	/** Original text per entry (from the transcript). */
	private originalTexts: string[];

	private resolved = false;

	constructor(
		app: App,
		highlight: Highlight,
		entries: TranscriptEntry[],
		videoId: string,
		store: VideoDataStore,
		onResult: (result: HighlightEditorResult) => void,
	) {
		super(app);
		this.highlight = highlight;
		this.entries = entries;
		this.videoId = videoId;
		this.store = store;
		this.onResult = onResult;

		// Compute original text per entry from the transcript data.
		this.originalTexts = getOriginalTextPerEntry(highlight, entries);

		// Initialize editing texts: use existing displayText if present,
		// otherwise fall back to original transcript text.
		if (highlight.displayText && highlight.displayText.length > 0) {
			// Clone and pad/trim to match entry count.
			const entryCount = highlight.endEntryIndex - highlight.startEntryIndex + 1;
			this.editTexts = [];
			for (let i = 0; i < entryCount; i++) {
				this.editTexts.push(
					highlight.displayText[i] ?? this.originalTexts[i] ?? "",
				);
			}
		} else {
			this.editTexts = [...this.originalTexts];
		}
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const {contentEl} = this;
		contentEl.addClass(CSS.modal);
		contentEl.empty();

		contentEl.createEl("h3", {text: "Edit highlight text"});

		// ── Hint ─────────────────────────────────────────────────────
		contentEl.createEl("p", {
			text: "Edit the display text for each transcript segment. Supports **bold**, *italic*, [[wikilinks]].",
			cls: CSS.hint,
		});

		// ── Per-entry rows ───────────────────────────────────────────
		const entryCount = this.highlight.endEntryIndex - this.highlight.startEntryIndex + 1;

		for (let i = 0; i < entryCount; i++) {
			this.renderEntryRow(contentEl, i);
		}

		// ── Live preview ─────────────────────────────────────────────
		const previewEl = contentEl.createDiv({cls: CSS.preview});
		const previewLabelEl = previewEl.createSpan({cls: CSS.previewLabel});
		previewLabelEl.textContent = "Preview:";
		const previewContentEl = previewEl.createSpan({cls: CSS.previewContent});

		this.updatePreview(previewContentEl);

		// Store reference for input handlers.
		(this as unknown as {_previewEl: HTMLElement})._previewEl = previewContentEl;

		// ── Actions ──────────────────────────────────────────────────
		const actionRow = new Setting(contentEl);

		actionRow.addButton(button => {
			button
				.setButtonText("Reset to original")
				.setDisabled(!hasCustomDisplayText(this.highlight))
				.onClick(() => {
					this.editTexts = [...this.originalTexts];
					this.render();
				});
		});

		actionRow.addButton(button => {
			button
				.setButtonText("Delete highlight")
				.setWarning()
				.onClick(() => {
					this.finish("deleted");
				});
		});

		actionRow.addButton(button => {
			button
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					this.save();
					this.finish("saved");
				});
		});
	}

	/**
	 * Renders a single entry row: timestamp label, original text, and
	 * an editable input field.
	 */
	private renderEntryRow(parentEl: HTMLElement, index: number): void {
		const entryIndex = this.highlight.startEntryIndex + index;
		const entry = this.entries[entryIndex];
		const timestamp = entry ? secondsToTimestamp(entry.offset) : "??:??";
		const originalText = this.originalTexts[index] ?? "";

		const rowEl = parentEl.createDiv({cls: CSS.entryRow});

		// Timestamp badge.
		rowEl.createSpan({
			cls: CSS.entryTimestamp,
			text: timestamp,
		});

		// Original text (muted, for reference).
		rowEl.createSpan({
			cls: CSS.entryOriginal,
			text: originalText,
		});

		// Editable input.
		const inputEl = rowEl.createEl("input", {
			cls: CSS.entryInput,
			type: "text",
			value: this.editTexts[index] ?? "",
			attr: {placeholder: originalText},
		});

		let previewTimeout: number | null = null;

		inputEl.addEventListener("input", () => {
			this.editTexts[index] = inputEl.value;

			if (previewTimeout !== null) {
				window.clearTimeout(previewTimeout);
			}
			previewTimeout = window.setTimeout(() => {
				const previewEl = (this as unknown as {_previewEl: HTMLElement})._previewEl;
				if (previewEl) {
					this.updatePreview(previewEl);
				}
			}, PREVIEW_DEBOUNCE_MS);
		});

		// Focus the first input.
		if (index === 0) {
			window.setTimeout(() => inputEl.focus(), 0);
		}
	}

	/** Updates the combined live preview from all entry inputs. */
	private updatePreview(previewEl: HTMLElement): void {
		while (previewEl.firstChild) {
			previewEl.removeChild(previewEl.firstChild);
		}
		const combined = this.editTexts
			.filter(t => t.length > 0)
			.join(" ");
		renderInlineMarkdown(previewEl, combined);
	}

	/** Saves the edited texts to the highlight in the data store. */
	private save(): void {
		// Check if any text differs from the original.
		const hasChanges = this.editTexts.some(
			(text, i) => text !== (this.originalTexts[i] ?? ""),
		);

		if (hasChanges) {
			this.highlight.displayText = [...this.editTexts];
			this.store.requestSave(this.videoId);
		} else {
			// All texts match originals — clear displayText.
			if (this.highlight.displayText !== undefined) {
				delete this.highlight.displayText;
				this.store.requestSave(this.videoId);
			}
		}
	}

	private finish(result: HighlightEditorResult): void {
		if (this.resolved) return;
		this.resolved = true;
		this.close();
		this.onResult(result);
	}

	onClose(): void {
		this.contentEl.empty();
		// If the user closed the modal without explicitly saving or deleting,
		// treat it as cancelled.
		if (!this.resolved) {
			this.resolved = true;
			this.onResult("cancelled");
		}
	}
}
