# Markumo

**简体中文** | [English](README.en.md)

轻量的桌面文本与 Markdown 编辑器。既能随手打开单个文件，也能通过文件夹工作区管理项目，在同一个窗口中编辑文本、编写代码、整理 Markdown 和预览媒体文件。

[下载安装包](https://github.com/yuanmahome/Markumo/releases/latest) · [问题反馈](https://github.com/yuanmahome/Markumo/issues) · [开源协议](LICENSE)

## 功能

- **文本与代码**：多语言语法高亮、行号、折叠、查找替换、正则表达式，以及编码与换行格式设置。
- **Markdown 写作**：即时排版、源码和双栏模式，支持表格、任务列表、图片、数学公式与 Mermaid 图表。
- **多标签与分栏**：拖动标签、上下或左右分栏，在多个窗格中同步编辑同一文档，并恢复上次的工作现场。
- **文件与工作区**：目录树、最近文件、快速打开、工作区搜索与替换；支持拖入文件和文件夹。
- **图片与 PDF**：内置媒体查看器，与文本文档共用标签和分栏；PDF 支持连续滚动、缩略图和大纲导航。
- **导入与导出**：导入 HTML、Word，导出 HTML、PDF、Word 和 PNG 长图。Word 导入需要另行安装 [Pandoc](https://pandoc.org/installing.html)。
- **个性化设置**：主题、字体、语法配色、平滑光标和专注模式；支持 Markumo、Fleet、Typora 快捷键方案与自定义绑定。
- **文件保护**：未保存提示、自动保存、历史记录、崩溃恢复和外部修改冲突检查。
- **应用内更新**：支持检查和下载更新，验证签名后由用户决定安装与重启。

## 安装与使用

从 [Releases](https://github.com/yuanmahome/Markumo/releases/latest) 下载适合当前系统的安装包。

| 系统 | 安装方式 |
| --- | --- |
| Windows | 运行 EXE 安装包 |
| macOS | 打开 DMG，将应用拖入 Applications；支持 Apple Silicon 和 Intel |
| Linux | 使用 AppImage，或安装 DEB 软件包 |

启动后，可通过菜单打开文件或文件夹，也可以直接拖入窗口。Windows 支持“打开方式”和“以 Markumo 打开”右键菜单；系统可能将该菜单放在“显示更多选项”中。

应用内更新位于标题栏和设置中的更新入口。Linux 的应用内更新适用于 AppImage，DEB 用户需下载安装包更新。

Windows 安装包尚未使用商业代码签名证书；macOS 使用 ad-hoc 签名且未公证，首次运行可能需要在系统设置中确认。应用内更新使用独立的签名验证。

## 本地开发

### 环境准备

- Node.js LTS、pnpm 和 Rust stable 工具链。
- Windows：MSVC、Visual Studio C++ 桌面开发工具、Windows SDK 和 WebView2 Runtime。
- macOS：Xcode Command Line Tools。
- Linux：WebKitGTK 等桌面开发依赖。

系统依赖的安装步骤见 [Tauri 环境准备](https://v2.tauri.app/start/prerequisites/)。

### 获取源码

```sh
git clone https://github.com/yuanmahome/Markumo.git
cd Markumo
pnpm install --frozen-lockfile
```

### 启动开发环境

```sh
pnpm tauri dev
```

桌面开发默认开启热更新。使用 `pnpm tauri dev --no-watch` 可关闭自动重启与前端热更新。开发数据保存在 `.markumo-dev/`，也可通过 `MARKUMO_DEV_DATA_DIR` 指定目录。

仅预览浏览器界面时运行：

```sh
pnpm dev
```

访问 `http://localhost:1420`。浏览器模式可用于界面开发和内存草稿编辑，桌面文件操作需要通过 Tauri 启动。两种开发方式使用相同端口，请勿同时运行。

### 检查与构建

```sh
pnpm check
cargo check --manifest-path src-tauri/Cargo.toml
```

`pnpm check` 执行类型检查和前端构建。也可分别运行 `pnpm typecheck` 与 `pnpm build`；前端产物写入 `dist/`。

## 生成安装包

Windows：

```powershell
.\build.bat
```

macOS / Linux：

```sh
sh build.sh
```

脚本会安装锁定依赖，并为当前系统生成安装包。使用 `--check` 仅检查环境，使用 `--skip-install` 跳过依赖安装。各平台需在对应系统上构建。

默认产物位于 `src-tauri/target/release/bundle/`，按格式存放在 `nsis/`、`macos/`、`dmg/`、`deb/` 或 `appimage/` 中。自定义 Cargo 输出目录或编译目标时，以构建日志为准。

发布流程与更新签名配置见 [发布说明](docs/releasing.md)。

### 移动目录后无法构建

如果移动或重命名项目后出现 `failed to read plugin permissions`，且错误引用旧目录，通常是 Cargo 缓存中的 Tauri 权限文件仍保留旧的绝对路径。清理缓存后重新运行打包脚本：

```sh
cargo clean --manifest-path src-tauri/Cargo.toml
```

此命令会清理 Rust 构建产物，下一次编译耗时会增加。迁移源码时建议不复制 `target/` 目录。

## 项目结构

```text
src/          界面、编辑器与应用功能
src-tauri/    Rust 桌面服务、应用图标与系统集成
scripts/      开发启动、打包与发布脚本
public/       静态资源
docs/         发布说明与更新日志
```

界面使用 Vue、TypeScript 和 Vite；桌面服务使用 Rust 与 Tauri；文本与代码编辑基于 CodeMirror，Markdown 即时排版基于 ProseMirror，配合 Markdown-it、KaTeX 和 Mermaid 完成渲染。

## 开源协议

采用 [GNU Affero General Public License（AGPL-3.0-only）](LICENSE)。第三方依赖保留各自的许可证与版权声明。
