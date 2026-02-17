import {Editor, Modal, App, Setting} from "obsidian";
import {CODE_BLOCK_LANGUAGE} from "./types";
import type YouTubeHighlighterPlugin from "./main";

/**
 * Registers the "Insert YouTube highlighter" editor command.
 * Opens a modal prompting for a YouTube URL, then inserts a
 * youtube-highlights code block at the cursor position.
 */
export function registerInsertCommand(plugin: YouTubeHighlighterPlugin): void {
	plugin.addCommand({
		id: "insert-video",
		name: "Insert video",
		editorCallback: (editor: Editor) => {
			new InsertVideoModal(plugin.app, editor).open();
		},
	});
}

/**
 * Regex patterns that match common YouTube URL formats and capture the video ID.
 * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/embed/, youtube.com/v/
 */
const YOUTUBE_URL_PATTERNS: RegExp[] = [
	/(?:youtube\.com\/watch\?.*v=)([A-Za-z0-9_-]{11})/,
	/(?:youtu\.be\/)([A-Za-z0-9_-]{11})/,
	/(?:youtube\.com\/embed\/)([A-Za-z0-9_-]{11})/,
	/(?:youtube\.com\/v\/)([A-Za-z0-9_-]{11})/,
];

/** Expected length of a YouTube video ID. */
const VIDEO_ID_LENGTH = 11;
const RAW_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/** Extracts a YouTube video ID from a URL or raw ID string. Returns null if invalid. */
export function extractVideoId(input: string): string | null {
	const trimmed = input.trim();

	// Try raw 11-character video ID first.
	if (trimmed.length === VIDEO_ID_LENGTH && RAW_VIDEO_ID_PATTERN.test(trimmed)) {
		return trimmed;
	}

	// Try each URL pattern.
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		const match = trimmed.match(pattern);
		if (match?.[1]) {
			return match[1];
		}
	}

	return null;
}

/** Builds the code block string to insert into the editor. */
function buildCodeBlock(videoId: string): string {
	const data = {
		videoId,
		title: "",
	};
	const json = JSON.stringify(data, null, 2);
	return `\`\`\`${CODE_BLOCK_LANGUAGE}\n${json}\n\`\`\`\n`;
}

/** Modal that prompts the user for a YouTube URL and inserts the code block. */
class InsertVideoModal extends Modal {
	private editor: Editor;
	private inputValue = "";

	constructor(app: App, editor: Editor) {
		super(app);
		this.editor = editor;
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();

		contentEl.createEl("h3", {text: "Insert YouTube highlighter"});

		new Setting(contentEl)
			.setName("YouTube URL or video ID")
			.addText(text => {
				text.setPlaceholder("https://youtube.com/watch?v=... or video ID");
				text.onChange(value => {
					this.inputValue = value;
				});
				// Submit on Enter key.
				text.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
					if (e.key === "Enter") {
						e.preventDefault();
						this.submit();
					}
				});
				// Focus the input immediately.
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.addButton(button => {
				button.setButtonText("Insert");
				button.setCta();
				button.onClick(() => this.submit());
			});
	}

	private submit(): void {
		const videoId = extractVideoId(this.inputValue);
		if (!videoId) {
			// Re-render with error hint — keep modal open.
			const existing = this.contentEl.querySelector(".yt-highlighter-insert-error");
			if (!existing) {
				this.contentEl.createEl("p", {
					text: "Could not extract a video ID. Enter a YouTube URL or 11-character video ID.",
					cls: "yt-highlighter-insert-error",
				});
			}
			return;
		}

		const codeBlock = buildCodeBlock(videoId);
		this.editor.replaceSelection(codeBlock);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
