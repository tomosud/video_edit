# ViralCut Current Status

Note: the latest implementation summary is now in [CURRENT_IMPLEMENTATION.md](CURRENT_IMPLEMENTATION.md).
This file is older historical status from 2026-07-07.

Last updated: 2026-07-07

This file is the single source of truth for the current implementation. Older planning and handoff Markdown files were removed because they described pre-Mediabunny or partially obsolete designs and had become hard to trust.

## What This App Is

ViralCut is a browser-only lightweight video editing tool.

- Input: local video or image files selected or dropped into the browser. Images are converted locally to 30-second video sources, with the longest edge limited to 3840px.
- Main workflow: add videos, create source clips, arrange them as output clips, crop, export MP4.
- Runtime target: Chrome / Edge on localhost or GitHub Pages-style static hosting.
- Core code style: vanilla JavaScript ES modules, no bundler.
- Current media stack: Mediabunny + WebCodecs for metadata, frame extraction, and deterministic export; HTMLVideoElement is still used for the interactive source preview and native playback.

## Browser Persistence Model

ViralCut no longer has a project-folder save/open workflow.

- Editing state is autosaved to IndexedDB under the `viralcut` database.
- Added media `File` objects are also stored in IndexedDB when the browser allows it.
- Reload restores the last edit and re-registers saved media object URLs.
- `New` asks twice when work exists, then clears autosave, history, saved media, and in-memory object URLs.
- Export always uses browser download behavior; it does not write into a chosen project folder.
- Video and image files can be added by clicking `Add Video` or by dropping them on the `Add Video` button.
- Export layout is selected with buttons after pressing `ExportVideo`: vertical 9:16, horizontal 16:9, or both.
- Each caption can be switched to `Title` from its text-edit panel. Titles render large at screen center without the caption background box in previews and exports.

## Current Architecture

### State Model

The project state is centered on three object types:

- `Source`: imported video/image metadata and file identity.
- `Material`: a reusable source range, stored as `in` / `out`.
- `Output`: an arranged output clip that references one `Material` and stores crop settings.

The central store is [js/store.js](js/store.js). Selection is a single `{ kind, id }` value and drives shelf, timeline, preview, and output highlighting.

### Main Modules

- [js/app.js](js/app.js): app wiring, source preview transport, range playback, selection side effects, seek bar, export command.
- [js/fileOpen.js](js/fileOpen.js): source file selection/drop registration, IndexedDB media persistence, object URL management, fallback probing.
- [js/mediaInfo.js](js/mediaInfo.js): Mediabunny-based metadata probing.
- [js/mediaSession.js](js/mediaSession.js): shared Mediabunny `Input` / `CanvasSink` sessions for exact frame reads.
- [js/thumbnails.js](js/thumbnails.js): source timeline thumbnail generation.
- [js/sourceTimeline.js](js/sourceTimeline.js): zoomable source timeline, material bands, source playhead.
- [js/frameStrip.js](js/frameStrip.js): per-frame strip around the current preview frame.
- [js/horizontalPreview.js](js/horizontalPreview.js): 16:9 canvas preview with horizontal crop / pan / zoom / blur.
- [js/cropPreview.js](js/cropPreview.js): 9:16 canvas crop preview.
- [js/previewSequence.js](js/previewSequence.js): deterministic output-sequence preview via Mediabunny frame reads.
- [js/export.js](js/export.js): deterministic vertical/horizontal frame export through Mediabunny `Output`, `CanvasSource`, and `AudioSampleSource`.
- [js/util.js](js/util.js): shared helpers for formatting, hashing, scrubbing, and frame/time conversion.

## UI Design

The UI is organized into three focusable work areas:

- `1 Timeline`: source overview, zoomed source timeline, and per-frame timeline.
- `2 Materials`: cutout material shelf, source preview, and 9:16 crop preview.
- `3 Edit`: output sequence and sequence playback controls.

Clicking inside an area makes it the active shortcut target. The active area is shown with a subtle border. Current shortcut behavior:

- Timeline or Materials area: `Space` toggles the source preview.
- Edit area: `Space` pauses/resumes the output sequence, or starts from the beginning if no sequence is active.
- `Delete` / `Backspace` deletes the current selection after confirmation.

Timeline behavior:

