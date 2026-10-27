# Typora 原生 GUI 空行对照与修复（2026-10-27）

本次实际操作 Windows 上的 Typora 1.12.4 和 Markumo 原生窗口。先取得 Typora 输入、保存字节和光标证据，再在原 Markumo 窗口复现；源码修改后重新构建并启动独立 Release 程序回归。浏览器 fixture 用于固定实测规则，不作为 Typora 的替身。

## 样本与环境

未找到名为 `测试(1).md` 的附件。使用桌面 `测试.md`：第 24 行为第一代码块闭合围栏，第 25～29 行是五条物理空白行，第 30 行以 ` ```java ` 开始。只操作独立副本，没有清理原文件。

原始副本为 528 字节、UTF-8 无 BOM、62 个 LF、0 个 CRLF。`original.md`、`typora-test.md`、`markumo-test.md` 起始字节相同，SHA-256：

```text
208d130a7991a8e59c6a701514518ffa60fe0e8a8bd71b0b70c841e272f99924
```

完整本地证据位于 `test-results/blank-line-gui-20261027/`，包含原始副本、每步保存文件、`gui-log.json`、真实窗口 PNG、原生 WebView DOM/ProseMirror/SourceBridge JSON、像素测量结果。该目录按仓库惯例不纳入 Git。实际 Typora 保存的五份微型样本已纳入 `tests/phase042/fixtures/typora-enter-1.md` 至 `typora-enter-5.md`，并固定 LF 字节。

| 项目 | Typora | Markumo 验收构建 |
| --- | --- | --- |
| 窗口截图尺寸 | 1398 × 1062 | 1202 × 782 |
| 文本内容宽度 | 800 px | 800 px（画布 896，左右 padding 各 48） |
| 缩放 | zoomFactor=1 | 原生 WebView 默认缩放 |
| 主题 | github.css | 浅色 |
| 正文 | Open Sans/系统中文回退，16 px，1.6 行距 | 系统字体/微软雅黑回退，16 px，1.6 行距 |
| 代码字号 | 未读取 Typora computed style | 13 px，21.45 px 行高 |
| 代码块间距 | 参考主题上下各 15 px | 修复前各 19.2 px；最终各 15 px |

没有修改 Typora 全局配置。字体差异会影响代码块自身高度，所以始终测量前块底边到后块顶边，不比较整个窗口或整个代码块高度。

## 实际 Typora 操作

1. Ctrl+O 打开独立副本。在窗口坐标 `(488,651)` 点击第一空段落，光标约在 y=652；Down 一次到 y=690；再 Down 一次进入第二代码块。源码的五条物理空白行只对应两个可编辑空段落。代码块边界 y=625、719，间距约 94 px。
2. Up 返回最后一个空段落，Enter 一次，Ctrl+S。连续 LF 从 6 变成 8，文件从 528 变成 530 字节，间距增加约 38 px。
3. Backspace 一次恢复两个段落，Undo/Redo 可以分别恢复和删除该段落。第一空段落处 Delete 一次后，Ctrl+S，连续 LF 为 4，文件 526 字节，间距约 56 px。
4. 独立微型样本包含两段相同的 Java 代码。点击第一块末尾 `(596,120)`，普通 Enter 增加的是代码内部行；Undo 还原。Ctrl+Enter 在块外创建第一个空段落，再逐次 Enter、Ctrl+S，保存 1～5 段的独立字节快照。
5. 1～5 段保存结果分别有 4、6、8、10、12 个连续 LF。五段文件关闭原编辑窗口后另开，间距仍约 209 px。Typora 实际打开 Markumo 输出的五段文件也显示相同间距。
6. 第二代码块第一行开头 `(513,370)` 按 Backspace，会将该代码块转成普通段落；已保存转换结果，再 Undo、保存还原样本。这与块外删除空段落属于不同操作。

Typora 的物理空白行矩阵也真实打开过：1、2、3、4、5、6 条物理空白行分别显示 0、0、1、1、2、2 个空段落。没有依据单个案例直接推定换算。

## 实际 Markumo 操作与对照

首先复用用户原有 `target/debug/markumo.exe` 窗口，通过原生打开对话框载入同字节副本。修复前点击第一空段落约 `(342,389)`，状态栏为 Ln 26；块间有四个空段落。Enter、Ctrl+S 后只有 7 个连续 LF，文件 529 字节，与 Typora 的 8 个 LF / 530 字节不同。

源码修复后启动新构建，重新执行点击、Enter、Backspace、Delete、Ctrl+S、Undo、Redo。最终构建窗口在 `(204,425)` 定位第二空段落后 Enter，保存结果与 Typora 的 `typora-original-after-enter.md` **逐字节相同**；删除后的文件也与 Typora 的 526 字节输出逐字节相同。Undo 恢复原始文件后保存，再次得到原始 SHA-256。

微型样本在真实 Markumo 中点击第一代码块末尾 `(316,203)`，Ctrl+Enter 后逐次 Enter、Ctrl+S。五份输出全部与 Typora 对应保存结果逐字节相同。两个软件还实际交叉打开了对方的五段文件。

下表的“LF”是两围栏之间连续换行符数量，“段”是可编辑空段落数。代码块距离使用原生 DOM 实测；Typora 使用真实 PNG 边界，栅格测量误差约 ±1 px。

| 场景 | Typora：段 / LF / 高度 | Markumo 最终：段 / LF / 高度 | 差异 |
| --- | --- | --- | --- |
| 原始五物理空白行 | 2 / 6 / 94 px | 2 / 6 / 93.984 px | <1 px；修复前为 4 段、140.75 px |
| 正常相邻，无额外段落 | 0 / 2 / 15 px | 0 / 2 / 15 px | 一致 |
| 插入第 1 段 | 1 / 4 / 56 px | 1 / 4 / 55.594 px | <1 px |
| 插入第 2 段 | 2 / 6 / 94 px | 2 / 6 / 93.984 px | <1 px |
| 插入第 3 段 | 3 / 8 / 133 px | 3 / 8 / 132.375 px | <1 px |
| 插入第 4 段 | 4 / 10 / 171 px | 4 / 10 / 170.766 px | <1 px |
| 插入第 5 段 | 5 / 12 / 209 px | 5 / 12 / 209.156 px | <1 px |
| 原始案例删除 1 段 | 1 / 4 / 56 px | 1 / 4 / 55.594 px | 保存字节一致 |
| 保存并重开原始案例 | 2 / 6 / 94 px | 2 / 6 / 93.984 px | Markumo 原生连续重开两次不变 |
| 代码块 → 标题，五物理空白行 | 2 / 6 / 可见空白约 100 px | 2 / 6 / 可见空白约 99 px | 前块底边到标题文字首个像素，约 1 px |
| 普通段落之间，五物理空白行 | 2 / 6 / 可见空白 100 px | 2 / 6 / 可见空白 100 px | 上段文字底部之后到下段文字顶部之前的白色像素行数 |

普通段落和代码到标题的像素行分析见 `pixel-measurements.json`。Markumo 的五段 DOM 高度由实际渲染测量固定在测试中，不是根据窗口截图总高度推算。一次增量是 25.594 px 行框 + 12.797 px 折叠段落间距，约 38.39 px。

混合块文件还实际查看了标题→段落、图片→段落、表格→段落、列表→段落、引用→段落、HTML→段落，以及文首和文末。块间五物理空白行均有两个空段落，原生 accessibility、光标和 Markumo DOM 用于辅助核对。表格和 HTML 不按代码框高度衡量；截图保留各自锚点。原始空白行含空格、Tab 的字节保持由额外自动化覆盖，未宣称其视觉规则与纯空行完全相同。

## 根因与实现

这是解析/编辑映射、序列化和 CSS 的共同问题。

- 旧 `blankLineRanges()` 在正常分隔之外，每条物理空行创建一个 paragraph，所以五条物理空白行建成四个节点；与 Typora 原生实测的两个节点不同。
- 旧 SourceBridge 给新增空段落写一个 LF，导致两软件同一次 Enter 的保存结果不同。最终按真实段落跨度保存：块终止和正常分隔之外，一个空段落拥有两条空源码行。保留每段原始 `from/to/raw`，未配对的换行保留在原始 prefix/tail 中。扫描完整源码跨度，不对显示节点进行隐藏、折叠或计数除法。
- 原始空格、Tab 行作为独立内容保留。`gapLayout()` 将结构字节保留在幸存跨度前后原来的位置，避免把奇数换行挪到空格行前面。2912 组 LF/CRLF、文首/文末及无关中文编辑组合均保持原字节。
- 空 paragraph 原来强制 `margin:0`，而 Typora Enter 的真实增量包含普通段落间距。Live、Split 恢复 `.8em` 段落 margin 和正常行高；代码块 15 px 间距使用共享 CSS 变量。没有负 margin、不可见字符或测试文件专属高度。
- Delete 删除顶层空段落时显式使用独立历史事务，避免一次 Undo 同时撤销此前插入操作；保护 read-only 和临时末尾入口。
- Source 模式仍使用唯一权威源码。围栏内部、未闭合围栏、HTML/列表内部由原 tokenizer 决定边界，不用块间规则扫描这些内容。

关键文件：`blankLines.ts`、`MarkdownSourceBridge.ts`、`MarkdownEditorController.ts`、`presentation.css`、`MarkdownTheme.css`、`styles.css`、`splitPreview.vue`。`MarkdownParser.ts` 继续使用共享跨度接口，只更新了过时注释；`TrailingParagraph.ts` 不需要修改。

## 验证结果

- `pnpm typecheck`：通过。
- `blank-line-persistence.mjs`：通过；保留 Phase 042 的所有覆盖，新增原生 Typora 五份字节 fixture、1～6 物理空白行、1～5 次输入、Delete/Undo、真实 DOM 边界距离、2912 组空白跨度/无关中文编辑。
- `blank-line-visual-layout.mjs`：通过；旧的四段/零 margin 假设已改为真实 Typora 两段/普通段落 margin，同时保留 Live/Split 高度、输入、删除、历史、真实磁盘及两次重开测试。
- `code-block-browser.mjs`、`code-block-layout.mjs`：最终间距变化后再次通过，包含 12 组几何配置及 23 项交互、复制、历史与滚动检查。
- 回归套件的其余脚本通过：链接、表格/图片边界、大纲、搜索、拖拽、工作区、渲染任务、Pane/标签生命周期及 Windows 完整性。套件最初在旧视觉断言处停止；修正该实测预期后分段完成，没有把一次失败运行说成整次通过。
- `blank-line-webview.mjs --label=blank-gui-verified`：最终重新构建的 Windows WebView2，LF/CRLF 原生 Ctrl+S、磁盘字节、两次关闭重开、文字输入清空、删除、模式切换均通过。
- `acceptance-a-to-n.mjs --label=blank-gui-verified`：最终原生构建 A–N 共 14 项全部通过，0 errors；包含 200 代码块、连续编辑、模式切换、两 Pane、图片、PDF、后台恢复和资源回收。
- 原生 GUI：实际鼠标、键盘、原生文件打开/保存、重开、交叉打开、Live/Source/Split，以及修复前/参考/修复后截图均已完成。原生 IME 候选窗操作没有验证；合成 composition 测试与直接中文输入不等同于系统 IME 实测。

一次与构建同时运行的浏览器专项，在方向键回到空段落的断言上失败；独立重跑通过。没有改写该断言来掩盖结果。

## 真实截图索引

以下为本地 PNG 原始截图，不是浏览器模拟 Typora，也未拼贴或重新绘制：

- Typora 参考：`typora-original-0.png`、`typora-original-row1-0.png`、`typora-original-row2-0.png`。
- Markumo 修复前：`markumo-before-original-0.png`、`markumo-before-matrix-top-0.png`。
- Markumo 最终：`markumo-verified-original-0.png`、`markumo-verified-enter-0.png`、`markumo-verified-delete-0.png`。
- Source 五条真实物理空白行与 Split 预览同屏：`markumo-verified-split-0.png`。
- 混合块参考：`typora-mixed-top-0.png`、`typora-mixed-middle-0.png`、`typora-mixed-bottom-stable-0.png`。
- 混合块修复后：`markumo-verified-mixed-top-final-0.png`、`markumo-after-mixed-middle-0.png`、`markumo-after-mixed-table-list-0.png`、`markumo-after-mixed-bottom-0.png`。其中 `after` 为语义修复后、最终代码 margin 微调前的构建；最终顶层截图和 DOM 另以 `verified` 标注，未混淆两版。
- 交叉打开：`typora-cross-open-markumo5-0.png`、`markumo-cross-open-typora5-0.png`。

所有文件均在上述 `test-results/blank-line-gui-20261027/` 下。

## 边界与未验证项

- Typora 与 Markumo 的代码字体和整块高度没有完全相同；本次对齐块外间距，未改写代码字体系统。
- 空格/Tab 行保持其原始字节和可编辑内容；其所有视觉/光标组合与 Typora 的逐项对照尚未验证。
- Typora 的每种混合块都观察了实际布局，但未对每个类型重复完整的 Enter/Delete/Undo/Redo GUI 笛卡尔组合；自动化覆盖相应生产编辑路径，不将其冒称手工 GUI 全覆盖。
- 方向键在两空段落之后进入代码编辑器的细节仍存在差异：本次原 Markumo GUI 中 Down 可以跳过未激活代码视图，Typora 会进入代码首行。两个块外空段落本身均可点击和经过。本次不扩大为代码编辑器导航重构。
- 没有调整版本号、推送远程或发布 Release。变更只在 `main` 提交；构建使用工作区内独立测试 profile，未覆盖用户会话。
