# 表格跨模式与导出保存目录修复验收

基线：2026-11-06 拉取的 `origin/main`，`e6ee0fc1059b2068a0c77c365fe0820b4864e1c7`。修复阶段在 main 修改，无新分支、worktree、版本号变更、提交、推送或 Release。用户随后授权发布版本，按补丁版本准备 v1.2.3。

## 修改文件

- `src/editor/markdown/wysiwyg/MarkdownSerializer.ts`
- `src/editor/markdown/wysiwyg/MarkdownSourceBridge.ts`
- `src/editor/markdown/wysiwyg/MarkdownEditorController.ts`
- `src/features/document-conversion/ExportController.ts`
- `src-tauri/src/commands/conversion.rs`
- `tests/table-roundtrip.mjs`
- `tests/markdown-links/fixture.ts`
- `tests/native-conversion.mjs`
- `tests/phase042/link-input.mjs`
- `tests/run-suite.mjs`
- `docs/table-export-roundtrip-20261106.md`

## 根因及处理

1. 原始样例本身不是有效的 GFM 表格：表头位于二级列表项，分隔行和数据行却退回顶层，不能组成同一容器里的表格。列表段落允许 lazy continuation，不能用“出现管道符”推断表格，也不能自动改变这段原文的语义。
2. 确实存在 WYSIWYG 产生非法 Markdown 的问题。旧的 `table` serializer 调用 `state.write(serializeTable(node))` 一次输出多行；ProseMirror MarkdownSerializerState.write 只在这次调用开头应用列表/引用的 delimiter。首行之后缺失必要缩进或 `> `。新回归用旧 handler 重建此失败，证实新 handler 的重新解析一致。改为 `state.text(..., false)`，使每一行都使用容器 delimiter。
3. SourceBridge.prepare 保存新源码时仍直接保留原 PM 树，没有验证表格能否恢复。因此当前会话的 table 和预览使用的源码可能不一致，切换/重建暴露差异。现在真实表格编辑会核对新源码恢复的表格内容、属性及容器位置；失败时尝试合法序列化，仍不可恢复则拒绝该事务，保留原文。
4. 原生 Markdown 粘贴先走 parseMarkdown；语义 HTML 粘贴走 PM DOMParser。后者可以直接形成 table，暂时绕开错误源码的重新解析，这解释了为何复制/粘贴有时能恢复显示。现在两条链路都经过同一序列化与提交检查。HTML 表格在进入 PM 前统一 GFM 表头与列对齐；PM 插入新行时补齐新单元格的列对齐属性。
5. 容器内表格变化可以按 markdown-it 的 table token map 局部替换，不重写外围列表、空行和兄弟块；单个文字编辑继续优先使用现有源码局部补丁。未编辑的非法 Markdown 不会批量转换。没有通过 CSS 掩盖错误。

有效写法之一：将整张表放进原列表项，移除表头前的额外子列表标记，所有表格行保持两个空格缩进：

```markdown
- 消耗汇总和消耗总览的区别

  | 对比 | 消耗汇总 | 消耗总览（任务消耗总览） |
  | --- | --- | --- |
  | 主要用途 | 汇总任务每天的多人消耗 | 综合查看任务的投入和效果 |
  | 重点数据 | 日报消耗、注册、首充 | 预算、KPI、成本 |
```

如希望表格独立于列表，在列表后留空行，所有表格行去掉缩进即可。GFM 容器和表格边界依据：https://github.github.com/gfm/#tables-extension- 。

## 导出目录

ExportController 只增加当前文档的 `documentToken` 和配置的 `defaultDirectory` 提示，不发送任意源文件绝对路径来索取权限。

Rust 在阻塞任务中通过 FileService 的当前窗口 owner 和 revealed_path(token) 校验授权、路径及存在性，取真实文档父目录。目录可用性检查要求绝对路径、目录存在且可读取。优先文档父目录，其次有效配置目录，最后系统文档目录，通过 Tauri Dialog Builder.set_directory 设置；不存在可用候选时让原生对话框自行回退。

