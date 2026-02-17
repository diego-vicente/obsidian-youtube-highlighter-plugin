import {requestUrl} from "obsidian";
import type {TranscriptEntry} from "./types";

/** Result of a transcript fetch attempt. */
export type TranscriptResult = {
	success: true;
	entries: TranscriptEntry[];
} | {
	success: false;
	error: string;
};

// ─── Auto-fetch via Innertube player API ─────────────────────────────

const INNERTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player";
const INNERTUBE_API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

/**
 * Client context for the Innertube API.
 * The ANDROID client returns caption track URLs that work for all videos,
 * including multi-audio videos where the WEB client's URLs return empty.
 */
const INNERTUBE_CLIENT_CONTEXT = {
	clientName: "ANDROID",
	clientVersion: "19.09.37",
	androidSdkVersion: 30,
} as const;

/**
 * Regex to parse format-3 XML: <p t="ms" d="ms">text</p>
 * This is the format returned for multi-audio and newer videos.
 * Times are in milliseconds.
 */
const FORMAT_3_REGEX = /<p t="(\d+)" d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;

/**
 * Regex to parse legacy XML: <text start="sec" dur="sec">text</text>
 * Times are in seconds (float).
 */
const LEGACY_TEXT_REGEX = /<text start="([^"]*)" dur="([^"]*)">([^<]*)<\/text>/g;

const MS_PER_SECOND = 1000;

/**
 * Fetches the transcript for a YouTube video.
 * Uses the Innertube player API (ANDROID client) to get caption track URLs,
 * then fetches and parses the timed-text XML.
 * All requests use Obsidian's `requestUrl()` to bypass CORS.
 */
export async function fetchTranscript(videoId: string, lang = "en"): Promise<TranscriptResult> {
	try {
		// Step 1: Get caption tracks via Innertube player API.
		const tracks = await fetchCaptionTracks(videoId, lang);
		if (!tracks || tracks.length === 0) {
			return {success: false, error: "No captions available for this video."};
		}

		// Step 2: Pick the best track (prefer non-ASR matching language).
		const track = pickBestTrack(tracks, lang);
		if (!track) {
			return {success: false, error: "No captions available for this video."};
		}

		// Step 3: Fetch and parse the transcript XML.
		const xml = await fetchTranscriptXml(track.baseUrl);
		const entries = parseTranscriptXml(xml);

		if (entries.length === 0) {
			return {success: false, error: "Transcript was empty or could not be parsed."};
		}

		return {success: true, entries};
	} catch (err) {
		const message = err instanceof Error ? err.message : "Failed to fetch transcript.";
		return {success: false, error: message};
	}
}

// ─── Innertube API ───────────────────────────────────────────────────

interface CaptionTrack {
	baseUrl: string;
	languageCode: string;
	kind?: string; // "asr" for auto-generated
	name?: { simpleText?: string };
}

interface InnertubePlayerResponse {
	captions?: {
		playerCaptionsTracklistRenderer?: {
			captionTracks?: CaptionTrack[];
		};
	};
}

/** Fetches caption track metadata from the Innertube player API. */
async function fetchCaptionTracks(videoId: string, lang: string): Promise<CaptionTrack[] | null> {
	const response = await requestUrl({
		url: `${INNERTUBE_PLAYER_URL}?key=${INNERTUBE_API_KEY}`,
		method: "POST",
		contentType: "application/json",
		body: JSON.stringify({
			context: {
				client: {
					...INNERTUBE_CLIENT_CONTEXT,
					hl: lang,
					gl: "US",
				},
			},
			videoId,
		}),
	});

	const data = response.json as InnertubePlayerResponse;
	return data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? null;
}

/**
 * Picks the best caption track: prefer manual captions in the requested language,
 * fall back to ASR, then fall back to the first available track.
 */
function pickBestTrack(tracks: CaptionTrack[], lang: string): CaptionTrack | null {
	// Prefer manual track in requested language.
	const manualMatch = tracks.find(t => t.languageCode === lang && t.kind !== "asr");
	if (manualMatch) return manualMatch;

	// Fall back to ASR in requested language.
	const asrMatch = tracks.find(t => t.languageCode === lang && t.kind === "asr");
	if (asrMatch) return asrMatch;

	// Fall back to any manual track.
	const anyManual = tracks.find(t => t.kind !== "asr");
	if (anyManual) return anyManual;

	// Last resort: first track.
	return tracks[0] ?? null;
}

// ─── XML parsing ─────────────────────────────────────────────────────

/** Fetches the timed-text XML from a caption track URL. */
async function fetchTranscriptXml(url: string): Promise<string> {
	const response = await requestUrl({url});
	return response.text;
}

/**
 * Parses transcript XML, auto-detecting the format:
 * - Format 3 (multi-audio/newer): <p t="ms" d="ms">text with <s> segments</p>
 * - Legacy: <text start="seconds" dur="seconds">text</text>
 */
function parseTranscriptXml(xml: string): TranscriptEntry[] {
	const isFormat3 = xml.includes('format="3"');
	return isFormat3 ? parseFormat3Xml(xml) : parseLegacyXml(xml);
}

/** Parses format-3 XML where times are in milliseconds. */
function parseFormat3Xml(xml: string): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];

	let match: RegExpExecArray | null;
	while ((match = FORMAT_3_REGEX.exec(xml)) !== null) {
		const offsetMs = parseInt(match[1] ?? "0", 10);
		const durationMs = parseInt(match[2] ?? "0", 10);
		const rawContent = match[3] ?? "";

		// Format 3 may contain <s> segments; strip tags and join text.
		const text = decodeHtmlEntities(stripXmlTags(rawContent).trim());
		if (text) {
			entries.push({
				text,
				offset: offsetMs / MS_PER_SECOND,
				duration: durationMs / MS_PER_SECOND,
			});
		}
	}

	return entries;
}