- The overview/minimap is always full-source and is displayed above the zoomed source timeline.
- The zoomed source timeline and the per-frame timeline both support material selection and edit entry.
- Single-click seeks the preview/playhead to that point.
- Double-clicking a point covered by existing materials enters material edit mode instead of creating a new material.
- If multiple materials overlap at the double-clicked point, all overlapping materials enter edit mode.
- Only materials in edit mode can be moved or resized.
- When sliding overlapping editable materials, the shortest material under the pointer has priority.
- Double-clicking empty timeline space exits edit mode if a material is being edited.
- Double-clicking empty timeline space creates a new material if no material is being edited, then enters edit mode for it.

This resolves the original ambiguity between "double-click empty space creates a material" and "double-click empty space exits edit mode" by making edit exit take priority when already editing.

Materials and preview behavior:

- Source preview controls are hidden because source range playback is always looped.
- The material shelf uses smaller cards for larger clip counts.
- Material thumbnails do not show delete buttons; deletion is only through `Delete` / `Backspace` with confirmation.
- Material thumbnail wheel changes card size.
- Double-clicking material title text edits it inline. Double-clicking elsewhere on the card plays the material.
- The horizontal preview is a 16:9 canvas. It fits the source by height at default zoom, regardless of source aspect ratio, then allows pan / zoom / blur adjustment.
- The 9:16 crop preview fits within its column without reserving a wide blank side area.
- Horizontal preview crop and vertical preview crop have independent edit modes and independent saved settings.
- Double-clicking either preview toggles its crop edit mode.
- Crop sliders appear only while that preview is in crop edit mode, with a reset button.
- Crop sliders are laid out below the preview surface and must not overlap video/canvas content.
- When crop controls appear or disappear, the vertical preview canvas is resized to the remaining preview surface so the UI does not clip the canvas.
- The native source `<video>` is hidden and kept as a decode/playback source; the visible source preview is the horizontal canvas.
- The horizontal and vertical crop blur (`B`) defaults to `1`.
- In normal mode, hover shows `Double-click to edit crop`.

Edit area behavior:

- `Play From Start` always starts the output sequence from the first output clip.
- The pause button toggles between `Pause` and `Resume`.
- Double-clicking an output clip plays continuously from that clicked clip to the end of the sequence.

Text policy:

- UI labels, status messages, prompts, error messages, and code comments should be English-only unless a specific future feature explicitly requires localized copy.

## Frame Model

The intended editing model is frame based:

- Clip ranges are treated as `[inFrame, outFrame)`.
- The last visible frame in a clip is `outFrame - 1`.
- `outFrame` is exclusive and must never be allowed to become `totalFrames + 1`.
- UI frame labels should use floor-style frame lookup, not round-style lookup.
- Display probing should avoid exact frame boundaries because browser video seeking and Mediabunny single-frame lookup can resolve boundary timestamps differently.

Mediabunny behavior that matters:

- `CanvasSink.getCanvas(timestamp)` returns the last frame whose timestamp is less than or equal to the given timestamp.
- `CanvasSink.canvases(start, end)` yields frames in `[start, end)`.
- Because of that, exact boundary timestamps are ambiguous for preview UI. The app now uses a frame-center probe for display lookup.

## Work Done In The Latest Pass

This section records the changes made on 2026-07-07.

### Browser Autosave Conversion

Updated [index.html](index.html), [js/app.js](js/app.js), [js/store.js](js/store.js), [js/db.js](js/db.js), [js/fileOpen.js](js/fileOpen.js), and [js/projectStore.js](js/projectStore.js):

- Removed the project-folder open/save workflow from the active UI.
- `New` now clears the browser autosave instead of choosing a folder.
- Startup restores the last autosaved edit from IndexedDB when available.
- Project state, undo/redo history, and added video `File` objects are saved in IndexedDB.
- File System Access handles are still not saved.
- Export always uses browser download behavior.

### Video Add Drop Target

Updated [index.html](index.html), [css/style.css](css/style.css), [js/app.js](js/app.js), and [js/fileOpen.js](js/fileOpen.js):

- `Add Video` remains enabled from startup.
- Clicking `Add Video` can select one or more videos or images.
- Dropping video or image files on `Add Video` adds them to the current edit.
- Images are encoded locally as compact 30-second MP4 sources; dimensions preserve aspect ratio and the longest edge is capped at 3840px.
- Selected/dropped files are saved to IndexedDB for reload recovery.

### Export Layout Selection

Updated [index.html](index.html), [js/app.js](js/app.js), and [js/export.js](js/export.js):

- Added a header export layout selector: vertical 9:16, horizontal 16:9, or both.
- Vertical export uses each material's vertical crop settings.
- Horizontal export uses each material's source-preview crop settings.
- `Both` writes separate `-vertical.mp4` and `-horizontal.mp4` downloads.

