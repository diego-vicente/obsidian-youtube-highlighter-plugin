const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const TIMESTAMP_PAD_LENGTH = 2;

/**
 * Converts seconds to a human-readable timestamp string.
 * Examples: 62 → "1:02", 3661 → "1:01:01", 5 → "0:05"
 */
export function secondsToTimestamp(totalSeconds: number): string {
	const rounded = Math.floor(totalSeconds);
	const hours = Math.floor(rounded / SECONDS_PER_HOUR);
	const minutes = Math.floor((rounded % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	const seconds = rounded % SECONDS_PER_MINUTE;

	const paddedSeconds = String(seconds).padStart(TIMESTAMP_PAD_LENGTH, "0");
	const paddedMinutes = String(minutes).padStart(TIMESTAMP_PAD_LENGTH, "0");

	if (hours > 0) {
		return `${hours}:${paddedMinutes}:${paddedSeconds}`;
	}
	return `${minutes}:${paddedSeconds}`;
}

/**
 * Parses a timestamp string (e.g. "1:02", "1:01:01") into seconds.
 * Returns null if the format is invalid.
 */
export function timestampToSeconds(timestamp: string): number | null {
	const parts = timestamp.split(":").map(Number);
	if (parts.some(p => isNaN(p))) {
		return null;
	}

	if (parts.length === 3) {
		const [hours, minutes, seconds] = parts;
		return (hours ?? 0) * SECONDS_PER_HOUR + (minutes ?? 0) * SECONDS_PER_MINUTE + (seconds ?? 0);
	}
	if (parts.length === 2) {
		const [minutes, seconds] = parts;
		return (minutes ?? 0) * SECONDS_PER_MINUTE + (seconds ?? 0);
	}

	return null;
}
