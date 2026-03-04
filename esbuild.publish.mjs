/**
 * Builds publish.js — a standalone script for Obsidian Publish sites.
 *
 * This is a separate bundle from main.js. It has NO Obsidian dependencies
 * and NO npm dependencies; everything is inlined. The output is an IIFE
 * that registers a code block processor on the global `publish` object.
 *
 * Usage:
 *   node esbuild.publish.mjs           # development (with sourcemaps)
 *   node esbuild.publish.mjs production # minified production build
 */

import esbuild from "esbuild";
import process from "process";

const banner =
`/*
YouTube Highlighter — Obsidian Publish companion
https://github.com/diego-vicente/obsidian-youtube-highlighter-plugin
*/
`;

const prod = (process.argv[2] === "production");

await esbuild.build({
	banner: {
		js: banner,
	},
	entryPoints: ["src/publish.ts"],
	bundle: true,
	// No external dependencies — everything is self-contained.
	external: [],
	format: "iife",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "publish.js",
	minify: prod,
});
