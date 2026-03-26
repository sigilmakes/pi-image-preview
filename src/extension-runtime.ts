import fs from "node:fs";
import path from "node:path";
import type { ImageContent, ContentBlock } from "./content.ts";
import { ImageGallery, type GalleryImage } from "./image-gallery.ts";
import {
	looksLikeImagePath,
	isScreenshotToolResult,
	collectTextContent,
	extractSavedScreenshotPaths,
	hasInlineImageContent,
	resolveMaybeRelativePath,
} from "./path-utils.ts";
import { PREFER_INLINE_SCREENSHOT_PROMPT } from "./prompt.ts";
import { upgradeScreenshotToolResult } from "./tool-result-upgrader.ts";

// ── Types ──────────────────────────────────────────────────

type TrackedImage = {
	filePath: string;
	image: ImageContent;
	label: string;
};

export type ExtensionDeps = {
	resolveCwd: () => string;
	readImageContentFromPath: (filePath: string) => ImageContent | null;
	maybeResizeImage?: (image: ImageContent) => Promise<ImageContent>;
	loadImageContentFromPath: (
		filePath: string,
	) => Promise<ImageContent | null>;
};

type PiLike = {
	on(event: string, handler: (event: any, ctx: any) => any): void;
	sendUserMessage(
		content: string | ContentBlock[],
		options?: { deliverAs?: "steer" | "followUp" },
	): void;
};

type CtxLike = {
	cwd: string;
	isIdle(): boolean;
	ui: {
		setWidget(
			key: string,
			content:
				| string[]
				| ((tui: any, theme: any) => any)
				| undefined,
			options?: { placement?: "aboveEditor" | "belowEditor" },
		): void;
		getEditorText(): string;
		setEditorText(text: string): void;
		theme: any;
	};
};

// ── Constants ──────────────────────────────────────────────

const WIDGET_KEY = "image-preview";
const POLL_INTERVAL_MS = 250;

// Matches absolute paths ending in image extensions
const IMAGE_PATH_RE =
	/((?:\/[\w.@~\-]+)+\.(?:png|jpe?g|gif|webp))\b/gi;

/** Produce a label from an image path — just the filename. */
function trimImageLabel(filePath: string): string {
	return path.basename(filePath);
}

// ── Extension ──────────────────────────────────────────────

export function registerImagePreviewExtension(
	pi: PiLike,
	deps: ExtensionDeps,
): void {
	let tracked: Map<string, TrackedImage> = new Map();
	let gallery: ImageGallery | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: CtxLike | null = null;

	// ── Helpers ────────────────────────────────────────────

	function refreshWidget(ctx: CtxLike): void {
		if (tracked.size === 0) {
			if (gallery) {
				gallery.dispose();
				gallery = null;
			}
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const galleryImages: GalleryImage[] = [...tracked.values()].map((t) => ({
			data: t.image.data,
			mimeType: t.image.mimeType,
			label: t.label,
		}));

		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui: any, theme: any) => {
				const galleryTheme = {
					accent: (s: string) => theme.fg("accent", s),
					muted: (s: string) => theme.fg("muted", s),
					dim: (s: string) => theme.fg("dim", s),
					bold: (s: string) => theme.bold(s),
				};

				gallery = new ImageGallery(galleryTheme);
				gallery.setImages(galleryImages);
				return gallery;
			},
			{ placement: "aboveEditor" },
		);
	}

	function resetDraft(ctx: CtxLike): void {
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}
		tracked = new Map();
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/**
	 * Scan editor text for image paths.
	 * Track new ones, remove ones that are no longer in the text.
	 */
	function scanEditorText(ctx: CtxLike): void {
		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch {
			return;
		}
		if (!text) {
			if (tracked.size > 0) {
				tracked = new Map();
				refreshWidget(ctx);
			}
			return;
		}

		// Find all image paths currently in the text
		IMAGE_PATH_RE.lastIndex = 0;
		const matches = [...text.matchAll(IMAGE_PATH_RE)];
		const currentPaths = new Set<string>();

		let changed = false;

		for (const match of matches) {
			const rawPath = match[1];
			if (!rawPath) continue;
			currentPaths.add(rawPath);

			// Already tracked?
			if (tracked.has(rawPath)) continue;

			// New path — try to load it
			if (!looksLikeImagePath(rawPath)) continue;
			const image = deps.readImageContentFromPath(rawPath);
			if (!image) continue;

			tracked.set(rawPath, {
				filePath: rawPath,
				image,
				label: trimImageLabel(rawPath),
			});
			changed = true;

			// Async resize in background
			if (deps.maybeResizeImage) {
				const entry = tracked.get(rawPath)!;
				void deps.maybeResizeImage(image).then((resized) => {
					entry.image = resized;
					if (latestCtx) refreshWidget(latestCtx);
				}).catch(() => {});
			}
		}

		// Remove tracked images whose paths are no longer in the text
		for (const trackedPath of tracked.keys()) {
			if (!currentPaths.has(trackedPath)) {
				tracked.delete(trackedPath);
				changed = true;
			}
		}

		if (changed) {
			refreshWidget(ctx);
		}
	}

	function startPolling(): void {
		stopPolling();
		pollTimer = setInterval(() => {
			if (!latestCtx) return;
			try {
				scanEditorText(latestCtx);
			} catch {}
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// ── Event handlers ─────────────────────────────────────

	pi.on("before_agent_start", () => {
		return { systemPrompt: PREFER_INLINE_SCREENSHOT_PROMPT };
	});

	pi.on("session_start", async (_event: any, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("session_switch", async (_event: any, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("tool_result", async (event: any, ctx: CtxLike) => {
		latestCtx = ctx;
		return upgradeScreenshotToolResult(
			event,
			ctx.cwd,
			deps.loadImageContentFromPath,
		);
	});

	// On submit: strip image paths from text, attach actual images
	pi.on("input", async (event: any, ctx: CtxLike) => {
		latestCtx = ctx;

		if (tracked.size === 0) {
			return { action: "continue" as const };
		}

		const fullText = (event.text as string || "").trim();

		// Don't transform commands or shell escapes
		if (fullText.startsWith("/") || fullText.trimStart().startsWith("!")) {
			return { action: "continue" as const };
		}

		// Find which tracked paths are still in the submitted text
		const usedImages: ImageContent[] = [];
		let strippedText = fullText;

		for (const [trackedPath, entry] of tracked) {
			if (fullText.includes(trackedPath)) {
				usedImages.push(entry.image);
				// Strip the path from the text
				strippedText = strippedText.split(trackedPath).join("");
			}
		}

		if (usedImages.length === 0) {
			return { action: "continue" as const };
		}

		// Clean up whitespace after stripping paths
		strippedText = strippedText.replace(/\s+/g, " ").trim();

		// Clear state
		resetDraft(ctx);

		if (!strippedText) {
			// Images only, no text — send directly
			pi.sendUserMessage(
				usedImages,
				ctx.isIdle() ? undefined : { deliverAs: "steer" },
			);
			return { action: "handled" as const };
		}

		return {
			action: "transform" as const,
			text: strippedText,
			images: [...(event.images ?? []), ...usedImages],
		};
	});
}
