# 原生文档转换验收（v1.2.2）

基线为 main `6ebcff4b9ada7ead095a954cdc3b814098027e9a`，已通过 GitHub 分支 API 核对。所有修改均在 main。用户随后授权发布 v1.2.2。

## Phase 1、2：解析与资源

原因为 Word 导入走外部进程及其 JSON 文档树，应用自身没有 OPC/OOXML 语义读取器。新增 `src-tauri/src/conversion/docx/`，使用 ZIP、quick-xml 和类型化 AST，独立序列化 Markdown。根据包关系定位主文档、样式、编号、媒体和注释，不假设固定部件路径。

支持样式继承、H1–H6、Title、加粗/斜体/删除线/代码、换行/Tab、引用、分隔符、列表起始编号及嵌套、普通及合并/嵌套表格、链接、图片、脚注、尾注、中文和 emoji。复杂表格使用受控 HTML。

安全预算：输入/单个 ZIP 条目 16 MiB；总解压量 64 MiB；4096 个 ZIP 条目；单个 XML 8 MiB；累计 250000 个 XML 节点；深度 96；256 个独立图片。拒绝重复/危险 ZIP 路径、符号链接、DTD、外部实体、宏内容类型及不受信任的关系路径；不下载外部资源，不执行 Office 对象。

## Phase 3：两阶段导入

`ImportController.ts` 原先先选择输出、转换写盘，再新建未命名副本。现在先后台解析，原生内存保存短期预解析结果，再选择保存路径、提交资源和 Markdown，最后通过安全文件服务打开真实文件。已有标签复用；未保存缓冲区不被刷新覆盖。

预解析和目标授权均绑定窗口，限时、限并发且一次性消费。资产写入随机独立批次，Markdown 最后原子提交；正常失败回收本批次，已有图片不删除、不覆盖。进程崩溃可能留下未被任何 Markdown 引用的独立资源目录，不会伪造完整 Markdown。

## Phase 4：移除旧转换路径

删除旧 Bridge、外部进程/JSON AST 和专用网络代码，移除检测、设置项、菜单提示及安装说明。统一结构化 warnings；可展开查看，避免连续 toast 只留下最后一项。HTML/PNG/DOCX 保存采用原始二进制 IPC，不用 JSON 数字数组。

## Phase 5：导出与验证

保留现有可取消 Worker DOCX Writer、应用 WebView2 PDF 和内部 PNG/HTML 渲染。修复图片 HTML 的二次 Word 导出、图片尺寸及替代文字、表格对齐和代码样式。新增中文标点加粗规则，实时排版、源码语法树、预览、剪贴板与 Word 使用同一范围受限策略，保留源字符和位置。

自动测试：

- `pnpm typecheck`、`pnpm build`：通过。
- `pnpm test:export`：通过，11 类 Mermaid、公式、图片、PNG 尺寸、安全过滤、Worker 取消及表格对齐。
- `pnpm test:regression`：29/29 脚本通过，含源码无损 73/73。首次运行一项链接输入超时，独立重跑和两次整套复跑均通过。
- Rust 单元测试：66/66，通过解析、安全预算、取消、跨窗口授权、目标/来源冲突、独立资源批次和失败回滚。
- 原生转换前端交互：18 项通过，覆盖真实文件打开、重复标签、脏文档保护、源/目标取消、失败恢复、原始二进制提交、HTML 和带尺寸图片往返。
- 中文加粗：6 类读取/模式切换/预览/Word，6 类转义/代码/CommonMark 保持，以及真实编辑器逐字输入、Undo/Redo，均通过。

样本与可复现输出位于忽略目录 `test-results/native-docx/`，不把第三方文档装进应用：

- Markumo 导出的验收 DOCX：16 个标题、10 个列表项、1 张表格、7 张图片，成功解析。
- LibreOffice 测试库中的 Word 生成样本（`docProps/app.xml` 为 Microsoft Office Word）：`footnote.docx`、`ImageCrop.docx`、`image_data.docx`、`math-mso2k7.docx`、`table-auto-nested.docx`。来源为 `https://github.com/LibreOffice/core/tree/master/sw/qa/extras/ooxmlexport/data`。实际解析分别验证脚注、内嵌图片、页眉文字、OMML 警告和嵌套表格。
- WPS 原始样本：`https://github.com/whitel1st/docem/tree/59db436045fcee10f5e733ef543fdbfde612964a/samples/clear/example_wpsoffice_docx`；14 个原始 OOXML 部件与 Git blob SHA 逐字节相同，仅重新 ZIP 封装。生产者标记为 WPS Office Community 10.1；3 个段落及加粗文字成功解析。该样本只验证基本文字格式，不能代表复杂 WPS 文档覆盖。
- 5000 段中文/英文/emoji 文档及构造的损坏、路径穿越、重复条目、宏、ZIP/XML 预算和实体攻击包：单元测试通过。

当前机器有外部转换程序，未卸载用户软件；桌面验收进程使用只含 Windows 系统目录的 PATH，所有转换走内置调用链。Word/WPS 应用本身不可用，未声称在本机 Word/WPS GUI 中重新排版验收。

Windows 已实际安装隔离的 NSIS 包（独立标识和配置），通过真实文件菜单导入 DOCX，保存并打开 `ui-import.md`，7 个真实图片文件落盘，无未命名副本；关闭后升级 v1.2.2 保留该文件会话。通过菜单生成 `ui-import.pdf`（WebView2 原生、251087 字节）及 `ui-import.html`（619476 字节）。v1.2.2 再次通过菜单导入 `ui-final.md`，多级列表显示正确，图片实际可见；再导出 `ui-final.docx`，ZIP 内含全部 7 张图片，正文 XML 保留中文、CodeBlock、右对齐和图片尺寸。证据截图为 `test-results/native-docx/ui-v1.2.2-images.png`。PNG 长图菜单也成功输出 `ui-final.png`（1720×10056，1565873 字节）。生产配置 NSIS 构建成功，未使用测试配置覆盖生产标识或数据目录。

## 明确限制

不承诺页面像素复原。OMML 未转 LaTeX，保留文字并警告；SmartArt/对象尽量提取文字或预览；WMF/EMF/SVG/TIFF 内嵌图不能直接导入时有占位和警告；图片裁剪/浮动环绕和页眉页脚布局不还原；字体、下划线等未列入首批支持的 Word 排版格式可能降级。复杂 HTML 表格再次导出 Word 时目前以源码文字保留并提示。原生 Word 输出的公式/图表为图片，脚注为文末列表。PDF 仅 Windows 原生实现。上述限制都不依赖外部软件回退。
