# Markdown 智能复制规则与验收

2026-10-28，按最终规则修正。此记录覆盖此前“部分标题不应带 Markdown 标记”的要求。

## 行为

- 单个文本块内的文字选区：普通复制为纯文字，软换行或自动折行不改变这一规则。
- 跨块选区：默认开启「跨段自动复制 Markdown」。标题有实际文字被选中时保留原级别，仅输出选中部分；终点在下一块 offset 0 时保留跨块判定，但不输出下一块的空标题、段落或容器。
- 起点恰好在前一文本块末尾时，同样排除没有选中文字的前一块。保留列表、引用等祖先结构；从有序列表中途开始时使用实际首个选中项的编号。
- 关闭开关后普通复制输出可读纯文字；Ctrl+Shift+C 显式复制 Markdown。表格的单元格、跨单元格及矩形选择规则保持独立。
- Ctrl+C、Ctrl+X、应用编辑菜单和右键菜单共用 `LiveClipboard.content()`。普通复制及剪切的 HTML 保留对应所选文字的格式。

## 配置迁移

新配置为 `markdownClipboard.copyAcrossBlocks`，默认 `true`，设置版本升至 7；保留 `copyWholeLine`。

旧 `copyMarkdown` 控制“连单块也始终输出 Markdown”，其 `true`、`false` 两种值原本都会自动复制跨块 Markdown。因此迁移时均保留跨段自动复制开启，不再恢复旧单块覆盖行为；已有整行复制偏好原样保留。新键显式存储的 `false` 会保留。Rust 设置反序列化接受旧字段，下一次写入仅保存新字段，避免原生启动或保存因未知字段失败。

## 验证

新增 `tests/phase042/smart-clipboard.mjs`，已加入 smoke/regression 套件。所有主要验收选区均由浏览器鼠标 down/move/up 建立，没有构造 ProseMirror Selection 代替拖选。

- 120 组标题精确断言：单标题、下一标题 offset 0/1/2/3、完整两个标题 × 开关开/关 × 正反拖选 × Ctrl+C、Ctrl+Shift+C、右键复制、菜单调用入口、Ctrl+X。
- 不同标题级别、首标题部分文字、列表/引用祖先、边界空容器、有序列表截选编号。
- 精确断言 text/plain、标题字符及级别、空行、无补齐文字和无多余末尾换行；普通复制的 HTML 标题和文本逐项断言。
- 链接目标及加粗 HTML、单单元格与矩形表格复制、代码块多行实际拖选复制、整行复制、Ctrl+A 的编辑器临时尾段排除、前端配置迁移。

另使用独立 Windows WebView2 测试程序，以 `computer-use` 的系统鼠标拖动建立实际选区，再读取原生系统剪贴板精确断言。验证单标题、跨标题 offset 0/1/2/3、完整双标题、反向选择、正向部分选择、开关开/关、Ctrl+C、Ctrl+Shift+C、真实应用编辑菜单与真实右键复制。通过实际设置界面关闭新选项，确认设置版本 7 与关闭值成功写入磁盘。快捷键测试在重新拖选、编辑区获得焦点后执行。另按 Windows CF_HTML 字节偏移读取实际 UTF-8 片段，确认右键复制的 HTML 恰为所选 h1 与部分 h2。

自动化及原生记录保存在本地忽略目录 `test-results/smart-clipboard/`（`browser.json`、`native.json`、`native-clipboard-fragment.html`）。原生构建使用独立配置和测试 Markdown，不修改日常用户文档。

已通过：

```sh
pnpm typecheck
pnpm build
node tests/phase042/smart-clipboard.mjs
node tests/markdown-links/regression.mjs
node tests/phase042/table-image-boundaries.mjs
node tests/phase042/code-block-layout.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml clipboard_tests --lib
node scripts/memory-release-build.mjs --label=clipboard-smart
```

链接回归 28 项、代码块布局 12 组及交互 23 项通过；原生配置迁移单元测试 2 项通过。表格与代码布局脚本共用端口，应依次运行。
