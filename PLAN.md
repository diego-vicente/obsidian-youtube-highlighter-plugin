# YouTube Highlighter for Obsidian — Implementation Plan

## Goal

Build an Obsidian plugin that lets users watch YouTube videos with a synced, scrolling transcript (karaoke-style) and interactively **highlight** transcript excerpts and **annotate** timestamps. Data is stored as JSON inside a custom code block (`youtube-highlights`). A command converts the internal format to portable Obsidian markdown with `==highlights==` and `>` blockquotes.

See the Obsidian vault note *YouTube Highlighter Feasibility Analysis* for detailed API research and risk assessment.

## Architecture

### Storage: custom code block

The code block is the **internal representation only** — users don't edit it by hand. Obsidian renders it as an interactive widget via `registerMarkdownCodeBlockProcessor`.

````
```youtube-highlights
{
  "videoId": "dQw4w9WgXcQ",
  "title": "Never Gonna Give You Up",
  "highlights": [
    { "id": "h1", "startTime": 42.5, "endTime": 58.0, "text": "Never gonna give you up" }
  ],
  "annotations": [
    { "id": "a1", "timestamp": 0.0, "text": "Iconic intro" }
  ],
  "transcript": "cached"
}
```
````

- **Highlights** = marked transcript excerpts (single color, map to `==...==` on export).
- **Annotations** = free-text notes at a timestamp (independent from highlights).
- **Transcript data** is cached in the plugin data folder (`this.app.vault.adapter`), not in the code block (too large).

### Rendered UI (Reading/Preview mode)

```
┌─────────────────────────────────────┐
│  YouTube IFrame Player              │
│  (youtube-player npm package)       │
├─────────────────────────────────────┤
│  Transcript Panel (scrolling)       │
│  - Karaoke-style: current line      │
│    highlighted, auto-scrolls        │
│  - Click any line → seek video      │
│  - Select text → highlight button   │
│  - Highlighted text styled visually │
│  - Annotation icons at timestamps   │
├─────────────────────────────────────┤
│  Toolbar                            │
│  [Annotate at current time]         │
│  [Convert to markdown]              │
└─────────────────────────────────────┘
```

### Re-render strategy

When highlights/annotations change, the code block JSON is updated, which triggers Obsidian to destroy and recreate the rendered element. Two mitigations:

1. **Debounced writes** — batch changes (e.g., 1–2s debounce) so rapid interactions don't cause continuous re-renders.
2. **Iframe DOM recycling** — before the element is destroyed, detach the YouTube iframe to a hidden container managed by the plugin instance; after re-render, reattach it. This avoids the ~2–3s player re-initialization.
3. **Fallback** — if DOM recycling proves fragile, cache `player.getCurrentTime()` before destruction and `seekTo()` after re-initialization.

### UI framework decision

- **Phase 1 (MVP):** vanilla DOM — minimal complexity, standard for Obsidian plugins.
- **Phase 2+:** evaluate whether highlight/annotation interactions warrant Preact (~3KB). If vanilla DOM becomes unwieldy, introduce Preact at that point.

## Data types

```typescript
interface VideoData {
  videoId: string;
  title: string;
  highlights: Highlight[];
  annotations: Annotation[];
  transcript: "cached" | "none";
}

interface Highlight {
  id: string;
  startTime: number;   // seconds
  endTime: number;     // seconds
  text: string;        // the highlighted transcript text
}

interface Annotation {
  id: string;
  timestamp: number;   // seconds
  text: string;        // user's note
}

interface TranscriptEntry {
  text: string;
  offset: number;      // start time in seconds
  duration: number;     // duration in seconds
}
```

## File structure (target)

```
src/
  main.ts                # Plugin lifecycle, registerMarkdownCodeBlockProcessor
  settings.ts            # Settings interface, defaults, SettingTab
  types.ts               # VideoData, Highlight, Annotation, TranscriptEntry
  insert-command.ts      # "Insert video" command — prompts for URL, inserts code block
  code-block-processor.ts # Renders the widget from JSON source
  player.ts              # YouTube iframe embed, play/pause/seek API
  transcript.ts          # Fetch transcript, parse, cache management
  transcript-view.ts     # Scrolling transcript UI, karaoke sync
  highlights.ts          # Text selection → highlight creation, persistence
  annotations.ts         # Annotation input UI, persistence
  export.ts              # Convert to markdown command
  utils/
    time.ts              # Timestamp formatting (seconds ↔ MM:SS)
    dom.ts               # DOM helpers, iframe recycling
```

## Phases

### Phase 0 — Scaffold

Rename from sample plugin, establish project identity and file structure.

