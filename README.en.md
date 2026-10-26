# Markumo

[简体中文](README.md) | **English**

A lightweight desktop editor for text and Markdown. Open a single file or organize a project in a folder workspace, with text editing, code editing, Markdown writing, and media previews in one window.

[Download](https://github.com/yuanmahome/Markumo/releases/latest) · [Report an issue](https://github.com/yuanmahome/Markumo/issues) · [License](LICENSE)

## Features

- **Text and code**: syntax highlighting for multiple languages, line numbers, folding, find and replace, regular expressions, and encoding and line-ending settings.
- **Markdown writing**: live editing, source, and split preview modes, with tables, task lists, images, math formulas, and Mermaid diagrams.
- **Tabs and split panes**: drag tabs, split horizontally or vertically, edit the same document across panes, and restore your previous session.
- **Files and workspaces**: a file tree, recent files, quick open, workspace search and replace, and drag-and-drop support for files and folders.
- **Images and PDFs**: built-in viewers that share tabs and split panes with text documents. The PDF viewer supports continuous scrolling, thumbnails, and outline navigation.
- **Import and export**: import HTML and Word; export HTML, PDF, Word, and long PNG images. Word import requires a separate [Pandoc installation](https://pandoc.org/installing.html).
- **Customization**: themes, fonts, syntax colors, smooth caret animation, and focus mode, with Markumo, Fleet, and Typora shortcut presets and custom bindings.
- **File protection**: unsaved-change prompts, autosave, file history, crash recovery, and external-change conflict detection.
- **In-app updates**: check for and download updates, verify their signatures, and choose when to install and restart.

## Installation and usage

Download the package for your operating system from [Releases](https://github.com/yuanmahome/Markumo/releases/latest).

| System | Installation |
| --- | --- |
| Windows | Run the EXE installer |
| macOS | Open the DMG and drag the app into Applications; Apple Silicon and Intel are supported |
| Linux | Use the AppImage or install the DEB package |

Open a file or folder from the menu, or drag it into the window. On Windows, you can also use “Open with” or the “Open with Markumo” context-menu entry, which may appear under “Show more options.”

Access in-app updates from the title bar or settings. On Linux, in-app updates are available for AppImage installations; DEB users should download and install the updated package.

Windows installers do not currently have a commercial code-signing certificate. macOS builds use ad-hoc signing and are not notarized, so first launch may require confirmation in system settings. In-app updates use a separate signature-verification mechanism.

## Local development

### Prerequisites

- Node.js LTS, pnpm, and the stable Rust toolchain.
- Windows: MSVC, Visual Studio Desktop development with C++, Windows SDK, and WebView2 Runtime.
- macOS: Xcode Command Line Tools.
- Linux: desktop development dependencies, including WebKitGTK.

See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for system dependency installation instructions.

### Get the source

```sh
git clone https://github.com/yuanmahome/Markumo.git
cd Markumo
pnpm install --frozen-lockfile
```

### Start the development environment

```sh
pnpm tauri dev
```

Desktop development enables hot reload by default. Use `pnpm tauri dev --no-watch` to disable automatic restarts and frontend hot reload. Development data is stored in `.markumo-dev/`; set `MARKUMO_DEV_DATA_DIR` to use a different directory.

For a browser-only preview, run:

```sh
pnpm dev
```

Visit `http://localhost:1420`. Browser mode supports interface development and in-memory drafts; desktop file operations require Tauri. Both development modes use the same port, so run only one at a time.

### Check and build

```sh
pnpm check
cargo check --manifest-path src-tauri/Cargo.toml
```

`pnpm check` runs type checking and the frontend build. You can also run `pnpm typecheck` and `pnpm build` separately. Frontend output is written to `dist/`.

## Build installers

Windows:

```powershell
.\build.bat
```

macOS / Linux:

```sh
sh build.sh
```

The scripts install locked dependencies and build packages for the host operating system. Use `--check` to check prerequisites only, or `--skip-install` to skip dependency installation. Build each platform's packages on that operating system.

By default, packages are written to `src-tauri/target/release/bundle/`, in format-specific directories such as `nsis/`, `macos/`, `dmg/`, `deb/`, or `appimage/`. With a custom Cargo output directory or compilation target, follow the paths printed in the build log.

See the [release guide](docs/releasing.md) for publishing and update-signing configuration. The guide is in Chinese.

### Build failures after moving the project

If a build fails with `failed to read plugin permissions` after moving or renaming the project, and the error references the old location, cached Tauri permission files may still contain absolute paths to that location. Clear the cache, then run the packaging script again:

```sh
cargo clean --manifest-path src-tauri/Cargo.toml
```

This command removes Rust build output, so the next compilation will take longer. Avoid copying `target/` directories when moving the source.

## Project structure

```text
src/          Interface, editors, and application features
src-tauri/    Rust desktop services, app icons, and system integration
scripts/      Development, packaging, and release scripts
public/       Static assets
docs/         Release guide and changelogs
```

The interface uses Vue, TypeScript, and Vite. Desktop services use Rust and Tauri. Text and code editing use CodeMirror, while live Markdown editing uses ProseMirror, with Markdown-it, KaTeX, and Mermaid for rendering.

## License

Licensed under the [GNU Affero General Public License (AGPL-3.0-only)](LICENSE). Third-party dependencies retain their respective licenses and copyright notices.
