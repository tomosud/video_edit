# Caption Editing Plan

## Goal

Add simple caption editing to the existing edit timeline without introducing a full independent subtitle track.

## Model

- Captions belong to output clip instances, not materials.
- The same material can be dropped into the edit timeline multiple times, and each output clip can have a different caption.
- Each output clip can have at most one caption.
- A caption is anchored to its owning output clip but can extend across neighboring clip time.

Suggested shape:

```js
{
  id: 'out_...',
  materialId: 'mat_...',
  caption: {
    text: '',
    startMs: 0,
    endMs: 3200
  }
}
```

`startMs` and `endMs` are absolute times within the full output sequence.

## Timeline UI

- Make output clip width proportional to its duration.
- Keep a minimum visible clip width so short clips remain usable.
- Add zoom controls to the edit timeline.
- Show each caption as a bar attached to its owning output clip.
- Allow dragging caption start/end handles.
- When one caption expands into a neighbor, automatically compress the neighbor caption to avoid overlap.
- Show density warning colors when caption text is too long for its display time:
  - normal: under 8 chars/sec
  - warning: 8-12 chars/sec
  - danger: over 12 chars/sec

## Caption Text Behavior

- Long text can include line breaks.
- During playback/export, line breaks split the caption display across the caption duration.
- Example: 3 lines over 6 seconds means each line is shown for about 2 seconds.

## Total Caption Editor

- Add a caption editor panel below/near the edit timeline.
- Show one text area per output clip, in edit order.
- Editing a caption in the timeline or in the panel updates the same data.
- Selecting a caption/clip in the timeline focuses the corresponding text area.

## Rendering

- Overlay the active caption on preview canvases and export output.
- Use a simple readable default style:
  - lower-third placement
  - white text
  - dark translucent background or strong shadow

## First Implementation Scope

- Data migration/defaults for `output.caption`.
- Time-proportional output timeline with zoom and minimum width.
- Caption text panel.
- Caption bars with resize handles.
- Automatic neighbor compression.
- Density warning colors.
- Preview/export caption rendering.