配置目录仅影响初始 UI，不产生授权。目标仍必须通过原生保存确认及 ConversionStore.selected 生成单次、窗口绑定的 lease；取消不会生成输出。再次导出仍调用保存对话框，历史目标路径不作为写入授权。文档路径、工作区归属、版本检查及现有覆盖确认机制保持原有流程。API：https://docs.rs/tauri-plugin-dialog/latest/tauri_plugin_dialog/struct.FileDialogBuilder.html#method.set_directory 。

## 自动验证

- `pnpm typecheck`：通过。
- `pnpm build`：通过，仍有既有动态导入/大 chunk 提示。
- `pnpm test:regression`：最终 30/30 通过。前两次在既有链接模板用例遇到选区同步超时，独立重跑通过；测试 helper 在物理 ArrowRight 前等待两帧发布 DOM 选区后，全量通过。无链接产品逻辑修改。
- `cargo test --lib --manifest-path src-tauri/Cargo.toml`：68/68 通过，含目录优先级、中文/空格/Unicode、无效/相对目录、失效源文件、伪造 token 和跨窗口 token 测试。
- `node tests/native-conversion.mjs`：29 项通过。含四种格式参数、取消、不同文档、未保存文档、配置目录、重复导出重新确认、历史路径不授权、源元数据不变。
- `node tests/table-roundtrip.mjs`：通过。10 种有效结构分别以 LF/CRLF 测试，含独立表格、列表后表格、列表项内、多层列表、引用、空行边界、无外侧管道符、有序列表及列表后续兄弟项。覆盖中文、链接、代码、加粗、转义管道符、物理单元格编辑、撤销/重做、10 次模式切换、行列增删、Markdown/HTML/Word 风格 HTML 粘贴、同表复制粘贴、物理跨单元格拖选和 dragstart 防护。
- 表格断言同时检查 canonical Markdown、markdown-it table token、重新解析的 PM 树及表格容器位置、Live DOM、Split DOM 和逐单元格内容；通过 manager.saveSnapshot 获取实际保存字节，在临时目录写入、读取、重新打开，确认 LF/CRLF 和源码保真。原始非法结构以及列表 lazy continuation 反例保持原文且不误判为表格。

日志位于 `test-results/table-export-{typecheck,build,rust,regression-final}.log`、`test-results/table-roundtrip.log`；原生记录位于 `test-results/table-export-native.json`。

## 真实 Windows 桌面验证

运行当前代码的 Tauri 开发版，使用独立于已安装应用的开发实例。

- 原生打开 `E:\code\Markumo\test-results\表格 导出验收\系统理解.md`。
- PDF、HTML、DOCX、PNG 均实际打开原生保存窗口，四次初始地址均为文档同级目录，文件名分别为 `系统理解.pdf/html/docx/png`。
- PDF、DOCX、PNG 取消后无相应输出；HTML 实际保存成功，输出含表格，当前 Markdown 路径不变。
- 桌面 Live → Split → Live 后表格仍可编辑；将“中文”改为“中文验收”，Ctrl+S 保存，关闭并从磁盘重新打开后仍为可编辑表格。磁盘源码只改变单元格，保留列表缩进、空行及 CRLF。
- 将测试源目录临时移走后再打开 PDF 原生保存窗口，初始地址安全回退到系统“文档”，取消后恢复测试目录。
- 新建未保存 Markdown 后打开 PDF 原生保存窗口，默认文件名为 `Untitled-1.pdf`，初始地址为系统“文档”，取消不产生输出。

## 覆盖边界

- Typora、Word 来源通过相应 HTML 片段模拟剪贴板，未在这两款应用内实际复制。
- 无可用 UNC 共享做端到端验证；实现使用 Path/PathBuf，不拆分盘符或网络路径。不同盘符/UNC 的原生端到端测试、不可读 ACL 目录、用户临时改选目录和已有文件覆盖确认仍需补充人工验收。
- 原生桌面只实际生成 HTML，其他格式验证保存对话框和取消；格式生成沿用既有导出测试。配置目录/重复导出通过前端与 Rust 测试覆盖，尚未逐项执行原生桌面矩阵。
- GFM 不支持合并单元格等复杂表格；不可恢复的表格编辑会明确拒绝，不将其静默保存成错误源码。