### Mediabunny Import Fix

Follow-up fix after browser testing:

- A mixed cache-buster state loaded multiple `store.js` module instances, so timeline-created materials could appear in one module graph while the Materials shelf still read another empty store.
- Mediabunny was also imported directly from multiple modules with cache-busted URLs, which triggered its `Mediabunny was loaded twice` warning and broke thumbnail/frame-read behavior.
- Added [js/mediabunny.js](js/mediabunny.js) as the single Mediabunny import point.
- All app module imports now use one cache-buster value, while `mediabunny.min.js` itself is imported once without a query string.

### UI Flow Adjustments

Follow-up changes:

- `New` asks twice before clearing an edit when any source, material, or output exists.
- `Add Video` blinks red while no video has been added.
- The export layout dropdown was removed. `ExportVideo` now opens an in-app button dialog for `Vertical 9:16`, `Horizontal 16:9`, or `Both`.
- The overview timeline is thinner and the cut-edit timeline is taller and visually emphasized.
- The cut-edit timeline blinks when the active source has no cuts.
- Hovering the cut-edit timeline shows simple English guidance: double-click to cut, or double-click a cut to edit.

### Horizontal Crop Preview

Follow-up changes:

- Replaced the visible source preview surface with a 16:9 canvas.
- Horizontal preview uses height-fit placement at default zoom, so portrait or non-16:9 sources are placed upright inside a 16:9 canvas instead of relying on native video aspect display.
- Horizontal crop settings are stored per material as `horizontalCrop` and are also copied when creating new materials from either timeline.
- Horizontal export uses the same height-fit crop model as the horizontal preview.
- Vertical and horizontal crop blur defaults are both `1`.

## Current Known Issue

### Native Source Playback Can Still Show The Next Frame At Range End

Current status:

- Static frame display now matches the selected per-frame strip frame.
- Export output is considered correct.
- Native source playback may still sometimes show one frame beyond the intended range before the monitor loop pauses or seeks back.

Likely cause:

- The source preview playback still uses `HTMLVideoElement.play()`.
- The app checks the range end from `requestAnimationFrame`.
- The browser may decode and paint the next frame before JavaScript observes that `currentTime` crossed the exclusive out boundary.

This is not the same bug as the fixed seek mismatch. It is a playback-control precision problem.

Best next solution:

- Replace range playback preview with a deterministic canvas playback path:
  - Use frame indexes `[inFrame, outFrame)`.
  - Draw each frame with Mediabunny `CanvasSink` or cached frame canvases.
  - Advance by an app-owned clock.
  - Keep native `<video>` only for rough source playback or audio-assisted preview if needed.

Short-term mitigation:

- Continue using an early end guard before `outFrame / fps`.
- Accept that native `<video>` cannot guarantee frame-perfect stopping in all cases.

## Verification Done

Ran syntax checks:

```powershell
node --check js\util.js
node --check js\app.js
node --check js\sourceTimeline.js
node --check js\frameStrip.js
node --check js\mediaSession.js
node --check js\previewSequence.js
node --check js\export.js
```

All passed.

Manual result reported after the latest changes:

- Per-frame strip selection and source preview display now match.
- Range playback still has intermittent one-frame end leakage.

## How To Run

Use the existing batch file:

```bat
run_local.bat
```

Then open:

```text
http://localhost:8000
```

If JavaScript changes do not appear, hard reload the browser because the app uses a service worker for COOP/COEP behavior.

## Practical Development Notes

- Keep export and preview frame semantics aligned around `[inFrame, outFrame)`.
- Do not reintroduce `outFrame = totalFrames + 1`.
- Avoid using `Math.round(video.currentTime * fps)` for current frame display.
- Avoid using `video.currentTime = frame / fps` for frame-accurate display.
- For exact still frames, prefer `getVideoFrameCanvas(source, frame, fps, opts)`.
- For native preview seeking, use `seekVideoFrame(video, frame, fps, duration)`.
- For truly frame-perfect playback, implement a canvas playback path instead of trying to make native `<video>.play()` stop exactly.

## Removed Markdown Files

The following files were removed and replaced by this document:

- `DESIGN.md`
- `HANDOFF.md`
- `MEDIABUNNY_REWRITE_PLAN.md`

They contained obsolete implementation plans, conflicted with the current Mediabunny/WebCodecs implementation, and were not reliable as handoff material.
