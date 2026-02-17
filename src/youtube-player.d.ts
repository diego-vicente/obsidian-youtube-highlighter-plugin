/**
 * Type declarations for the `youtube-player` npm package (v5.x).
 * The package ships without TypeScript definitions.
 */
declare module "youtube-player" {
	interface PlayerOptions {
		width?: number;
		height?: number;
		videoId?: string;
		playerVars?: Record<string, unknown>;
		/** Override the embed host (e.g. "https://www.youtube-nocookie.com"). */
		host?: string;
	}

	interface PlayerEvent {
		data: number;
		target: YouTubePlayerInstance;
	}

	interface YouTubePlayerInstance {
		// Playback control
		loadVideoById(videoId: string, startSeconds?: number): Promise<void>;
		cueVideoById(videoId: string, startSeconds?: number): Promise<void>;
		playVideo(): Promise<void>;
		pauseVideo(): Promise<void>;
		stopVideo(): Promise<void>;
		seekTo(seconds: number, allowSeekAhead: boolean): Promise<void>;

		// Playback status
		getCurrentTime(): Promise<number>;
		getDuration(): Promise<number>;
		getPlayerState(): Promise<number>;
		getVideoLoadedFraction(): Promise<number>;

		// Volume
		mute(): Promise<void>;
		unMute(): Promise<void>;
		isMuted(): Promise<boolean>;
		setVolume(volume: number): Promise<void>;
		getVolume(): Promise<number>;

		// Rate
		getPlaybackRate(): Promise<number>;
		setPlaybackRate(suggestedRate: number): Promise<void>;
		getAvailablePlaybackRates(): Promise<readonly number[]>;

		// DOM
		getIframe(): Promise<HTMLIFrameElement>;
		destroy(): Promise<void>;
		setSize(width: number, height: number): Promise<object>;

		// Events (not promise-based, these are immediate)
		on(eventName: "stateChange", handler: (event: PlayerEvent) => void): object;
		on(eventName: "ready", handler: (event: PlayerEvent) => void): object;
		on(eventName: "error", handler: (event: PlayerEvent) => void): object;
		on(eventName: string, handler: (event: PlayerEvent) => void): object;
		off(listener: object): void;
	}

	export default function YouTubePlayer(
		elementOrId: string | HTMLElement,
		options?: PlayerOptions,
		strictState?: boolean,
	): YouTubePlayerInstance;

	/** YouTube player state constants. */
	export const PlayerStates: {
		UNSTARTED: -1;
		ENDED: 0;
		PLAYING: 1;
		PAUSED: 2;
		BUFFERING: 3;
		VIDEO_CUED: 5;
	};
}
