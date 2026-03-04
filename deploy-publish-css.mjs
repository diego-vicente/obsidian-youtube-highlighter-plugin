/**
 * Merges the widget CSS (publish.css) into the vault's publish.css.
 *
 * The vault's publish.css contains theme styles (e.g. Catppuccin / Minimal
 * Publish) that must not be overwritten. This script:
 *
 *   1. Reads the vault's existing publish.css
 *   2. Strips any previously-appended widget CSS (identified by MARKER)
 *   3. Appends the repo's publish.css (widget-only styles)
 *   4. Writes the result back to the vault
 *
 * Usage:
 *   node deploy-publish-css.mjs
 *
 * Environment:
 *   VAULT_PATH — path to the Obsidian vault root (defaults to sibling
 *                "Digital Garden" directory)
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MARKER = "/* ─── YouTube Highlighter — Obsidian Publish widget ──────────────── */";

const DEFAULT_VAULT_PATH = resolve(__dirname, "..", "Digital Garden");
const vaultPath = process.env.VAULT_PATH || DEFAULT_VAULT_PATH;
const vaultCssPath = resolve(vaultPath, "publish.css");
const widgetCssPath = resolve(__dirname, "publish.css");

// ── Read inputs ──────────────────────────────────────────────────────

if (!existsSync(widgetCssPath)) {
	console.error(`Widget CSS not found: ${widgetCssPath}`);
	process.exit(1);
}

const widgetCss = readFileSync(widgetCssPath, "utf-8");

let existingCss = "";
if (existsSync(vaultCssPath)) {
	existingCss = readFileSync(vaultCssPath, "utf-8");
}

// ── Strip previous widget CSS ────────────────────────────────────────

const markerIndex = existingCss.indexOf(MARKER);
const themeCss = markerIndex >= 0
	? existingCss.slice(0, markerIndex).trimEnd()
	: existingCss.trimEnd();

// ── Merge and write ──────────────────────────────────────────────────

const merged = themeCss + "\n\n" + widgetCss + "\n";

writeFileSync(vaultCssPath, merged, "utf-8");

console.log(`✓ Widget CSS merged into ${vaultCssPath}`);
console.log(`  Theme CSS: ${themeCss.split("\n").length} lines`);
console.log(`  Widget CSS: ${widgetCss.split("\n").length} lines`);
console.log(`  Total: ${merged.split("\n").length} lines`);
