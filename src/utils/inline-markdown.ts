/**
 * Converts a subset of Obsidian-flavored inline markdown to HTML.
 *
 * Supported syntax:
 * - **bold**      → <strong>bold</strong>
 * - *italic*      → <em>italic</em>
 * - [[wikilink]]  → <a class="internal-link" data-href="wikilink">wikilink</a>
 * - [[target|display]] → <a class="internal-link" data-href="target">display</a>
 *
 * All other text is HTML-escaped to prevent XSS.
 *
 * This parser is intentionally simple: it does not handle nesting of
 * bold/italic, code spans, or other complex markdown features.
 */

/** Class applied to wikilink anchors (matches Obsidian's own class). */
const WIKILINK_CLASS = "internal-link";

/**
 * Combined regex that matches (in order of precedence):
 * 1. Wikilinks:  [[target|display]] or [[target]]
 *    → groups 1 = target, 2 = display (optional)
 * 2. Bold:       **text**
 *    → group 3 = bold text
 * 3. Italic:     *text*  (single asterisks)
 *    → group 4 = italic text
 *
 * Positional groups are used for ES6 compatibility.
 */

/** Group indices within INLINE_PATTERN matches. */
const GROUP_WIKI_TARGET = 1;
const GROUP_WIKI_DISPLAY = 2;
const GROUP_BOLD = 3;
const GROUP_ITALIC = 4;

const INLINE_PATTERN = new RegExp(
	[
		// Wikilinks: [[target]] or [[target|alias]]
		/\[\[([^\]|]+?)(?:\|([^\]]+?))?\]\]/.source,
		// Bold: **text** (non-greedy, at least one char)
		/\*\*([^*]+?)\*\*/.source,
		// Italic: *text* (single asterisks, non-greedy)
		/\*([^*]+?)\*/.source,
	].join("|"),
	"g",
);

/** Escapes HTML special characters to prevent XSS. */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * Parses inline Obsidian markdown and returns an HTML string.
 * Plain text is HTML-escaped; only bold, italic, and wikilinks
 * produce HTML elements.
 */
export function inlineMarkdownToHtml(markdown: string): string {
	const parts: string[] = [];
	let lastIndex = 0;

	INLINE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = INLINE_PATTERN.exec(markdown)) !== null) {
		// Append escaped text before this match.
		if (match.index > lastIndex) {
			parts.push(escapeHtml(markdown.slice(lastIndex, match.index)));
		}

		if (match[GROUP_WIKI_TARGET] !== undefined) {
			const target = match[GROUP_WIKI_TARGET];
			const display = match[GROUP_WIKI_DISPLAY] ?? target;
			parts.push(
				`<a class="${WIKILINK_CLASS}" data-href="${escapeHtml(target)}">${escapeHtml(display)}</a>`,
			);
		} else if (match[GROUP_BOLD] !== undefined) {
			parts.push(`<strong>${escapeHtml(match[GROUP_BOLD])}</strong>`);
		} else if (match[GROUP_ITALIC] !== undefined) {
			parts.push(`<em>${escapeHtml(match[GROUP_ITALIC])}</em>`);
		}

		lastIndex = match.index + match[0].length;
	}

	// Append any remaining text after the last match.
	if (lastIndex < markdown.length) {
		parts.push(escapeHtml(markdown.slice(lastIndex)));
	}

	return parts.join("");
}

/**
 * Renders inline Obsidian markdown into a container element using
 * DOM methods (no innerHTML). Safer for contexts where innerHTML
 * should be avoided.
 *
 * Each parsed token becomes a child node/element of the container.
 */
export function renderInlineMarkdown(container: HTMLElement, markdown: string): void {
	let lastIndex = 0;

	INLINE_PATTERN.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = INLINE_PATTERN.exec(markdown)) !== null) {
		// Text before this match.
		if (match.index > lastIndex) {
			container.appendText(markdown.slice(lastIndex, match.index));
		}

		if (match[GROUP_WIKI_TARGET] !== undefined) {
			const target = match[GROUP_WIKI_TARGET];
			const display = match[GROUP_WIKI_DISPLAY] ?? target;
			const link = document.createElement("a");
			link.className = WIKILINK_CLASS;
			link.dataset["href"] = target;
			link.textContent = display;
			container.appendChild(link);
		} else if (match[GROUP_BOLD] !== undefined) {
			const strong = document.createElement("strong");
			strong.textContent = match[GROUP_BOLD];
			container.appendChild(strong);
		} else if (match[GROUP_ITALIC] !== undefined) {
			const em = document.createElement("em");
			em.textContent = match[GROUP_ITALIC];
			container.appendChild(em);
		}

		lastIndex = match.index + match[0].length;
	}

	// Remaining text after the last match.
	if (lastIndex < markdown.length) {
		container.appendText(markdown.slice(lastIndex));
	}
}
