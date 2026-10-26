# Typora 表格与图片边界行为核对

2026-10-26，在本机 Windows Typora 1.12.4 的独立测试文档中通过实际鼠标、键盘操作核对，之后再修改 Markumo。原有用户文档未编辑。

## Typora 实测

| 操作 | 观察结果 |
| --- | --- |
| 点击图片 Markdown 语法右侧的同行空白 | 光标定位到图片语法末尾 |
| 在该位置按 Enter，再输入文字 | 文字进入图片下方的新段落；源码模式确认图片语法与新文字之间有空行 |
| 表格后空段落按 Backspace | 进入最后一行、最后一列 |
| 空单元格继续 Backspace | 移到左侧单元格；本行第一列再退格则进入上一行最后一列 |
| 左上角为空，其他格含 `11`，按 Backspace | 表格保留，内容保留 |
| 在含 `11` 的格子中退格两次 | 正常逐字删除，得到全空表格 |
| 全空表格在左上角按 Backspace | 删除整个表格，光标回到前一个段落末尾 |

以上是本次核对的具体边界，不代表所有 Typora 功能的兼容承诺。

## Markumo 实现与回归

- `tableBackspace.ts` 先处理表格边界，避免落入 ProseMirror 默认的表格选择/删除逻辑。以实际节点内容判断空格，图片、公式、换行、空白字符都不当作无内容。
- `MarkdownEditorController.ts` 处理图片语法行尾空白点击，同步局部源码光标；将源码末尾映射到图片节点之后。
- `InlineSourceView.ts` 在图片源码末尾按 Enter 时执行正文换段落，在源码内部仍保留原有编辑方式。
- `tests/phase042/table-image-boundaries.mjs` 使用真实 Chromium 鼠标与键盘，检查表格逆序导航、内容保护、文字/选区删除、空表格删除与撤销重做、单格/引用/列表容器、只读、多 Pane、图片行尾首击、Enter 新段落与撤销重做、损坏/空路径/已加载/HTML 图片、文档末尾。
- 该专项已加入 `pnpm test:smoke` 和 `pnpm test:regression` 共用列表。

组合期间的防误操作以浏览器合成 composition/keydown 事件验证。本次修改尚未在 Markumo Windows WebView2 Release 中手测，也未验证原生中文输入法候选窗。
