import {Plugin} from "obsidian";
import type {PluginSettings} from "./types";
import {DEFAULT_SETTINGS} from "./types";
import {YouTubeHighlighterSettingTab} from "./settings";
import {registerCodeBlockProcessor, registerPipExitListener} from "./code-block-processor";
import {registerInsertCommand} from "./insert-command";
import {registerExportCommand} from "./export";
import {registerPublishSync, flushAllPublishData} from "./publish-sync";
import {VideoDataStore} from "./video-data-store";

export default class YouTubeHighlighterPlugin extends Plugin {
	dataStore: VideoDataStore;

	/**
	 * Convenience accessor for plugin-wide settings.
	 * The canonical copy lives inside `dataStore.settings`.
	 */
	get settings(): PluginSettings {
		return this.dataStore.settings;
	}

	async onload() {
		this.dataStore = new VideoDataStore(this);
		await this.dataStore.initialize();

		registerCodeBlockProcessor(this);
		registerInsertCommand(this);
		registerExportCommand(this);
		registerPublishSync(this);
		registerPipExitListener(this);

		this.addSettingTab(new YouTubeHighlighterSettingTab(this.app, this));
	}

	onunload() {
		// Flush any pending publish data into code blocks before the
		// plugin is disabled or Obsidian is closed.
		void flushAllPublishData(this);

		// Ensure any pending debounced writes are flushed before the
		// plugin is disabled or Obsidian is closed. Without this, data
		// mutated in the last SAVE_DEBOUNCE_MS window would be lost.
		this.dataStore.flushPending();
	}

	/**
	 * Called by Obsidian when `data.json` is modified externally — e.g.
	 * by Obsidian Sync, iCloud, or another sync service. Re-reads the
	 * file and merges incoming changes with any unsaved local edits.
	 *
	 * @see https://docs.obsidian.md/Reference/TypeScript+API/Plugin/onExternalSettingsChange
	 */
	async onExternalSettingsChange(): Promise<void> {
		await this.dataStore.reloadFromDisk();
	}

	/**
	 * Persists the current settings (and all video data) to disk.
	 * Called by the settings tab after the user changes a value.
	 */
	async saveSettings(): Promise<void> {
		await this.dataStore.flush();
	}
}
