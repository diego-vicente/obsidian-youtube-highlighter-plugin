import {Plugin} from "obsidian";
import type {PluginSettings} from "./types";
import {DEFAULT_SETTINGS} from "./types";
import {YouTubeHighlighterSettingTab} from "./settings";
import {registerCodeBlockProcessor} from "./code-block-processor";
import {registerInsertCommand} from "./insert-command";
import {registerExportCommand} from "./export";
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

		this.addSettingTab(new YouTubeHighlighterSettingTab(this.app, this));
	}

	onunload() {
		// VideoDataStore has no persistent resources to clean up.
	}

	/**
	 * Persists the current settings (and all video data) to disk.
	 * Called by the settings tab after the user changes a value.
	 */
	async saveSettings(): Promise<void> {
		await this.dataStore.flush();
	}
}
