# 导出与首次启动验收记录

2026-11-04，Windows，本地 main。初始修复阶段未修改版本号或发布；后续经用户明确授权，准备发布 v1.2.1。

## 第一阶段：导出

根因与修改：

- `ExportRenderer.ts` 原来在 Mermaid 专用安全编译之后再次运行普通 HTML 白名单。真实 DOM 对比见 `test-results/export-quality/report.json`：flowchart 原有 1 个 style、12 个 marker，经普通净化后均为 0；sequenceDiagram 的 8 个 marker、classDiagram 的 20 个 marker 同样消失。现在先净化普通内容，再插入安全编译并重新命名内部 ID 的 SVG；没有开放普通 HTML 的 SVG 白名单，也没有开放脚本或外部资源。
- `ExportMedia.ts` 共用预览的严格 Mermaid 编译器、资源分类与原尺寸读取。Word 通过任务独享 Worker 请求单图 2x PNG；不将整页截图作为 Word/PDF。图片按实际比例适配页面，16 MP 像素预算、媒体预算和图片数量上限分别约束解码、栅格与嵌入。Blob、Canvas、iframe 和 Worker 都有清理路径。
- `ExportMath.ts`、`ExportSemantics.ts` 共用数学与脚注解析，`nativeDocxExport.ts` 使用相同 Markdown 基本语义。公式在 HTML/PDF 使用 KaTeX 文字排版和内嵌字体，在 Word 中使用单公式 2x PNG。脚注使用明确告知的文末列表；HTML 块在 Word 仍作为源码保留。
- Word 原先固定图片为 16:9，且把换行直接写入 w:t；现在按图片尺寸计算 DrawingML，源码换行和 Tab 对应 w:br/w:tab。表格增加明确列宽与内边距，单元格 br 映射成换行；标题和图表前说明尽量同页。去除与首个 H1 重复的自动标题。
- `files/images.rs` 的相对链接解析复用文档 token 验证、规范路径及工作区 guard，仅允许源目录或已授权工作区下的实际文件。使用绝对 file URL，因而不依赖导出位置。Native 实测同目录 Markdown、工作区相邻代码文件通过，越界和 javascript 协议拒绝；详见 `native-links.json`。Office 仍可以按自己的安全策略显示确认。
- `conversion.rs` 取消固定 1200 ms 打印等待，改为页面加载完成后，通过固定的宿主只读探针等待 DOM、字体、图片终态及 SVG 布局连续就绪；超时明确失败。文档 CSP 仍为 script-src none，探针不执行用户内容。打印仅允许内嵌图片和字体。
- `ExportStyles.ts` 允许长代码、长表格与引用分页，重复表头，缩放超宽/超高图表，避免整块内容溢出。PNG 单独转换 SVG 后走已有截图输出，增加总像素预算；修复长内容撑大 Canvas 的问题。860 宽、2x 配置的实际产物为 1720 × 9888，测试断言输出宽度。
- 视觉检查额外发现 mindmap 中央标签缺少文本居中锚点，已在专用 SVG 规范化阶段修正；foreignObject 降级文字的居中样式也显式保留。

实际产物位于 `test-results/export-quality/`：

| 产物 | 检查方法 |
| --- | --- |
| acceptance.html | 浏览器实际布局、截图、DOM 安全与 SVG 定义检查 |
| acceptance.docx / acceptance-word.pdf | 本机 Microsoft Word 打开、导出 6 页并逐页检查 |
| gallery.docx / gallery-word.pdf | 11 种 Mermaid 单图嵌入 Word，逐页查看节点、文字、箭头与比例 |
| native-final.pdf | 通过原生保存对话框授权，实际 WebView2 PrintToPdf，6 页逐页检查 |
| product-export.png | 调用产品 ExportController 的 PNG 路径，非测试页面截图替代 |
| native-text.txt | pypdf 从原生 PDF 提取出的中英文正文，验证可以搜索/复制 |
| native-startup.png / native-second-startup.png | 首次与第二次真实桌面启动截图 |

Mermaid 11.16.1 实测编译、栅格与 Word 嵌入：flowchart、sequenceDiagram、classDiagram、stateDiagram-v2、erDiagram、gantt、gitGraph、pie、mindmap、timeline、xychart-beta。不是对这些语法所有参数和所有 Office 版本的兼容承诺。

