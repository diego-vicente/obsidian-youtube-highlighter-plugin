import YouTubePlayer from "youtube-player";
import type {YouTubePlayerInstance} from "youtube-player";

/** YouTube player state constants. */
export const PlayerState = {
	UNSTARTED: -1,
	ENDED: 0,
	PLAYING: 1,
	PAUSED: 2,
	BUFFERING: 3,
	VIDEO_CUED: 5,
} as const;

const PLAYER_ASPECT_RATIO = 16 / 9;
const DEFAULT_PLAYER_WIDTH = 640;
const DEFAULT_PLAYER_HEIGHT = Math.round(DEFAULT_PLAYER_WIDTH / PLAYER_ASPECT_RATIO);

/** Options passed to the YouTube player iframe via playerVars. */
const DEFAULT_PLAYER_VARS: Record<string, unknown> = {
	autoplay: 0,
	modestbranding: 1,
	rel: 0,
	enablejsapi: 1,
};

export interface PlayerWrapper {
	/** The underlying youtube-player instance. */
	instance: YouTubePlayerInstance;
	/** The container div holding the iframe. */
	containerEl: HTMLElement;
	/** Load a video by its ID. */
	loadVideo(videoId: string): Promise<void>;
	/** Get current playback time in seconds. */
	getCurrentTime(): Promise<number>;
	/** Seek to a position in seconds. */
	seekTo(seconds: number): Promise<void>;
	/** Destroy the player and clean up. */
	destroy(): Promise<void>;
	/** Register a callback for player state changes. */
	onStateChange(handler: (state: number) => void): void;
}

/**
 * Creates a YouTube player embedded inside the given parent element.
 * Returns a PlayerWrapper for controlling playback.
 */
export function createPlayer(parentEl: HTMLElement, videoId: string): PlayerWrapper {
	const containerEl = parentEl.createDiv({cls: "yt-highlighter-player"});

	// The youtube-player library needs a child element to replace with the iframe.
	const playerTarget = containerEl.createDiv();

	const instance = YouTubePlayer(playerTarget, {
		width: DEFAULT_PLAYER_WIDTH,
		height: DEFAULT_PLAYER_HEIGHT,
		videoId,
		playerVars: DEFAULT_PLAYER_VARS,
	});

	const wrapper: PlayerWrapper = {
		instance,
		containerEl,

		async loadVideo(id: string) {
			await instance.loadVideoById(id);
		},

		async getCurrentTime() {
			return instance.getCurrentTime();
		},

		async seekTo(seconds: number) {
			const ALLOW_SEEK_AHEAD = true;
			await instance.seekTo(seconds, ALLOW_SEEK_AHEAD);
		},

		async destroy() {
			await instance.destroy();
		},

		onStateChange(handler: (state: number) => void) {
			instance.on("stateChange", (event) => {
				handler(event.data);
			});
		},
	};

	return wrapper;
}
