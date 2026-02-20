import {App, Modal, Notice, Setting} from "obsidian";
import type {TranscriptDisplaySettings, SeparatorRule} from "./types";
import {DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS, createEmptySeparatorRule} from "./types";

/** CSS class names for the modal. */
const CSS = {
	modal: "yt-highlighter-transcript-settings-modal",
	separatorList: "yt-highlighter-separator-list",
	separatorRow: "yt-highlighter-separator-row",
	separatorInput: "yt-highlighter-separator-input",
	separatorToggle: "yt-highlighter-separator-toggle",
	separatorDelete: "yt-highlighter-separator-delete",
	separatorLabel: "yt-highlighter-separator-label",
	regexError: "yt-highlighter-regex-error",
	addSeparator: "yt-highlighter-add-separator",
} as const;

/**
 * Modal for editing per-video transcript display settings.
 * Supports multiple separator rules, each with:
 *   - Pattern (plain text or regex)
 *   - Regex toggle
 *   - Visibility toggle (show/hide the separator text in transcript)
 *   - Delete button
 *
 * Calls `onSave` with the updated settings when the user confirms.
 */
export class TranscriptSettingsModal extends Modal {
	private separators: SeparatorRule[];
	private onSave: (settings: TranscriptDisplaySettings) => void;

	constructor(
		app: App,
		currentSettings: TranscriptDisplaySettings | undefined,
		onSave: (settings: TranscriptDisplaySettings) => void,
	) {
		super(app);
		const source = currentSettings ?? DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
		// Deep copy each rule to avoid mutating the original.
		this.separators = source.separators.map(r => ({...r}));
		this.onSave = onSave;
	}

	onOpen(): void {
		this.render();
	}

	/** Full render / re-render of the modal content. */
	private render(): void {
		const {contentEl} = this;
		contentEl.addClass(CSS.modal);
		contentEl.empty();

		contentEl.createEl("h3", {text: "Transcript display settings"});
		contentEl.createEl("p", {
			text: "Configure how transcript text is grouped into paragraphs for this video.",
			cls: "setting-item-description",
		});

		// ── Separator list ───────────────────────────────────────────

		contentEl.createEl("h4", {text: "Paragraph separators"});

		const listEl = contentEl.createDiv({cls: CSS.separatorList});

		for (let i = 0; i < this.separators.length; i++) {
			this.renderSeparatorRow(listEl, i);
		}

		// Error container for regex validation (shared across all rows).
		contentEl.createDiv({cls: CSS.regexError});

		// Add separator button.
		new Setting(contentEl)
			.addButton(button => {
				button
					.setButtonText("Add separator")
					.setClass(CSS.addSeparator)
					.onClick(() => {
						this.separators.push(createEmptySeparatorRule());
						this.render();
					});
			});

		// ── Actions ──────────────────────────────────────────────────

		const buttonRow = new Setting(contentEl);

		buttonRow.addButton(button => {
			button
				.setButtonText("Reset to defaults")
				.onClick(() => {
					const defaults = DEFAULT_TRANSCRIPT_DISPLAY_SETTINGS;
					this.onSave({
						separators: defaults.separators.map(r => ({...r})),
					});
					this.close();
				});
		});

		buttonRow.addButton(button => {
			button
				.setButtonText("Save")
				.setCta()
				.onClick(() => {
					if (!this.validateAll()) return;
					this.onSave({
						// Filter out separators with empty patterns.
						separators: this.separators.filter(r => r.pattern.trim()),
					});
					this.close();
				});
		});
	}

	/**
	 * Renders a single separator row with:
	 * - Text input for the pattern
	 * - "Regex" toggle
	 * - "Hide" toggle
	 * - Delete button
	 */
	private renderSeparatorRow(listEl: HTMLElement, index: number): void {
		const rule = this.separators[index];
		if (!rule) return;

		const rowEl = listEl.createDiv({cls: CSS.separatorRow});

		// Pattern input.
		const inputEl = rowEl.createEl("input", {
			cls: CSS.separatorInput,
			type: "text",
			value: rule.pattern,
			attr: {placeholder: "Separator pattern..."},
		});
		inputEl.addEventListener("input", () => {
			rule.pattern = inputEl.value;
			this.validateAllInline();
		});

		// Regex toggle.
		const regexLabel = rowEl.createEl("label", {cls: CSS.separatorLabel});
		const regexCheckbox = regexLabel.createEl("input", {
			type: "checkbox",
			cls: CSS.separatorToggle,
		});
		regexCheckbox.checked = rule.isRegex;
		regexLabel.appendText("Regex");
		regexCheckbox.addEventListener("change", () => {
			rule.isRegex = regexCheckbox.checked;
			this.validateAllInline();
		});

		// Hidden toggle.
		const hideLabel = rowEl.createEl("label", {cls: CSS.separatorLabel});
		const hideCheckbox = hideLabel.createEl("input", {
			type: "checkbox",
			cls: CSS.separatorToggle,
		});
		hideCheckbox.checked = rule.hidden;
		hideLabel.appendText("Hide");
		hideCheckbox.addEventListener("change", () => {
			rule.hidden = hideCheckbox.checked;
		});

		// Delete button.
		const deleteEl = rowEl.createSpan({
			cls: CSS.separatorDelete,
			text: "\u00D7", // × character
		});
		deleteEl.addEventListener("click", () => {
			this.separators.splice(index, 1);
			this.render();
		});
	}

	/** Validates all regex patterns. Shows Notice on failure. Returns true if valid. */
	private validateAll(): boolean {
		for (const rule of this.separators) {
			if (rule.isRegex && rule.pattern) {
				try {
					new RegExp(rule.pattern);
				} catch (e) {
					new Notice(`Invalid regex "${rule.pattern}": ${(e as Error).message}`);
					return false;
				}
			}
		}
		return true;
	}

	/** Inline validation: shows/hides error for any invalid regex. */
	private validateAllInline(): void {
		const errorEl = this.contentEl.querySelector(`.${CSS.regexError}`);
		if (!errorEl) return;

		for (const rule of this.separators) {
			if (rule.isRegex && rule.pattern) {
				try {
					new RegExp(rule.pattern);
				} catch (e) {
					errorEl.textContent = `Invalid regex "${rule.pattern}": ${(e as Error).message}`;
					return;
				}
			}
		}
		errorEl.textContent = "";
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
