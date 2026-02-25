import {Platform} from "obsidian";
import YouTubePlayer from "youtube-player";

/** YouTube player state constants (mirror of YT.PlayerState). */
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

/** Privacy-enhanced embed host for desktop (Electron adds the Referer). */
const YOUTUBE_NOCOOKIE_HOST = "https://www.youtube-nocookie.com";

/**
 * Bridge page hosted on GitHub Pages. On iOS, Capacitor's webview doesn't
 * send a Referer header, so YouTube rejects direct embeds with error 153.
 * This page is served from a real HTTPS domain, providing a valid Referer.
 * Communication happens via postMessage.
 */
const BRIDGE_PAGE_BASE_URL =
	"https://diego-vicente.github.io/obsidian-youtube-highlighter-plugin";

/** Options passed to the YouTube player iframe via playerVars. */
const DEFAULT_PLAYER_VARS: Record<string, unknown> = {
	autoplay: 0,
	modestbranding: 1,
	rel: 0,
	enablejsapi: 1,
	playsinline: 1,
};

/** Timeout in ms for postMessage request/response round-trips. */
const MESSAGE_TIMEOUT_MS = 3000;

/** CSS class for the player container. */
const CSS_PLAYER = "yt-highlighter-player";

export interface PlayerWrapper {
	/** The container div holding the iframe. */
	containerEl: HTMLElement;
	/**
	 * Resolves when the player is ready to accept commands.
	 * For the direct player this resolves immediately; for the bridge
	 * player it resolves when the bridge page sends the "ready" message.
	 */
	ready: Promise<void>;
	/** Get current playback time in seconds. */
	getCurrentTime(): Promise<number>;
	/** Get total video duration in seconds. Returns 0 if unknown. */
	getDuration(): Promise<number>;
	/** Get the current player state. */
	getPlayerState(): Promise<number>;
	/** Seek to a position in seconds. */
	seekTo(seconds: number): Promise<void>;
	/** Pause playback. */
	pause(): Promise<void>;
	/** Mute the player audio. */
	mute(): Promise<void>;
	/** Unmute the player audio. */
	unMute(): Promise<void>;
	/** Destroy the player and clean up. */
	destroy(): Promise<void>;
	/** Register a callback for player state changes. */
	onStateChange(handler: (state: number) => void): void;
}

/**
 * Creates a YouTube player embedded inside the given parent element.
 *
 * Desktop + Android: uses youtube-player npm package directly. Obsidian
 * 1.10.3+ sets the Referer at the Electron/system level.
 *
 * iOS: uses a bridge page hosted on GitHub Pages that wraps the YouTube
 * IFrame API and communicates via postMessage.
 */
export function createPlayer(parentEl: HTMLElement, videoId: string): PlayerWrapper {
	if (Platform.isIosApp) {
		return createBridgePlayer(parentEl, videoId);
	}
	return createDirectPlayer(parentEl, videoId);
}

// ─── Desktop / Android: youtube-player (direct IFrame API) ───────────

