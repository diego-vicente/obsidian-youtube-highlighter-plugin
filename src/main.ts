import {Plugin} from "obsidian";
import {DEFAULT_SETTINGS, YouTubeHighlighterSettings, YouTubeHighlighterSettingTab} from "./settings";
import {registerCodeBlockProcessor} from "./code-block-processor";
import {registerInsertCommand} from "./insert-command";
import {registerExportCommand} from "./export";
import {VideoDataStore} from "./video-data-store";

export default class YouTubeHighlighterPlugin extends Plugin {
	settings: YouTubeHighlighterSettings;
	dataStore: VideoDataStore;

	async onload() {
		await this.loadSettings();

		this.dataStore = new VideoDataStore(this);

		registerCodeBlockProcessor(this);
		registerInsertCommand(this);
		registerExportCommand(this);

		this.addSettingTab(new YouTubeHighlighterSettingTab(this.app, this));
	}

	onunload() {
		// VideoDataStore has no persistent resources to clean up.
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<YouTubeHighlighterSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
