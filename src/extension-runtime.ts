import fs from "node:fs";
import path from "node:path";
import type { ImageContent, ContentBlock } from "./content.ts";
import { ImageGallery, type GalleryImage } from "./image-gallery.ts";
import {
	createImagePlaceholder,
	looksLikeImagePath,
	removeImagePlaceholders,
	sortByPlaceholderNumber,
	SINGLE_IMAGE_PLACEHOLDER_RE,
} from "./path-utils.ts";
import { PREFER_INLINE_SCREENSHOT_PROMPT } from "./prompt.ts";
import { upgradeScreenshotToolResult } from "./tool-result-upgrader.ts";

// ── Types ──────────────────────────────────────────────────

export type DraftAttachment = {
	placeholder: string;
	image: ImageContent;
	label: string;
	originalPath: string;
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
		notify(message: string, type?: "info" | "warning" | "error"): void;
		theme: any;
	};
};

// ── Constants ──────────────────────────────────────────────

const WIDGET_KEY = "image-preview";
const POLL_INTERVAL_MS = 250;

// Matches absolute paths ending in image extensions.
const IMAGE_PATH_RE =
	/((?:\/[\w.@~\-]+)+\.(?:png|jpe?g|gif|webp))\b/gi;

// ── Extension ──────────────────────────────────────────────

export function registerImagePreviewExtension(
	pi: PiLike,
	deps: ExtensionDeps,
): void {
	let attachments: DraftAttachment[] = [];
	let gallery: ImageGallery | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	let latestCtx: CtxLike | null = null;
	let lastText = "";

	// ── Helpers ────────────────────────────────────────────

	function nextPlaceholderNumber(): number {
		const maxNum = attachments.reduce((highest, a) => {
			const m = a.placeholder.match(SINGLE_IMAGE_PLACEHOLDER_RE);
			return Math.max(highest, m ? Number.parseInt(m[1] ?? "0", 10) : 0);
		}, 0);
		return maxNum + 1;
	}

	/** Remove attachments whose placeholder is no longer in the text */
	function syncAttachments(editorText: string): boolean {
		const before = attachments.length;
		attachments = attachments.filter((a) =>
			editorText.includes(a.placeholder),
		);
		return attachments.length !== before;
	}

	function refreshWidget(ctx: CtxLike): void {
		if (attachments.length === 0) {
			gallery = null;
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}

		const galleryImages: GalleryImage[] = attachments.map((a) => ({
			data: a.image.data,
			mimeType: a.image.mimeType,
			label: a.label,
			placeholder: a.placeholder,
		}));

		const count = attachments.length;
		const header = count === 1
			? "📎 1 image attached"
			: `📎 ${count} images attached`;

		// Use string array first to verify widget mechanism works,
		// then upgrade to component factory for kitty image rendering
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui: any, theme: any) => {
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
		// Dispose gallery to delete kitty images before clearing widget
		if (gallery) {
			gallery.dispose();
			gallery = null;
		}
		attachments = [];
		lastText = "";
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	/**
	 * Scan editor text for raw image file paths.
	 * When found: read image, replace path with [Image #N], add to attachments.
	 */
	function scanAndReplace(ctx: CtxLike): void {
		let text: string;
		try {
			text = ctx.ui.getEditorText();
		} catch {
			return;
		}
		if (!text || text === lastText) return;

		let changed = false;
		const trackedPaths = new Set(attachments.map((a) => a.originalPath));

		// Reset regex lastIndex (global flag)
		IMAGE_PATH_RE.lastIndex = 0;
		const matches = [...text.matchAll(IMAGE_PATH_RE)];

		for (const match of matches) {
			const rawPath = match[1];
			if (!rawPath || trackedPaths.has(rawPath)) continue;
			if (!looksLikeImagePath(rawPath)) continue;

			const image = deps.readImageContentFromPath(rawPath);
			if (!image) continue;

			const placeholder = createImagePlaceholder(nextPlaceholderNumber());
			attachments.push({
				placeholder,
				image,
				label: path.basename(rawPath),
				originalPath: rawPath,
			});
			trackedPaths.add(rawPath);

			text = text.replace(rawPath, placeholder);
			changed = true;

			// Async resize in background
			if (deps.maybeResizeImage) {
				const att = attachments[attachments.length - 1];
				void deps.maybeResizeImage(image).then((resized) => {
					att.image = resized;
					if (latestCtx) refreshWidget(latestCtx);
				}).catch(() => {});
			}
		}

		if (changed) {
			try {
				ctx.ui.setEditorText(text);
			} catch {
				return;
			}
		}

		lastText = changed ? text : ctx.ui.getEditorText();

		// Sync: remove attachments whose placeholders were deleted
		const didSync = syncAttachments(lastText);

		if (changed || didSync) {
			refreshWidget(ctx);
		}
	}

	/** Poll loop */
	function pollEditorText(): void {
		if (!latestCtx) return;
		try {
			scanAndReplace(latestCtx);
		} catch {
			// Silently ignore errors during polling
		}
	}

	function startPolling(): void {
		stopPolling();
		pollTimer = setInterval(pollEditorText, POLL_INTERVAL_MS);
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

	// On submit: strip placeholders, attach images
	pi.on("input", async (event: any, ctx: CtxLike) => {
		latestCtx = ctx;

		if (attachments.length === 0) {
			return { action: "continue" as const };
		}

		const fullText = (event.text as string || "").trim();

		// Find which placeholders are in the submitted text
		const usedAttachments = sortByPlaceholderNumber(
			attachments.filter((a) => fullText.includes(a.placeholder)),
		);

		if (usedAttachments.length === 0) {
			return { action: "continue" as const };
		}

		// Don't transform commands or shell escapes
		if (fullText.startsWith("/") || fullText.trimStart().startsWith("!")) {
			return { action: "continue" as const };
		}

		const transformedText = removeImagePlaceholders(fullText);
		const images = usedAttachments.map((a) => a.image);

		// Clear state
		resetDraft(ctx);

		if (!transformedText) {
			// Images only, no text — send directly
			pi.sendUserMessage(
				images,
				ctx.isIdle() ? undefined : { deliverAs: "steer" },
			);
			return { action: "handled" as const };
		}

		return {
			action: "transform" as const,
			text: transformedText,
			images: [...(event.images ?? []), ...images],
		};
	});
}