**Tasks:**
1. Update `manifest.json`: `id` → `youtube-highlighter`, `name` → `YouTube Highlighter`, `description`, `author`.
2. Update `package.json`: `name` → `obsidian-youtube-highlighter`.
3. Rename classes: `MyPlugin` → `YouTubeHighlighterPlugin`, `MyPluginSettings` → `YouTubeHighlighterSettings`.
4. Create `src/types.ts` with the data interfaces above.
5. Remove sample code (ribbon icon, status bar, sample commands, sample modal).
6. Register the code block processor in `onload()`: `this.registerMarkdownCodeBlockProcessor("youtube-highlights", ...)`.
7. Verify build works: `npm run build` + `npm run lint`.

**Done when:** Plugin loads in Obsidian, recognizes `youtube-highlights` code blocks, renders a placeholder.

### Phase 1 — MVP: Player + Transcript + Sync

Embed YouTube player, fetch transcript, display with karaoke sync, click-to-seek.

**Tasks:**
1. Install `youtube-player` package. Create `src/player.ts` wrapping iframe creation and the player API (play, pause, seekTo, getCurrentTime, onStateChange).
2. Install `youtube-transcript` package. Create `src/transcript.ts` for fetching + parsing + caching transcripts in the plugin data folder.
3. Create `src/transcript-view.ts`: render transcript lines, poll `getCurrentTime()` (~250ms), highlight the active line, auto-scroll to it.
4. Create `src/code-block-processor.ts`: parse JSON from code block source, instantiate player + transcript view, assemble the widget DOM.
5. Handle manual transcript fallback: if auto-fetch fails, show a text area for the user to paste YouTube's transcript text, then parse timestamps from it.
6. Create `src/utils/time.ts` for `secondsToTimestamp()` / `timestampToSeconds()`.
7. Style the widget in `styles.css`: player container, transcript panel (max-height, overflow scroll), active line highlight.

**Done when:** User can write a `youtube-highlights` code block with a `videoId`, see the embedded player, see the synced scrolling transcript, and click any line to seek.

### Phase 2 — Highlights & Annotations

Interactive highlighting of transcript text and timestamp annotations.

**Tasks:**
1. Create `src/highlights.ts`: listen for text selection within the transcript panel, map selection to `startTime`/`endTime` from the transcript entries, create a `Highlight` object, update the code block JSON via `vault.process()`.
2. Implement debounced writes in `src/utils/dom.ts` to batch rapid changes.
3. Implement iframe DOM recycling: on code block processor teardown, detach iframe to a plugin-level hidden container keyed by videoId; on re-render, reattach instead of creating a new player.
4. Style highlights: apply a CSS class to highlighted transcript spans (single color, e.g. yellow background).
5. Create `src/annotations.ts`: "Annotate" button or hotkey inserts an annotation at the current playback time, opens an inline text input, saves to code block JSON.
6. Render existing highlights and annotations from JSON when the widget loads.
7. Allow removing highlights (click to deselect) and editing/deleting annotations.

**Done when:** User can select transcript text to highlight it, add annotations at any timestamp, and all data persists in the code block JSON. Player state survives re-renders.

### Phase 3 — Export & Polish

Convert to markdown, settings, edge cases, mobile testing.

**Tasks:**
1. Create `src/export.ts`: command `convert-to-markdown` that replaces the code block with Obsidian-native markdown:
   - Video title as `## [Title](youtube-url)` heading.
   - Highlights as `> [MM:SS](youtube-url&t=S) ==highlighted text==`.
   - Annotations as `> [MM:SS](youtube-url&t=S) annotation text`.
   - Sorted by timestamp.
2. Register the command in `main.ts` via `addCommand()` with a `checkCallback` (only available when there is a `youtube-highlights` block in the active file).
3. Add settings: transcript language preference, auto-fetch vs manual, debounce interval.
4. Test on mobile (iOS/Android) — YouTube iframes in Obsidian webviews.
5. Handle edge cases: missing transcript, private videos, code block with invalid JSON, multiple code blocks in one note.
6. Ensure clean unload: all intervals, DOM events, and recycled iframes cleaned up in `onunload()`.

**Done when:** Full feature set works. Plugin loads/unloads cleanly. Export produces valid Obsidian markdown with `==highlights==` and blockquote annotations.

## Dependencies

| Package | Purpose | Size |
|---------|---------|------|
| `youtube-player` | YouTube IFrame API wrapper | ~8KB |
| `youtube-transcript` | Fetch transcripts (unofficial) | ~5KB |
| `obsidian` | Obsidian API types (already present) | types only |

## Risks & mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| YouTube transcript API breaks | Can't auto-fetch | Manual paste fallback, support SRT/VTT import |
| Re-render destroys player state | Bad UX, player restarts | Iframe DOM recycling + debounced writes |
| Mobile iframe issues | Plugin doesn't work on mobile | Test early, set `isDesktopOnly: true` as last resort |
| Code block JSON corrupted by user edits | Plugin crashes | Validate JSON on parse, show friendly error + raw source |
