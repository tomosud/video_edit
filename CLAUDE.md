# ViralCut Development Rules

Rules for humans and AI assistants working in this repository.

## Responsibilities

- The user handles git commits and pushes. The assistant may change code, add comments, and update documentation, but must not commit unless explicitly instructed.
- Browser-based verification is handled by the user. The assistant should run static checks, Node syntax checks, and browser-independent logic checks where useful. Visual checks and real video interaction checks in an actual browser should be left to the user.
- Use the root `run_local.bat` script for local startup. The default URL is `http://localhost:8000`.
- ViralCut must remain a lightweight editor that runs entirely in the browser. Do not reintroduce project-folder saves, Open flows, or file-handle save behavior.

## Technical Requirements

- Keep the app as a static site that can be hosted on GitHub Pages. Do not add a build step or server-side processing.
- Prefer the existing Vanilla JavaScript ES modules, HTML, and CSS structure.
- Editing state and added video `File` objects are autosaved to IndexedDB and restored on reload. Do not create project folders on the filesystem.
- Use only licenses that allow commercial use. Before adding external libraries, external models, weights, or similar dependencies, verify the license and document it in `README.md` if that file exists, otherwise in `PROJECT_STATUS.md`.

## Workflow

- Save tokens and develop incrementally. Avoid large changes in one pass; verify each step before moving on.
- Do not add too many Markdown files at the repository root. As a rule, keep project notes centered on `CLAUDE.md` and `PROJECT_STATUS.md`. Create new planning-only Markdown files only when the user explicitly asks.
- Separate current specifications from history. Current behavior and status belong in `PROJECT_STATUS.md`. Do not keep failed approaches, exploration logs, or old specifications at the repository root.
- Keep `PROJECT_STATUS.md` focused on the current state. Do not keep appending long implementation logs or trial-and-error notes. Limit it to the current structure, implemented behavior, pending verification, and short summaries of recent changes.
- Verify browser-independent logic with Node-based synthetic tests or `node --check` before wiring it into the app. Real video appearance and interaction checks are the user's browser-test responsibility.
- When changing JS or CSS, update the version string in `index.html` for every importmap, script, and stylesheet `?v=...` entry. All such entries should use the same value. Do not add query strings to imports inside `js/` files.

## Encoding

- Do not proceed as if a file was read correctly when the text is mojibake or otherwise garbled. If Japanese comments or Markdown text appear corrupted while reading `CLAUDE.md`, source files, or Markdown files, first change the reading method, such as explicitly using UTF-8, until the content is readable.
- If changing the encoding or read method still does not make the content readable, stop. Do not continue editing or implementing based on guesses. Report which file could not be read and which methods were tried, then wait for the user's instruction.