function createDirectPlayer(parentEl: HTMLElement, videoId: string): PlayerWrapper {
	const containerEl = parentEl.createDiv({cls: CSS_PLAYER});
	const playerTarget = containerEl.createDiv();

	const instance = YouTubePlayer(playerTarget, {
		width: DEFAULT_PLAYER_WIDTH,
		height: DEFAULT_PLAYER_HEIGHT,
		videoId,
		playerVars: DEFAULT_PLAYER_VARS,
		host: YOUTUBE_NOCOOKIE_HOST,
	});

	return {
		containerEl,
		// youtube-player internally queues commands until ready.
		ready: Promise.resolve(),

		async getCurrentTime() {
			return instance.getCurrentTime();
		},

		async getDuration() {
			return instance.getDuration();
		},

		async getPlayerState() {
			return instance.getPlayerState();
		},

		async seekTo(seconds: number) {
			const ALLOW_SEEK_AHEAD = true;
			await instance.seekTo(seconds, ALLOW_SEEK_AHEAD);
		},

		async pause() {
			await instance.pauseVideo();
		},

		async mute() {
			await instance.mute();
		},

		async unMute() {
			await instance.unMute();
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
}

// ─── iOS: Bridge page (postMessage-based) ────────────────────────────

/**
 * Creates a YouTube player via a bridge page loaded in an iframe.
 * The bridge page is hosted on GitHub Pages and wraps the YouTube IFrame
 * API, communicating back to the plugin via postMessage.
 *
 * Protocol (plugin -> bridge):
 *   { action: "seekTo", seconds }
 *   { action: "getCurrentTime", requestId }
 *   { action: "getDuration", requestId }
 *   { action: "getPlayerState", requestId }
 *   { action: "play" }
 *   { action: "pause" }
 *
 * Protocol (bridge -> plugin):
 *   { type: "ready" }
 *   { type: "stateChange", state }
 *   { type: "currentTime", requestId, time }
 *   { type: "duration", requestId, duration }
 *   { type: "playerState", requestId, state }
 *   { type: "error", code }
 */
function createBridgePlayer(parentEl: HTMLElement, videoId: string): PlayerWrapper {
	const containerEl = parentEl.createDiv({cls: CSS_PLAYER});

	const bridgeUrl = `${BRIDGE_PAGE_BASE_URL}/?v=${encodeURIComponent(videoId)}`;

	const iframe = document.createElement("iframe");
	iframe.src = bridgeUrl;
	iframe.width = String(DEFAULT_PLAYER_WIDTH);
	iframe.height = String(DEFAULT_PLAYER_HEIGHT);
	iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
	iframe.setAttribute("allowfullscreen", "");
	iframe.setAttribute("frameborder", "0");
	containerEl.appendChild(iframe);

	// Ready gate: resolves when the bridge page sends the "ready" message.
	let resolveReady: () => void;
	const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

	const stateChangeHandlers: Array<(state: number) => void> = [];

	/**
	 * Pending request/response pairs for getCurrentTime and getPlayerState.
	 * Keyed by requestId; resolved when the bridge replies.
	 */
	const pendingRequests = new Map<string, (value: number) => void>();
	let requestCounter = 0;

	/** Shape of messages received from the bridge page. */
	interface BridgeMessage {
		type: string;
		state?: number;
		time?: number;
		duration?: number;
		requestId?: string;
		code?: number;
	}

	function isBridgeMessage(value: unknown): value is BridgeMessage {
		return typeof value === "object" && value !== null && "type" in value;
	}

	function handleMessage(event: MessageEvent): void {
		// Only process messages from our bridge iframe.
		if (event.source !== iframe.contentWindow) return;

		if (!isBridgeMessage(event.data)) return;
		const data = event.data;

		switch (data.type) {
			case "ready":
				resolveReady();
				break;

			case "stateChange":
				if (data.state !== undefined) {
					for (const handler of stateChangeHandlers) {
						handler(data.state);
					}
				}
				break;

			case "currentTime": {
				if (data.requestId !== undefined && data.time !== undefined) {
					const resolver = pendingRequests.get(data.requestId);
					if (resolver) {
						pendingRequests.delete(data.requestId);
						resolver(data.time);
					}
				}
				break;
			}

			case "duration": {
				if (data.requestId !== undefined && data.duration !== undefined) {
					const resolver = pendingRequests.get(data.requestId);
					if (resolver) {
						pendingRequests.delete(data.requestId);
						resolver(data.duration);
					}
				}
				break;
			}

			case "playerState": {
				if (data.requestId !== undefined && data.state !== undefined) {
					const resolver = pendingRequests.get(data.requestId);
					if (resolver) {
						pendingRequests.delete(data.requestId);
						resolver(data.state);
					}
				}
				break;
			}

			case "error":
				console.error(`YouTube bridge error: ${data.code ?? "unknown"}`);
				break;
		}
	}

	window.addEventListener("message", handleMessage);

	/** Send a command to the bridge iframe. */
	function sendCommand(message: Record<string, unknown>): void {
		iframe.contentWindow?.postMessage(message, "*");
	}

	/**
	 * Send a request that expects a response, identified by requestId.
	 * Returns a promise that resolves when the bridge replies, or
	 * rejects on timeout.
	 */
	function sendRequest(action: string): Promise<number> {
		return new Promise<number>((resolve, reject) => {
			const requestId = `req_${++requestCounter}`;
			pendingRequests.set(requestId, resolve);
			sendCommand({action, requestId});

			window.setTimeout(() => {
				if (pendingRequests.has(requestId)) {
					pendingRequests.delete(requestId);
					reject(new Error(`Bridge request "${action}" timed out`));
				}
			}, MESSAGE_TIMEOUT_MS);
		});
	}

	return {
		containerEl,
		ready,

		async getCurrentTime() {
			return sendRequest("getCurrentTime");
		},

		async getDuration() {
			try {
				return await sendRequest("getDuration");
			} catch {
				// If the bridge isn't ready yet, report as unknown.
				return 0;
			}
		},

		async getPlayerState() {
			try {
				return await sendRequest("getPlayerState");
			} catch {
				// If the bridge isn't ready yet, report as unstarted.
				return PlayerState.UNSTARTED;
			}
		},

		async seekTo(seconds: number) {
			sendCommand({action: "seekTo", seconds});
		},

		async pause() {
			sendCommand({action: "pause"});
		},

		async mute() {
			sendCommand({action: "mute"});
		},

		async unMute() {
			sendCommand({action: "unMute"});
		},

		async destroy() {
			window.removeEventListener("message", handleMessage);
			pendingRequests.clear();
			iframe.remove();
		},

		onStateChange(handler: (state: number) => void) {
			stateChangeHandlers.push(handler);
		},
	};
}
