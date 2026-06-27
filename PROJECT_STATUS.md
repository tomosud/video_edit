# ViralCut Current Status

Last updated: 2026-06-27

This file is the single source of truth for the current implementation. Older planning and handoff Markdown files were removed because they described pre-Mediabunny or partially obsolete designs and had become hard to trust.

## What This App Is

ViralCut is a local browser-based vertical video editor.

- Input: local video files selected through the browser.
- Main workflow: create source clips, arrange them as output clips, crop to 9:16, export MP4.
- Runtime target: Chrome / Edge on localhost or GitHub Pages-style static hosting.
- Core code style: vanilla JavaScript ES modules, no bundler.
- Current media stack: Mediabunny + WebCodecs for metadata, frame extraction, and deterministic export; HTMLVideoElement is still used for the interactive source preview and native playback.

## Current Architecture

### State Model

The project state is centered on three object types:

- `Source`: imported video metadata and file identity.
- `Material`: a reusable source range, stored as `in` / `out`.
- `Output`: an arranged output clip that references one `Material` and stores crop settings.

The central store is [js/store.js](js/store.js). Selection is a single `{ kind, id }` value and drives shelf, timeline, preview, and output highlighting.

### Main Modules

- [js/app.js](js/app.js): app wiring, source preview transport, range playback, selection side effects, seek bar, export command.
- [js/fileOpen.js](js/fileOpen.js): source file selection, relinking, object URL management, fallback probing.
- [js/mediaInfo.js](js/mediaInfo.js): Mediabunny-based metadata probing.
- [js/mediaSession.js](js/mediaSession.js): shared Mediabunny `Input` / `CanvasSink` sessions for exact frame reads.
- [js/thumbnails.js](js/thumbnails.js): source timeline thumbnail generation.
- [js/sourceTimeline.js](js/sourceTimeline.js): zoomable source timeline, material bands, source playhead.
- [js/frameStrip.js](js/frameStrip.js): per-frame strip around the current preview frame.
- [js/cropPreview.js](js/cropPreview.js): 9:16 canvas crop preview.
- [js/previewSequence.js](js/previewSequence.js): deterministic output-sequence preview via Mediabunny frame reads.
- [js/export.js](js/export.js): deterministic frame export through Mediabunny `Output`, `CanvasSource`, and `AudioSampleSource`.
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
- The 9:16 crop preview fits within its column without reserving a wide blank side area.
- Source preview crop and vertical preview crop have independent edit modes and independent saved settings.
- Double-clicking either preview toggles its crop edit mode.
- Crop sliders appear only while that preview is in crop edit mode, with a reset button.
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

This section records the changes made in the current debugging round.

### Frame/Time Utilities

Added frame helpers in [js/util.js](js/util.js):

- `frameFromTime(time, fps, maxFrame)`
- `frameStartTime(frame, fps)`
- `frameProbeTime(frame, fps, duration)`
- `seekVideoFrame(video, frame, fps, duration)`
- `makeFrameScrubber(video, fpsOf, durationOf)`

Purpose: centralize frame/time conversion and stop scattering `video.currentTime = frame / fps` through the app.

### Source Preview Seeking

Updated [js/app.js](js/app.js), [js/sourceTimeline.js](js/sourceTimeline.js), and [js/frameStrip.js](js/frameStrip.js) so UI-initiated seeks use frame-center probe time instead of exact frame boundary time.

This fixed the observed mismatch where the frame strip showed a white/black frame but the source preview displayed the previous frame.

### Per-Frame Strip

Updated [js/frameStrip.js](js/frameStrip.js):

- Current frame now uses `frameFromTime()` instead of `Math.round(video.currentTime * fps)`.
- Click/wheel seeks go through `seekVideoFrame()`.
- Valid frame range is now `0..totalFrames-1`.
- Exclusive out range is capped at `totalFrames`, not `totalFrames + 1`.

### Mediabunny Exact Frame Reads

Updated [js/mediaSession.js](js/mediaSession.js):

- `getVideoFrameCanvas()` now queries `CanvasSink.getCanvas()` using `frameProbeTime(frame, fps, duration)`.

Purpose: avoid querying exactly at `frame / fps`, which can return the previous sample when real media timestamps do not line up perfectly with nominal FPS boundaries.

### Output Preview And Export Bounds

Updated [js/previewSequence.js](js/previewSequence.js) and [js/export.js](js/export.js):

- `inFrame` is clamped to the last valid visible frame.
- `outFrame` is clamped to `totalFrames`.
- `outFrame` remains exclusive.

The export path was already visually correct in testing, but this removes the old `maxFrame + 1` allowance that could create an invalid extra frame at the end of a source.

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
