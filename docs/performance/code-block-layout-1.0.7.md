# 代码块展示态 / 编辑态布局一致性验收

日期：2026-10-26。开始时本地 HEAD 与 `git ls-remote origin HEAD refs/heads/main` 均为 `e72cf73c4cf3a5af7d9dda88bc19da694f814f37`（v1.0.7）。全程在 main 修改，没有改版本、推送或发布。

## 根因与实现

1. 静态 gutter 用 `7.2px × 位数` 估算数字宽度；CM 用实际字体、行号 spacer 和自身 padding 测量。字号固定 12px 的行号也与 13px 的代码及缩放缺乏统一约束。
2. 静态 pre 与 CM content/line 分配水平 padding 的方式不同，长行的 scrollWidth 原来相差 44px，换行测量也会受影响。
3. 纯文本尾随换行在静态 pre 中没有最后一行的可见内容盒，CM 则保留这一逻辑空行。挂载 CM 后首次高度测量也可能到下一帧才完成。
4. 静态内容被替换时，点击目标已移除；需要同时保持布局稳定，并且只将代码正文计入源码偏移。

修改文件：

- `src/editor/markdown/wysiwyg/MarkdownTheme.css`：集中定义字体、字号、字重、行高、字距、tab-size、gutter 最小宽度/内边距、正文左右/上下内边距。行号字体与代码相同，右对齐、同色；gutter 使用实际字体的 `ch` 单位，最小两位数字宽度。边框始终属于同一个 `.md-code-surface`。两态使用相同水平滚动和 `break-spaces` 换行约定。代码块外边距继续跟随 Markdown 正文字号，避免统一代码字体连带改变段落间距。
- `src/editor/markdown/wysiwyg/CodeBlockView.ts`：数字位数在块本身统一维护，文档内容及设置改变时更新。静态平铺表示仍只有少数 DOM 元素；高亮/换行表示使用逻辑行。首次挂载只临时保留旧 pre 的实际高度，通过 CM 公共 `coordsAtPos()` 完成测量后立即释放，不保留固定高度。静态光标映射排除行号；保留原来的拖选、IME、选区、历史和滚动位置处理。
- `src/editor/markdown/staticCode.ts`：Live 静态逻辑行显式分离数字与正文；Split 预览使用的非 compact 输出不变。

CM 的 lineNumbers、spacer、按视口绘制与测量仍由 CM 管理，没有替换其行号插件或高度模型。异步高亮队列、取消、离屏高亮释放、按需创建/销毁的生命周期保持工作。

## 测量方法与覆盖

独立脚本：`tests/phase042/code-block-layout.mjs`，已接入 smoke/regression。

Chromium 与 Windows WebView2 **隔离 Release** 各运行 70 组配置，每组完整执行展示 → 编辑 → 展示 20 次。记录点击后的第一次同步样本、完成两次 requestAnimationFrame 的样本以及退出后的样本。

- 行数：1、9、10、21、99、100、999、1000，分别开关行号和自动换行。
- 字号：11、13、16、19px；内容宽度：560、600、860、1100px；默认等宽字体与 Courier New；浅色/深色。
- 80%、100%、125%、150%：通过 CSS zoom 和 CDP deviceScaleFactor 模拟，记录坐标按 zoom 还原到布局 CSS px。覆盖组合是基础矩阵加代表性组合，并非所有参数的笛卡尔积。
- 空块、尾随空行、Tab、长行、视觉换行、Live 同一文档的左右两个 Pane。
- 额外覆盖 10001 行的五位行号和正常视口下的语法高亮代码。

每次采样保留逻辑行编号，测量行号文字与正文首字符的 Range.getBoundingClientRect、所属 DOM 盒 getBoundingClientRect、gutter、块高度/宽度、代码区宽度、下方标题 Y、scrollWidth/clientWidth、滚动条厚度、scrollTop/scrollLeft。Range 的字形顶部用于可测量的垂直对齐；空行以数字位置和整体高度验证。静态 flat 表示的所属盒是整列，逻辑行位置取独立 Range，不伪造每行 DOM。<=1000 行的基础矩阵使用加高逻辑视口，使全部行都存在真实 DOM，再断言每个逻辑行均被测量；10001 行用正常视口，只比较 CM 实际挂载的逻辑行，并比较整个块的高度。

CM 自动换行后的多个视觉行仍属于同一个 `.cm-line`，使用 `posAtDOM()` 和 `doc.lineAt()` 找回逻辑行，不把视觉行当作源码行。CM 隐藏的行号 spacer 不参与数字坐标比较。

第一轮保存完整行数据，其余 19 轮保存全部差值和块/滚动矩形，控制报告体积。旧版数字是 CSS 伪元素，无法直接创建 DOM Range：旧 gutter 宽度取其已解析的 computedStyle；旧伪元素框标为 inferred，不冒充字形实测。

## 实测结果

以下为 13px、100% 缩放；单位 CSS px。静态 / CM 的实际布局参数不依赖下表数值。

| 逻辑行数 | 旧 gutter：静态 / CM | 新 gutter：静态 / CM | 旧正文起点最大差 | 新数字 / 正文 X 差 |
| --- | --- | --- | --- | --- |
| 1、9 | 24 / 24 | 30.28125 / 30.28125 | 0 | 0 / 0 |
| 10、21、99 | 26.3906 / 25.203125 | 30.28125 / 30.28125 | 1.1875 | 0 / 0 |
| 100、999 | 33.5938 / 31.796875 | 37.4375 / 37.4375 | 1.796875 | 0 / 0 |
| 1000 | 40.7969 / 38.390625 | 44.578125 / 44.578125 | 2.40625 | 0 / 0 |
| 10001 | 未测旧版 | 51.734375 / 51.734375 | — | 0 / 0 |

