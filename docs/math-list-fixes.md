# 列表与数学公式修复记录

基线：远程最新 main，74aeb49（v1.2.3）。所有修改在 main 完成；修复验证完成后，用户授权按补丁版本发布 v1.2.4。

## 已复现的根因

真实浏览器键盘操作：创建列表、输入中文、选择并加粗、Ctrl+2、Ctrl+Z、Enter、Tab。
旧实现写出的源码如下：

```markdown
- **中文文字**
  - 
```

第二行不是可中断段落的非空子列表项，Markdown-it 将其解释为 Setext H2 下划线。
此时 PM 仍是 paragraph + 空子列表，重新解析却只有 heading；切换模式将错误的源码语义带回正文。
撤销本身已移除 `##`，但后续 Tab 又生成等价的 Setext 标题语法，所以大纲再次出现 H2。
这条复现路径无需 sourceId 复用或残留 level 属性即可触发。

修复：空子列表要求父列表为 loose，在正文和子列表之间保留合法空行；规范化和结构操作同属一次事务。
列表保存增加重新解析校验。含表格列表继续使用已有的表格保真校验，避免将表格编辑产生的临时空段落误判为非法结构。
标题命令只携带 sourceId 和目标属性，并隔离历史步骤。允许用户明确创建列表内标题；Ctrl+0 恢复段落。

## 公式识别与源码

`$...$`、`$$...$$`、`\(...\)`、`\[...\]` 共用 mathSemantics。
实时排版、双栏、源码数学高亮、HTML、原生 DOCX 和大纲使用该识别规则。
PDF/PNG 复用 HTML 导出管线。代码围栏、行内代码、未成对标记和明确转义的美元符号保持文字语义。
块公式扫描不能跨出列表容器，也不能在后续代码围栏中寻找闭合分隔符。

行内公式保存 opening/closing 属性；修改 LaTeX 时优先只替换内容范围。
块公式保留原分隔符；未修改内容不重写。文件保存接口验证 CRLF 保留。

实际转义位置：patchSourceBlock 的直接候选不能保持 PM 文字语义时，minimalLiteral/fullLiteral 会转义语法字符。
逐字符输入 `\(` 时尚未组成数学节点，旧解析器将其解释为文字转义，源码回退为 `\\(`，后续不能完成公式。
新增输入规则在完整公式输入时通过语义校验的局部源码补丁创建数学节点。没有全局移除反斜杠，也没有删除文字保真回退。
基线 `$a+b$` 的普通输入路径已正常，未复现所有美元分隔符都会变成 `\$` 的现象；测试覆盖输入、粘贴、邻接编辑和模式切换。

## 编辑与删除

独立段落只有 `$$` 或 `\[` 且光标在末尾时，Enter 链首先执行 enterMathBlock；补全成对分隔符和空公式体，随后聚焦其 textarea。
列表项允许 block+，因此直接替换当前段落并保留列表父节点。组合输入期间不触发。
创建单独进入撤销历史；空公式可编辑，无须再输入闭合标记。

沿用原有 NodeView 更新、组合输入合并与选区映射；渲染异步执行并防抖 80ms。
在空块公式 textarea 按 Backspace 删除整个公式；清空行内公式会直接删除其原子，避免生成有歧义的 `$$`。普通字符删除及 Ctrl+A/Z/Y 留在公式编辑流程。
正文两侧 Backspace/Delete、节点选中 Delete 和右键“删除公式”均通过 PM Transaction 删除。
contextmenu 事件允许到达编辑器菜单，其他内部编辑事件继续隔离。

已通过本机 Typora 的真实 UI 对照确认：`$$` 回车后展示上下分隔符、源码输入、下方预览和右上角确认入口。
Markumo 对应实现包含公式体语法着色、`< Empty Math Block >` 占位、确认收起和点击重新编辑；行内公式展开源码时显示黑色浮动预览。
正文中的单行 `\[...\]` 也按成对数学标记识别；独立段落中的该语法仍是块公式。
逐行从 `\[` 开始输入会立即进入公式体，手动再输入单独的闭合行也会正常结束编辑。
完整单行键入 `\[...\]` 使用结构事务转换，避免用文字源码偏移替换整个公式块时留下部分转义。
这些补充覆盖了原先只有成对粘贴测试而遗漏的逐行/单行键入路径；不自动删除现有文档中作者明确写出的转义。

## 修改文件

- src/editor/languages/index.ts：注册源码公式高亮。
- src/editor/markdown/mathHighlight.ts：基于统一数学 token 的高亮。
- src/editor/markdown/mathSemantics.ts：四种分隔符和解析边界。
- src/editor/markdown/wysiwyg/MarkdownEditorController.ts：输入、创建、渲染防抖、删除及菜单。
- src/editor/markdown/wysiwyg/MarkdownParser.ts：公式节点映射及原始源码。
- src/editor/markdown/wysiwyg/MarkdownSchema.ts：行内公式分隔符属性。
- src/editor/markdown/wysiwyg/MarkdownTheme.css：Typora 形式的块公式编辑与行内预览。
- src/editor/markdown/wysiwyg/MarkdownSerializer.ts：保留分隔符和容器内多行公式。
- src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts：列表解析校验。
- src/editor/markdown/wysiwyg/listNormalization.ts：空子列表边界。
- src/editor/markdown/wysiwyg/patchSourceBlock.ts：公式内容局部替换。
- src/editor/markdown/wysiwyg/setSourceBlockType.ts：目标属性和历史隔离。
- src/editor/markdown/wysiwyg/strongInputRule.ts：反斜杠公式完成检测。
- src/editor/outline/outlineService.ts：数学上下文不产生大纲标题。
- src/features/document-conversion/ExportRenderer.ts：公式错误包含具体解析信息。
- tests/markdown-links/fixture.ts：公式节点选择测试入口。
- tests/markdown-links/math-lists.mjs：21 组浏览器回归。
- tests/run-suite.mjs：将新增测试加入现有套件。
- docs/math-list-fixes.md：本记录。

## 验证与边界

新增测试使用 Playwright 键盘和鼠标；剪贴板与 IME 使用浏览器事件模拟。
检查 PM 类型、真实 DOM、SourceBridge、canonical source、Markdown-it 重新解析、大纲、保存接口与磁盘重开。
导出验证四个公式的 HTML KaTeX、DOCX 四张公式图及无警告，并生成浏览器 PDF/PNG。
产物位于 test-results/math-lists/，完整回归日志位于 test-results/math-regression.log。

类型检查、构建、21 组公式/列表测试和 export-quality 回归通过。本次完整回归套件 31/31 通过，日志为 test-results/math-regression-followup.log；其中 lossless 差分测试 73/73，无浏览器异常。
尚未手工操作 Windows 原生中文输入法、跨应用剪贴板、Word 打开及桌面打印对话框；这些不由模拟事件和浏览器导出结果替代。