剩余限制：超长单图采用等比缩小，不自动跨页切割图表，建议按语义拆图或选择横向纸张。Word HTML 块、脚注、任务标记和 TOC 与交互式预览仍有已说明的差异；公式在 Word 中不是可编辑 OMML。Linux/macOS 原生 PDF 尚未实现，保留错误提示。不同 Office、字体及 emoji 系统的外观可能有差异。

## 第二阶段：默认设置

修改 `editorSettings.ts`、`contracts.ts`、`syntaxTheme.ts` 和 Rust `settings.rs` 的缺省值：wordWrap=true、codeWrap=true、syntaxStyle=vivid，copyAcrossBlocks=true 保持原值。不提升设置版本，不重置设置。

TypeScript 浏览器断言和 Rust serde 测试分别验证缺省值、显式 false、跨段复制关闭、soft 配色及历史版本设置保留；保留 Fleet 等旧配色别名的迁移。自动换行仍只调整显示。

## 第三阶段：真实示例工作区

`examples/` 提供根操作指南、八份 Markdown 文档（含完整语法、11 类 Mermaid、导出综合样例）、九种代码、五种配置、四种文本及媒体文件。`tauri.conf.json` 将其作为安装资源发布。

`examples.rs` 在加载偏好产生新文件之前记录新用户资格，识别旧偏好、会话和迁移标记。首次普通启动复制到 Documents，创建目录失败时回退应用数据；同名目录使用新名字。持久化 pending/complete/skipped 状态，复制用临时文件加 no-clobber 提交，逐文件读取、不覆盖已有文件，失败不记完成。进程内互斥与现有单实例机制防止多窗口重复复制。

`session.rs` 在现有启动/恢复流程中接入示例根目录与 README。文件关联启动跳过自动示例；“帮助 → 打开示例工作区”走现有工作区接口，保留已有修改。

已测试：初始化、再次启动、旧用户、文件关联优先、复制源中断后重试、目标不是可写目录时回退、同名目录、修改不被覆盖、多线程并发。真实桌面程序第一次打开示例树和 README；打开 Hello.java 后正常关闭，第二次启动仍选择 Hello.java；帮助菜单入口实际可见。

尚未做真实 NSIS 安装/升级、Linux/macOS 启动和完整 NTFS ACL 拒绝写入的端到端测试；不可写回退使用被普通文件占据的目标路径模拟。崩溃恢复沿用既有流程，pending 初始化恢复有单元测试，未模拟机器断电。

## 第四阶段：README 与回归

中英文 README 保留安装、构建、许可证及原技术文档链接，补充三模式、CodeMirror/ProseMirror、源码保真、示例工作区、默认设置、操作入口及各格式平台限制。

已通过：

- pnpm typecheck；pnpm build（保留原有打包体积/浏览器外部模块警告）。
- cargo test --manifest-path src-tauri/Cargo.toml --lib：38/38。
- pnpm test:export：默认值/旧设置、11 类图表、二次净化损失、安全内容、公式、图片、源码换行、图表失败、缺图、取消、真实 Worker、HTML/DOCX/PDF/PNG 产物。
- 既有 Markdown 链接导航、源码保真、撤销重做、空行、表格图片边界、代码块、剪贴板、大纲、搜索、拖拽、工作区打开/删除等套件在全量运行中通过。
- Mermaid 统一媒体预览、标签生命周期、所有权和 lossless 套件单独补跑通过，日志在验收目录。
- 后台渲染测试原用 span[class] 把行号和文本容器算作高亮；改为在代码文本容器内统计高亮，测试通过。

未全部通过：pnpm test:regression 多次运行均存在 `link-input.mjs` 中“先填目标再输入 Unicode 标签”的间歇失败；该脚本单独运行曾全部通过，但全量运行仍再次失败。失败表现为标签被插到空链接之后。未掩盖结果、未把全量回归标为通过，也未为此重写链接编辑功能。日志：`regression-suite.log`、`regression-final.log`。这是交付前仍需跟进的回归风险。


## v1.2.1 发布前复查

此前间歇失败已定位为 CDP 注入 Unicode 文本时，原生 Home/Arrow 的 selectionchange 尚未同步到 ProseMirror。测试现在等待实际选区到达标签位置后再注入文本，保留原有源码、撤销重做和模式切换断言，没有跳过失败用例或修改编辑语义。修正后 pnpm test:regression 完整运行 25/25 通过；Rust 38/38、导出专项、类型检查和构建通过。原先失败日志作为历史记录保留，已不再是本次发布的阻断项。测试源码与所需夹具纳入版本控制，并将导出专项加入 CI。