旧数字同为 12px，右 padding 同为 3px，因此 gutter 的横向差也会传递到数字右对齐位置；修复后数字直接以真实 DOM Range 测量。关闭行号时两态 gutter 都是 0。

| 内容 | 旧：展示 / 刚挂载 / 稳定编辑高度 | 新：展示 / 刚挂载 / 稳定编辑高度 |
| --- | --- | --- |
| 空代码块 | 39.4375 / 39.4375 / 39.4375 | 39.4375 / 39.4375 / 39.4375 |
| 21 个短逻辑行 | 468.1875 / 468.1875 / 468.1875 | 468.1875 / 468.1875 / 468.1875 |
| `alpha` 后有一个尾随空行，不换行 | 39.4375 / 60.875 / 60.875 | 60.875 / 60.875 / 60.875 |
| 444 字符长行样本，开启换行 | 146.625 / 226.875 / 146.625 | 146.625 / 146.625 / 146.625 |
| 1000 个短逻辑行 | 21455.5 / 21455.5 / 21455.5 | 21455.5 / 21455.5 / 21455.5 |

两引擎矩阵的实测最大差值：

| 指标 | 差值 |
| --- | --- |
| 数字 X、正文首字符 X、正文首字符 Y、gutter 宽度 | 0 |
| 数字字形 Y | 0.3625 布局 CSS px（125% 下约 0.453125 个 getBoundingClientRect 坐标单位） |
| 代码块高度、下方标题 Y | 0.2125 布局 CSS px（125% 下约 0.265625） |
| 块宽度、代码区宽度、页面及水平滚动位置 | 0 |

这些非零值是缩放下 gutter 与行高测量的子像素取整，均低于 1px 阈值。截图已对照检查；没有发现数字或正文在两态间移动。截图不能替代真实显示器上的连续视觉验收。

## 首击、选择与资源验证

独立交互检查共 23 项：普通/高亮静态内容的行首、行尾、Tab 后及正文中间的首击；第一次双击选中 `beta`；第一次拖动选择并复制 `alpha beta`，不带行号；从上次选区恢复的冷态 Shift 点击；80%、125%、150% 下长行换行后的首次点击；9 ↔ 10、99 ↔ 100、999 ↔ 1000 编辑中的 gutter 增长/收缩。

使用 CDP Input.imeSetComposition/Input.insertText 提交中文并验证真实文档 Undo/Redo；另用合成 composition 生命周期覆盖“失焦但组合尚未结束”的销毁保护。首击后外层 ProseMirror 选区与内层 CM 源码偏移一致。独立检查水平 scrollLeft=180、页面 scrollTop=120 的进入/退出保持。

Release A–N 验收中：

- 200 个代码块静止以及 500 次工具栏查询：CM created/live/peak 全为 0。
- 连续滚动 200 块两遍：CM peak/live=0；高亮运行 399 次，取消 1 次；回收后连接 DOM 7062 个，低于现有 9000 阈值。
- 同一块连续编辑 100 次：只创建 1 个 CM，peak=1；撤销恢复原文。
- 首次跨行拖选选择 49 个字符；随后多块进入/退出，最终 CM live=0、peak=1。
- 同一文档两 Pane 静止 CM=0；一个 Pane 编辑时总 CM=1。
- 最终关闭后 PM、主 CM、嵌入 CM、worker、Blob、文档记录、媒体资源计数全部归零。

## 命令、产物与边界

已运行并通过 `pnpm typecheck`、`pnpm build`、`pnpm test:smoke`。使用本次新 Release 运行 `pnpm test:regression`，A–N 14 项通过。构建仍输出既有的动态/静态导入混用和大 chunk 提示，没有类型或构建错误。

复现完整验证（PowerShell）：

```powershell
node tests/phase042/code-block-layout.mjs --baseline
node tests/phase042/code-block-layout.mjs --full
node scripts/memory-release-build.mjs --label=layout-after
node tests/phase042/code-block-layout.mjs --full --native=layout-after
node tests/phase042/code-block-layout.mjs --interactions-only
node tests/phase042/code-block-layout.mjs --interactions-only --native=layout-after
$env:MARKUMO_PHASE042_RELEASE_LABEL = 'layout-after'
pnpm test:regression
```

`MARKUMO_PHASE042_RELEASE_LABEL` 让 A–N 明确使用新构建，不把旧 `markumo-after.exe` 的结果当作本次结果。测试会验证路径后，仅重置 test-results/phase042 内的隔离配置目录。测试数据的初始填充不进入撤销历史，避免它与第一笔 IME 输入合并。

本次隔离 Release：`test-results/phase042/markumo-layout-after.exe`；SHA-256：`575c481e3d362b5dd38c35a9ef530f5c8ca1736e4671b6d266bff7b42bfd03b4`。原始几何报告位于 `test-results/phase042/code-layout/` 的 `chromium-before.json`、`chromium-full.json`、`layout-after-full.json` 及两个 `*-interactions.json`。该目录也包含两态与退出后的 PNG 对照图；均为本地测试产物，不随代码提交。

尚未覆盖：真实多显示器跨 DPI 拖动、系统显示缩放切换、所有已安装字体及全部参数笛卡尔积；操作系统中文候选窗/第三方输入法的完整人工操作；人工在真实屏幕上连续观察 20 次切换。已测 WebView2 是真实 Windows Release 内核，缩放部分仍是 CDP/CSS 模拟。没有将这些人工场景记作通过。
