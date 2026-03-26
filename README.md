# pi-image-preview

Image preview extension for [pi coding agent](https://github.com/mariozechner/pi-coding-agent) — renders inline image thumbnails above the editor using the kitty graphics protocol with full tmux support.

![Screenshot](screenshot.png)

## Features

- **Inline image preview** — paste an image (Ctrl+V) or drop a file, and a thumbnail renders above the editor
- **Horizontal layout** — multiple images display side by side: `[Image #1]  [Image #2]`
- **tmux support** — uses kitty's Unicode placeholder protocol so images stay in their pane (no ghosting across panes)
- **Auto-cleanup** — delete `[Image #1]` from your text and the preview disappears
- **No editor conflicts** — works alongside vim mode and other editor extensions (no `setEditorComponent`)
- **Image resizing** — uses pi's built-in WASM image resizer for efficient thumbnails
- **Screenshot integration** — automatically loads images from screenshot tool results

## Install

```bash
pi install npm:pi-image-preview
```

## How it works

1. **Paste** an image with `Ctrl+V` or drag-and-drop a file
2. Pi's built-in handler saves the clipboard to a temp file and inserts the path into the editor
3. The extension **detects the image path** (via polling), reads the image, and replaces the path with `[Image #1]`
4. A **thumbnail gallery** renders above the editor using kitty's Unicode placeholder protocol
5. On **submit**, placeholders are stripped and images are attached to your message

### tmux compatibility

Standard kitty graphics render pixels at absolute terminal positions, causing images to "ghost" across tmux panes. This extension uses kitty's **Unicode placeholder protocol** (`U=1`) instead:

- Image data is transmitted to kitty but not directly displayed
- Special `U+10EEEE` characters with diacritics mark where the image goes
- These are regular text characters that tmux manages per-pane
- Images appear/disappear naturally when switching panes

### Layout

```
📎 2 images attached
┌──────────────┐  ┌──────────────┐
│   image 1    │  │   image 2    │
│  thumbnail   │  │  thumbnail   │
└──────────────┘  └──────────────┘
   [Image #1]        [Image #2]

[Image #1] describe what you see [Image #2]
```

## Requirements

- [kitty](https://sw.kovidgoyal.net/kitty/) terminal (for image rendering)
- Works in tmux with `allow-passthrough all` set in `tmux.conf`
- Falls back to text labels in non-kitty terminals

## License

MIT
