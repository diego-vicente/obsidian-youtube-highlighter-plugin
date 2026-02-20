import {App, PluginSettingTab, Setting} from "obsidian";
import type YouTubeHighlighterPlugin from "./main";

export class YouTubeHighlighterSettingTab extends PluginSettingTab {
	plugin: YouTubeHighlighterPlugin;

	constructor(app: App, plugin: YouTubeHighlighterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Transcript language")
			.setDesc("Preferred language code for auto-fetched YouTube transcripts.")
			.addText(text => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- language code placeholder
				.setPlaceholder("en")
				.setValue(this.plugin.settings.transcriptLanguage)
				.onChange(async (value) => {
					this.plugin.settings.transcriptLanguage = value;
					await this.plugin.saveSettings();
				}));
	}
}