/** Parses legacy XML where times are in seconds (float). */
function parseLegacyXml(xml: string): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];

	let match: RegExpExecArray | null;
	while ((match = LEGACY_TEXT_REGEX.exec(xml)) !== null) {
		const offset = parseFloat(match[1] ?? "0");
		const duration = parseFloat(match[2] ?? "0");
		const text = decodeHtmlEntities(match[3] ?? "");
		entries.push({text, offset, duration});
	}

	return entries;
}

/** Strips XML/HTML tags from a string. */
function stripXmlTags(input: string): string {
	return input.replace(/<[^>]+>/g, "");
}

// ─── Manual paste parsing ────────────────────────────────────────────

/**
 * Parses manually pasted transcript text into TranscriptEntry objects.
 *
 * Expected format (one per line, from YouTube's transcript panel):
 *   0:00
 *   First line of text
 *   0:15
 *   Second line of text
 *
 * Or inline format:
 *   0:00 First line of text
 *   0:15 Second line of text
 */
export function parseManualTranscript(rawText: string): TranscriptEntry[] {
	const lines = rawText.split("\n").map(l => l.trim()).filter(l => l.length > 0);
	const entries: TranscriptEntry[] = [];

	const TIMESTAMP_PATTERN = /^(\d{1,2}:)?(\d{1,2}):(\d{2})$/;
	const INLINE_TIMESTAMP_PATTERN = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";

		// Try inline format first: "0:00 Text here"
		const inlineMatch = line.match(INLINE_TIMESTAMP_PATTERN);
		if (inlineMatch) {
			const offset = parseTimestampToSeconds(inlineMatch[1] ?? "");
			if (offset !== null) {
				entries.push({text: inlineMatch[2] ?? "", offset, duration: 0});
				continue;
			}
		}

		// Try alternating format: timestamp on one line, text on the next
		const timestampMatch = line.match(TIMESTAMP_PATTERN);
		if (timestampMatch) {
			const offset = parseTimestampToSeconds(line);
			const text = lines[i + 1] ?? "";
			if (offset !== null && text && !text.match(TIMESTAMP_PATTERN)) {
				entries.push({text, offset, duration: 0});
				i++; // skip the text line
			}
		}
	}

	// Compute durations from the gap between consecutive entries.
	const DEFAULT_LAST_ENTRY_DURATION_SECONDS = 5;
	for (let i = 0; i < entries.length; i++) {
		const current = entries[i];
		const next = entries[i + 1];
		if (current && next) {
			current.duration = next.offset - current.offset;
		} else if (current) {
			current.duration = DEFAULT_LAST_ENTRY_DURATION_SECONDS;
		}
	}

	return entries;
}

// ─── Helpers ─────────────────────────────────────────────────────────

/** Parses "MM:SS" or "H:MM:SS" to seconds. Returns null on invalid input. */
function parseTimestampToSeconds(timestamp: string): number | null {
	const SECONDS_PER_MINUTE = 60;
	const SECONDS_PER_HOUR = 3600;
	const parts = timestamp.split(":").map(Number);

	if (parts.some(p => isNaN(p))) return null;

	if (parts.length === 3) {
		return (parts[0] ?? 0) * SECONDS_PER_HOUR + (parts[1] ?? 0) * SECONDS_PER_MINUTE + (parts[2] ?? 0);
	}
	if (parts.length === 2) {
		return (parts[0] ?? 0) * SECONDS_PER_MINUTE + (parts[1] ?? 0);
	}
	return null;
}

/** Decodes common HTML entities found in YouTube transcript text. */
function decodeHtmlEntities(text: string): string {
	const ENTITIES: Record<string, string> = {
		"&amp;": "&",
		"&lt;": "<",
		"&gt;": ">",
		"&quot;": "\"",
		"&#39;": "'",
		"&apos;": "'",
	};
	return text.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (match) => ENTITIES[match] ?? match);
}
