# Markdown 空行持久化修复

> 后续真实 Typora GUI 对照纠正了本文的逐物理行视觉语义。当前行为与验收见 [Typora 原生 GUI 空行对照](blank-line-typora-gui-20261027.md)。本文保留为 Phase 042 持久化问题的历史记录；原有测试覆盖保留，预期已按原生实测更新。

基线：2026-10-27 拉取并核对的 `origin/main` / `v1.0.9`，提交 `17a5dec`。只在 main 修改，不修改版本号、不推送、不发布。

## 实际根因与证据

问题包含两部分：

1. Enter 创建的空 paragraph 是真实 ProseMirror 节点，并非 CSS 间距。`MarkdownSourceBridge.prepare` 将它序列化为空字符串，却分别为该段落和后面的块补上 `\n\n`，因此一个空段落写成四个连续换行。
2. 磁盘正文保留了这些换行。重开时 `MarkdownParser.parseMarkdown` 只按 Markdown-it 的顶层 token.map 创建内容块；额外空行没有 token，只进入下一块的 prefix 或文末 tail。因此 Live 丢失段落，而 Source 正文没有丢失。FileController/DocumentManager 保存链路没有删行。

一次创建空段落的实际源码（JSON 转义显示，围栏内最后的空行始终保留）：

```text
操作前："```js\nconst a = 1;\n\n```\n\n```js\nconst a = 1;\n\n```\n"
旧版后："```js\nconst a = 1;\n\n```\n\n\n\n```js\nconst a = 1;\n\n```\n"
修复后："```js\nconst a = 1;\n\n```\n\n\n```js\nconst a = 1;\n\n```\n"
```

对应节点结构：

```text
旧版操作前：code_block → code_block → paragraph(editorTrailing=true)
旧版操作后：code_block → paragraph(empty) → code_block → paragraph(editorTrailing=true)
旧版重开后：code_block → code_block → paragraph(editorTrailing=true)
修复后操作和重开：code_block → paragraph(empty) → code_block → paragraph(editorTrailing=true)
```

两次重开过程中正文换行数保持不变；旧版丢失的是可编辑节点。专项测试 `--baseline` 通过 Vite 只读加载 v1.0.9 的源文件，生成完整 source / raw / prefix / from / to / ProseMirror JSON 对照，不修改历史工作树。Windows 原版实测还使用 Ctrl+S 和标签关闭按钮，直接检查原生保存后的磁盘字节。

WebView2 连续创建两个空段落的实际结果（同一测试文件，字节数含围栏内空行）：

| 构建 | EOL | 保存字节数 | 保存前空段落 | 第一次重开 | 第二次重开 |
| --- | --- | ---: | ---: | ---: | ---: |
| v1.0.9 | LF | 53 | 2 | 0 | 0 |
| v1.0.9 | CRLF | 66 | 2 | 0 | 0 |
| 修复版 | LF | 51 | 2 | 2 | 2 |
| 修复版 | CRLF | 62 | 2 | 2 | 2 |

旧版在块间写入 6 个换行，修复版写入 4 个（正常分隔 2 个 + 额外空行 2 个）。字节数的减少来自消除重复的结构分隔，而不是删除用户空行。

本地完整证据（测试运行生成，未纳入 Git）：

- `test-results/phase042/blank-lines/before.json`、`after.json`
- `test-results/phase042/blank-lines-webview-before.json`、`blank-lines-webview-after.json`
- WebView2 报告记录真实磁盘十六进制字节和连续两次重开的节点 JSON。

## 统一模型

`blankLines.ts` 从 tokenizer 确认的块外源码范围提取可编辑空白行，Live 和 Split 共用该规则。没有第二份正文，CodeMirror EditorState 继续作为权威状态。

| 位置/类型 | 规则 |
| --- | --- |
| 普通块之间 | 一次行终止 + 一条正常空白分隔行属于 Markdown 结构；其余每行对应一个 paragraph |
| 最小块间隔 | 原来只有一个换行且未编辑时原样保存；插入空段落时补足结构分隔，再写入用户的额外行 |
| 文档开头 | 每条空白行均可编辑 |
| 文档末尾 | 单个最终行终止不生成持久段落；其后的每条空行生成持久段落 |
| 纯空白文档 | N 个换行形成 N+1 条可编辑行，末行允许零字节范围 |
| 空格/制表符行 | 保留原始字符并作为实际段落内容；不使用 trim() 判断用户内容是否存在 |
| 围栏内部 | 不扫描；未闭合围栏直到 EOF 的换行仍归代码块所有 |
| 临时末尾入口 | editorTrailing=true 且内容为空时仍不写入正文；Enter 后由现有插件转为持久段落 |

SourceBlock 新增 `blank` 映射元数据。空白行的 raw 保存原始行（含其换行），from/to 对应真实源码，prefix 保存该行之前的结构分隔。桥接器剔除被空段落代表的行后，只重用一次原始结构分隔，并为每个空段落写回一条行。原有非空块的 sourceId、raw 和前后源码保持可复用；只发布 textPatch，不在普通输入时全文重建节点。

