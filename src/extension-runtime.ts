import path from "node:path";
import type { ImageContent, ContentBlock } from "./content.ts";
import { ImageGallery, type GalleryImage } from "./image-gallery.ts";
import { upgradeScreenshotToolResult } from "./tool-result-upgrader.ts";
import { debugLog } from "./debug.ts";

// ── Types ──────────────────────────────────────────────────

type TrackedImage = {
	filePath: string;
	image: ImageContent;
	label: string;
};

export type ExtensionDeps = {
	readImageContentFromPathAsync: (
		filePath: string,
	) => Promise<ImageContent | null>;
	maybeResizeImage?: (image: ImageContent) => Promise<ImageContent>;
	loadImageContentFromPath: (
		filePath: string,
	) => Promise<ImageContent | null>;
};

type PiLike = {
	on(event: string, handler: (...args: any[]) => any): void;
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

/** Event shape for the "input" event from pi. */
type InputEvent = {
	text: string;
	images?: ImageContent[];
};

/** Discriminated union for input handler return values. */
type InputResult =
	| { action: "continue" }
	| { action: "handled" }
	| { action: "transform"; text: string; images: ImageContent[] };

/** Re-export for tool_result event typing. */
type ToolResultEvent = import("./tool-result-upgrader.ts").ToolResultEventLike;

// ── Constants ──────────────────────────────────────────────

const WIDGET_KEY = "image-preview";
const POLL_INTERVAL_MS = 250;

// Matches image file paths:
//   - Absolute: /path/to/image.png
//   - Home-relative: ~/screenshots/image.png
//   - Relative: ./images/image.png, ../images/image.png
// Supports common path characters including spaces (escaped with \),
// parens, #, +, and other special characters.
const IMAGE_PATH_RE =
	/((?:~\/|\.\.?\/|\/)[^\s:*?"<>|][^\s:*?"<>|]*\.(?:png|jpe?g|gif|webp))(?=\s|$)/gi;

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

		// Dispose the previous gallery to free kitty image resources before replacement
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}

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
	 * Async to avoid blocking the event loop with file I/O.
	 */
	async function scanEditorText(ctx: CtxLike): Promise<void> {
		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch (err) {
			debugLog("Failed to get editor text", err);
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
		// Create a fresh regex each time to avoid stale lastIndex from the `g` flag
		const imagePathRe = new RegExp(IMAGE_PATH_RE.source, IMAGE_PATH_RE.flags);
		const matches = [...text.matchAll(imagePathRe)];
		const currentPaths = new Set<string>();

		let changed = false;

		for (const match of matches) {
			const rawPath = match[1];
			if (!rawPath) continue;
			currentPaths.add(rawPath);

			// Already tracked?
			if (tracked.has(rawPath)) continue;

			// New path — try to load it (async to avoid blocking event loop)
			const image = await deps.readImageContentFromPathAsync(rawPath);
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
					// Guard against the entry having been removed while resize was in-flight
					if (tracked.has(rawPath) && tracked.get(rawPath) === entry) {
						entry.image = resized;
						if (latestCtx) refreshWidget(latestCtx);
					}
				}).catch((err) => {
					debugLog(`Failed to resize image ${rawPath}`, err);
				});
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
			scanEditorText(latestCtx).catch((err) => {
				debugLog("Error during editor text scan", err);
			});
		}, POLL_INTERVAL_MS);
	}

	function stopPolling(): void {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	// ── Event handlers ─────────────────────────────────────

	// Clean up resources when the process exits
	const cleanup = (): void => {
		stopPolling();
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}
	};
	process.on("exit", cleanup);
	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	pi.on("session_start", async (_event: unknown, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("session_switch", async (_event: unknown, ctx: CtxLike) => {
		latestCtx = ctx;
		resetDraft(ctx);
		startPolling();
	});

	pi.on("tool_result", async (event: ToolResultEvent, ctx: CtxLike) => {
		latestCtx = ctx;
		return upgradeScreenshotToolResult(
			event,
			ctx.cwd,
			deps.loadImageContentFromPath,
		);
	});

	// On submit: strip image paths from text, attach actual images
	pi.on("input", async (event: InputEvent, ctx: CtxLike): Promise<InputResult> => {
		latestCtx = ctx;

		if (tracked.size === 0) {
			return { action: "continue" };
		}

		const fullText = (event.text || "").trim();

		// Don't transform commands or shell escapes
		if (fullText.startsWith("/") || fullText.trimStart().startsWith("!")) {
			return { action: "continue" };
		}

		// Collect images for all tracked paths in the submitted text
		const usedImages: ImageContent[] = [];

		for (const [trackedPath, entry] of tracked) {
			if (fullText.includes(trackedPath)) {
				usedImages.push(entry.image);
			}
		}

		if (usedImages.length === 0) {
			return { action: "continue" };
		}

		// Clear state
		resetDraft(ctx);

		// Keep the original text as-is (paths stay visible in chat),
		// just attach the actual image data alongside
		return {
			action: "transform",
			text: fullText,
			images: [...(event.images ?? []), ...usedImages],
		};
	});
}
