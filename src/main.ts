import {Plugin} from "obsidian";
import {DEFAULT_SETTINGS, YouTubeHighlighterSettings, YouTubeHighlighterSettingTab} from "./settings";
import {registerCodeBlockProcessor} from "./code-block-processor";
import {registerInsertCommand} from "./insert-command";

export default class YouTubeHighlighterPlugin extends Plugin {
	settings: YouTubeHighlighterSettings;

	async onload() {
		await this.loadSettings();

		registerCodeBlockProcessor(this);
		registerInsertCommand(this);

		this.addSettingTab(new YouTubeHighlighterSettingTab(this.app, this));
	}

	onunload() {
		// Phase 2+: clean up recycled iframes and intervals here.
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