空行使用普通 paragraph，继续使用原生文本输入、选择和 IME 机制。Backspace 明确删除持久空段落；临时末尾段落仍保留原来的表格导航等规则。空行 DOM 点击直接定位该段落，避免 Chromium 对空行右侧命中相邻段落。Undo/Redo 继续使用单一 CodeMirror 历史；另一 Pane 接收同一组 ProseMirror transaction。

Markdown 不会写入 `<p></p>`、`<br>`、`&nbsp;`、零宽字符或自定义占位语法。Split 产生的空段落仅为渲染 DOM，并带源码行号，不参与保存。MarkdownSchema、MarkdownSerializer、TrailingParagraph、DocumentManager 和 FileController 的现有职责均保持不变。

## 修改文件

- `src/editor/markdown/blankLines.ts`：共享空行范围与围栏边界规则。
- `src/editor/markdown/wysiwyg/MarkdownParser.ts`：恢复空段落、源范围及纯空白文档末行。
- `src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts`：统一 prefix/raw/tail 与空行增删、EOL 和位置映射。
- `src/editor/markdown/wysiwyg/MarkdownEditorController.ts`：空段落 Backspace 与鼠标命中。
- `src/editor/markdown/rendering.ts`、`styles.css`：Split 按相同源码规则显示空白区域。
- `tests/phase042/blank-line-persistence.mjs`：专项浏览器与真实磁盘 gateway 回归。
- `tests/phase042/blank-line-webview.mjs`：原生 WebView2 保存、关闭、重开专项测试。
- `tests/phase042/table-image-boundaries.mjs`：两个表格导航用例使用单个最终换行，明确测试临时入口。
- `tests/run-suite.mjs`：将专项测试加入 smoke/regression。

## 验证命令与范围

2026-10-27 验证结果：

| 检查 | 结果 |
| --- | --- |
| TypeScript / Vue 类型检查 | 通过 |
| 正常生产构建 `pnpm build` | 通过 |
| smoke | 8/8 通过 |
| regression（指定最新隔离桌面构建） | 9/9 通过，含桌面 A–N 综合验收 14/14，零错误 |
| v1.0.9 原版 WebView2 | LF/CRLF 均复现：两次重开空段落丢失、磁盘源码不丢失 |
| 最终修复版 WebView2 | LF/CRLF 原生文件保存与两次重开、继续编辑、删除后重开、模式切换全部通过 |
| 200 个代码块 | 静止嵌入 CM = 0；编辑可见空行后仍为 0，光标/滚动检查通过 |

```powershell
pnpm typecheck
pnpm build
pnpm test:smoke
node tests/phase042/blank-line-persistence.mjs --baseline
node scripts/memory-release-build.mjs --label=blank-lines
# 回归需要对最新修复构建运行桌面综合验收：
$env:MARKUMO_PHASE042_RELEASE_LABEL='blank-lines'
pnpm test:regression
node tests/phase042/blank-line-webview.mjs --label=release-109 --baseline
node tests/phase042/blank-line-webview.mjs --label=blank-lines
```

专项覆盖 A–N：相邻代码块、代码块/图片与标题、表格与段落、普通段落、引用、Callout、HTML 前后；开头/末尾；连续 1/2/3/5 行及删至正常分隔；点击/键盘移动/文字与空格输入；Undo/Redo；Source 编辑及三模式循环；双 Pane；中文输入和合成 IME 事件保护；LF/CRLF、EOF、引用定义、列表/图片/HTML 原写法；未闭合围栏和围栏内部空行；200 代码块及可见位置输入后的光标/滚动稳定。

真实磁盘浏览器测试调用生产 FileController → DocumentManager.saveSnapshot → 文件 gateway，gateway 使用 Node fs 写入和读取实际文件，连续两次关闭/重开并继续编辑。原生测试使用生产 Tauri gateway、Ctrl+S、标签关闭按钮和 open_recent，检查 LF/CRLF 字节、两次重开、输入后清空、删除后再重开、模式切换。

200 个静止代码块的嵌入 CodeMirror 数保持 0，代码块懒加载实现未修改。

## 已知边界

- 本次只把顶层块之间的额外空白映射为独立段落；引用/列表/HTML 等块内部的空白仍遵守原有 Markdown 语义并保留源码。
- 中文输入通过中文文字输入和合成 composition 事件验证；尚未人工操作 Windows 中文输入法候选窗，不将合成事件等同于系统 IME 完整实测。
- 大文档检查为 200 代码块加标题/空行的场景，未据此承诺任意大小文档的性能。
- 无须版本迁移；旧文件已有的额外换行现在会如实显示。如果旧版给一次操作写了多行，修复不会擅自猜测并删除已有换行。
