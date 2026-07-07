# ViralCut

ブラウザだけで動く、シンプルな動画編集アプリ。
プロジェクトの保存はできません。横型、縦型動画を同時に編集できます。

A simple video editing app that runs entirely in your browser.
You cannot save projects. You can edit landscape and portrait videos at the same time.

<img width="1906" height="942" alt="image" src="https://github.com/user-attachments/assets/fec2bf93-2fd1-459a-8350-865cc6aac28e" />



https://tomosud.github.io/video_edit/



https://github.com/user-attachments/assets/2f78c3a2-bd52-47a0-9cd5-3c45e27d1c89



## Features

- Add local videos from the browser.
- Drop video files onto `Add Video`.
- Create reusable cuts on the source timeline.
- Arrange cuts in the edit timeline.
- Adjust independent crop settings for:
  - horizontal 16:9 preview/export
  - vertical 9:16 preview/export
- Export MP4 as vertical, horizontal, or both.
- Autosave the current edit state to IndexedDB so reload does not immediately lose work.
- No project folder is written to disk.

## Running Locally

Use the included batch file:

```bat
run_local.bat
```

Then open the local URL shown by the script, usually:

```text
http://127.0.0.1:8000
```

The app uses browser APIs for media decoding and export, so Chrome or Edge is recommended.

## GitHub Pages

This repository is a static site. No build step and no custom GitHub Actions workflow are required.

Recommended Pages settings:

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`

After pushing changes, GitHub Pages may take a few minutes to update.

## Data Model

ViralCut is designed as a lightweight temporary editor:

- Source video files stay local to the browser.
- Edit state and saved file references are stored in IndexedDB when the browser allows it.
- `New` clears the current browser edit state.
- Export uses normal browser download behavior.

## Development Notes

- Keep the app static and GitHub Pages compatible.
- Do not add a build system or server-side dependency unless the project direction changes.
- If JavaScript files change, update the cache-buster query in `index.html`.
- Browser visual verification is done manually by the user.

## Main Files

- `index.html` - application shell
- `css/style.css` - UI styling
- `js/app.js` - application wiring and export flow
- `js/store.js` - central edit state and IndexedDB autosave integration
- `js/sourceTimeline.js` - source timeline and cut editing
- `js/horizontalPreview.js` - 16:9 crop preview
- `js/cropPreview.js` - 9:16 crop preview
- `js/export.js` - MP4 export

## License

This project is intended to use commercially usable licenses only. External libraries or model weights must be license-checked before being added.
