# 搜索工具窗口与 Markdown Mini 改造验收

日期：2026-11-17～18。基线：`a1e8bd7e7c986f50622b2d4c9f39b3730dd28fa8`。所有产品修改位于 `main`。最初实现阶段未修改版本号或推送；用户于 2026-11-18 明确授权发布新版本，准备发布 1.3.0。发布准备时快进同步远端 `45221841`（1.2.9），保留其行内导航、表格光标和构建工具修复，再叠加本次改造；没有创建开发分支或新的 Git 工作树。

## 阶段与架构

| 阶段 | 实施内容 |
| --- | --- |
| Phase 1 | 审计 `App → useAppShell → WorkspaceController → tauriWorkspace → Rust workspace` 搜索/预览/替换链，以及 DocumentManager 的规范文本、编辑状态和原生窗口注册/关闭流程；审阅 Nomo 三个 Mini 源文件。 |
| Phase 2 | CodeMirror 与实时 Markdown 共用右上角悬浮查找/替换条。ResizeObserver 观察编辑器容器，按 800/500/320px 切换布局；窄容器选项菜单，极窄容器可折叠，快捷键直接展开。替换第二行、IME、计数、定位及规范事务保持原链路。 |
| Phase 3 | 全局搜索从模态弹层变为编辑区底部工具窗口；可调整高度，宽屏左右分栏、窄屏上下分栏，可隐藏预览；共享搜索/替换模式、默认折叠过滤条件。增加当前匹配替换入口，继续使用现有 Diff、文件/匹配勾选、冲突校验、进度、取消及失败报告。 |
| Phase 4 | 原生 Tauri 搜索窗口，独立拖动/缩放/最小化与重新停靠。每个编辑窗口有独立配对的搜索窗口和随机会话令牌，每次弹出使用新的原生窗口标签，避免迟到的销毁事件误关新窗口；Rust 负责配对、生命周期和原子保存窗口几何信息。 |
| Phase 5 | 顶部右侧入口/视图菜单/命令面板的 Mini 模式在原生窗口内切换。保留编辑器 DOM、CodeMirror/ProseMirror 实例、规范文本和历史；只隐藏外围界面，默认 400×520，置顶、拖动、八向缩放、退出恢复位置/尺寸/最大化状态。 |
| Phase 6 | 类型、构建、Rust、浏览器、Windows WebView2、内存及生命周期验证；下方记录结果和边界。 |

主窗口保留唯一 WorkspaceController 和 DocumentManager。独立窗口通过 `main.ts` 的独立动态入口加载搜索 UI，不执行 App Shell 的工作区、文件、恢复、自动保存或更新初始化。结果仍为原有 1000 项有界摘要，源码仍为 256 KiB 有界预览；Diff 传送既有 UI 实际展示的截断片段。不会传递 `SearchQuery.buffers`、规范全文、EditorState 或索引。

主窗口广播节流为 40ms，消息具有会话令牌、视图实例标识、递增请求号、搜索 ID、快照版本与输入确认号。过期的选择/替换操作被丢弃；尚未确认的输入不会被旧快照覆盖。搜索和替换实际操作全部回到主窗口，继续受既有 `replaceApplying`、版本和文件操作互斥保护。主窗口处于启动、更新安装、更新确认或丢弃确认时，辅助窗口的修改请求也会被阻止，取消与关闭仍可执行。搜索条 ResizeObserver、IPC 监听、几何拖动监听、预览和辅助窗口均有释放路径。大型匹配数据及源码预览使用非深层代理数据。

关闭辅助窗口恢复停靠并保留工作区；主窗口销毁时原生层销毁辅助窗口。辅助窗口不登记编辑会话、文件所有者或工作区服务，更新窗口统计也排除辅助搜索视图。重新加载主界面时，旧会话的辅助窗口会被替换；首次连接超时会尝试恢复停靠。Mini 不改变编辑模式，也不参与自动保存和文档复制。

Nomo 参考：[mini.rs](https://github.com/nomo-md/nomo/blob/master/src-gpui/src/ui/mini.rs)、[mini/native.rs](https://github.com/nomo-md/nomo/blob/master/src-gpui/src/ui/mini/native.rs)、[workspace/mini.rs](https://github.com/nomo-md/nomo/blob/master/src-gpui/src/ui/workspace/mini.rs)。仅参考同一原生窗口切换与布局恢复方式，未照搬实现；Markumo 保持用户原来的 Markdown 编辑模式。

## 自动化结果

最终测试使用同步 1.2.9 后的 1.3.0 隔离 Release，二进制 SHA-256 为 `2c8d35cfad32ca7baef29f79034fb0cbdc27c46e18e7139218b5ab75c5b0d955`。测试探针不进入发布安装包。

| 检查 | 结果 |
| --- | --- |
| `pnpm check`（类型与生产构建） | 通过；最终修复后再次执行通过，隔离 Release 构建通过 |
| `cargo check --locked` | 通过，生产权限中没有测试几何权限 |
| `cargo test --locked` | 74 项通过，0 失败 |
| 浏览器全局搜索 UI | 10/10 通过，停靠/分栏/过滤/历史/预览释放/主题与替换 |
| 编辑器容器响应式工具条 | 12/12 组通过，含三种 Markdown 模式和 Java/SQL/TXT、四档宽度、替换及 Undo/Redo |
| Windows 原生搜索 | 13/13 通过，包含 2100 文件搜索、替换安全和 Undo/Redo |
| Windows 原生窗口与 Mini | 7/7 通过，包含更新屏障、刷新、过期会话、最小化、几何恢复、8 次弹出/关闭、主窗口销毁 |
| 完整 `pnpm test:regression` | 41/41 脚本通过，0 失败；其中无损编辑 73/73、原生 A–N 14/14、五类生产资源回收检查通过 |
| 发布版本一致性检查 | 通过，四处版本均为 1.3.0 |

既有验收脚本同步修正了高亮统计选择器（排除行号/文本外壳）和基于静态骨架的 DOM 增长计数，并等待 DOM 光标布局完成后测试原生方向键。最终回归还发现上游局部源码在 PM 更新前直接移除装饰 DOM，使异步 DOMObserver 覆盖方向键/Shift 选区；已调整为 PM 先移除装饰再清理资源，补充跨帧选区保持验证，没有改写文本或历史实现。

另外通过只读加载 1.2.9 的对应控制器复现了既有空白段落粘贴公式后多保留分隔行的问题。空白段落不再走普通行内源码粘贴捷径，改用既有结构更新路径管理空行；公式粘贴与重新解析一致性测试通过。合成粘贴测试先等待 End/Enter 的原生选区事务完成，避免测试本身向旧段落粘贴。

## 性能采样

同一台 Windows、单屏 2560×1440、100% DPI，隔离 Release、新配置、1200×780 主窗口、15000 行相同 Markdown、1000 项有界结果；GC 后采样。私有内存统计整个进程树，JS 堆统计主 WebView。

| 场景 | 基线私有内存 MiB | 1.3.0 私有内存 MiB | 基线 JS 堆 MiB | 1.3.0 JS 堆 MiB |
| --- | ---: | ---: | ---: | ---: |
| 空窗口 | 201.25 | 194.53 | 6.36 | 7.10 |
| 打开文档 | 232.06 | 224.77 | 10.79 | 11.52 |
| 搜索与源码预览 | 240.76 | 227.69 | 12.32 | 13.03 |

主窗口 JS 常驻增量约 0.74 MiB。独立搜索 UI 的 JS 堆为 5.47 MiB，但额外原生 WebView 带来的进程树私有内存增量约 73.92 MiB，不能把 UI 堆大小等同于系统窗口成本。8 次弹出/关闭后仅剩一个 WebView、7 个进程；主 JS 堆从 17.64 降至 17.63 MiB，DOM 节点从 2393 降至 2016，关闭时源码预览已释放。

这些是单次观测，原生内存受系统/分配器波动影响，不能归因为本次改造带来的内存下降，也不能代替长时间压力测试。最终样本还包含远端 1.2.8/1.2.9 修复。完整数值、初版复测数值、二进制与输入摘要见 [JSON](../performance/search-mini-20261117.json)。

## 实际验证边界

- Windows 真实 Tauri/WebView2 原生窗口测试，使用隔离 Release 与测试配置、测试文档；浏览器不是用 CSS 模拟系统窗口。
- 浏览器测试覆盖 Markdown 实时/源码/双栏、Java/SQL/TXT，900/600/400/280px 的编辑器容器（浏览器窗口保持宽屏），替换及 Undo/Redo。
- 最终完整浏览器回归使用锁文件对应的 Playwright Chromium。额外系统 Chrome 探查中，行内标记边界方向键曾出现一次额外停靠，导致导航用例超时；该跨浏览器边界行为未作为本次通过项，不能将默认测试通过解读为所有 Chromium 版本一致。
- 全局搜索既有 Rust 与原生测试继续验证多根目录、磁盘版本冲突、编码/EOL、缓冲区与磁盘写入区分、预览预算和取消。
- 中文输入测试使用合成 composition 事件和真实中文文本。操作系统候选窗、拼音/五笔候选选择需要人工验证。
- 本机只有一个显示器，早期为 1920×1080，最终前后对比均为 2560×1440、scaleFactor=1；没有实际第二屏、显示器热拔插或原生高 DPI 切屏的测试条件。保存几何信息按当前显示器工作区和缩放重新约束，但不把这一逻辑检查等同于硬件验收。
- 多根目录/打开文档搜索由既有自动化覆盖；多个编辑主窗口同时弹出搜索并进行交互的长时间实机压力测试尚未完成。原生配对及会话按 owner 窗口隔离，不使用进程内全局搜索单例。
- macOS 和 Linux 没有编译或实机测试。跨平台实现使用 Tauri API；Wayland 明确拒绝要求精确位置恢复的 Mini 操作并给出原因，普通独立搜索仍使用系统窗口；位置保存/恢复失败会显示错误。
- 本次未增加 UI 框架或依赖。既有搜索引擎、正则逐行限制和替换预算保持不变。

## 复现

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
$env:TEMP = Join-Path (Get-Location) 'test-results/tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
node tests/search/browser.mjs
node tests/search/editor-toolbar.mjs
node scripts/memory-release-build.mjs --label=search-mini-final
node tests/search/native.mjs --label=search-mini-final
node tests/search/windows-native.mjs --label=search-mini-final
$env:MARKUMO_PHASE042_RELEASE_LABEL = 'search-mini-final'
pnpm test:regression
```

前后比较使用同锁文件、隔离配置、相同 15000 行 Markdown、1000 项搜索结果，以及 GC 后采样。历史源码为 Git archive，只用于基线编译，无新增分支或 Git 工作树。历史构建可用 `node scripts/memory-release-build.mjs --ref=<基线提交> --full-ref --label=search-mini-before`；之后运行 `node tests/search/windows-native.mjs --label=search-mini-before --baseline`。Windows archive 采用 ZIP，避免系统 tar 对部分中文路径的解压失败。

测试配置增加窗口几何操作权限和只读测量探针，仅存在于隔离测试构建。生产不会暴露测试用的管理器变量或改变实际文档事务。

Mini 明确隐藏活动栏、侧边栏、文件树、文档大纲、多标签栏和非必要工具栏；保留用户原来的侧边栏/大纲偏好，退出后恢复。Mini 的原生缩放不会触发主界面的窄屏收起偏好。滚动恢复使用现有 CodeMirror 视图的文本锚点快照和实时编辑器的 DOM 阅读锚点；自动换行、视口变小时，允许视口为保持原光标可见而调整，不复制全文或重新初始化编辑器。

Mini 入口位于主窗口顶部右侧，设置按钮之后、系统最小化按钮之前。入口、置顶和返回使用现有 SVG 图标体系与统一的悬停/焦点样式；无文字符号图标。

## 修改文件清单

- `docs/performance/search-mini-20261117.json`
- `docs/releases/v1.3.0.md`
- `docs/testing/global-search.md`
- `docs/validation/search-mini-20261117.md`
- `package.json`
- `scripts/memory-release-build.mjs`
- `src-tauri/Cargo.lock`
- `src-tauri/Cargo.toml`
- `src-tauri/capabilities/default.json`
- `src-tauri/gen/schemas/capabilities.json`
- `src-tauri/src/commands/app.rs`
- `src-tauri/src/commands/update.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/tool_windows.rs`
- `src-tauri/tauri.conf.json`
- `src/App.vue`
- `src/app/useAppShell.ts`
- `src/app/useShellCommands.ts`
- `src/components/common/Icon.vue`
- `src/components/common/iconPaths.ts`
- `src/components/layout/TopBar.vue`
- `src/components/search/GlobalSearchDialog.vue`
- `src/components/search/SearchWindowApp.vue`
- `src/editor/core/SearchBar.ts`
- `src/editor/core/searchPanel.css`
- `src/editor/core/searchPanel.ts`
- `src/editor/markdown/wysiwyg/LiveSearchController.ts`
- `src/editor/markdown/wysiwyg/LiveClipboard.ts`
- `src/editor/markdown/wysiwyg/MarkdownEditorController.ts`
- `src/features/shell/mainMenu.ts`
- `src/features/windows/useMiniWindow.ts`
- `src/features/workspace/WorkspaceController.ts`
- `src/features/workspace/searchWindow.ts`
- `src/main.ts`
- `tests/markdown-links/regression.mjs`
- `tests/markdown-links/math-lists.mjs`
- `tests/markdown-source-fidelity/regression.mjs`
- `tests/phase042/acceptance-a-to-n.mjs`
- `tests/phase042/blank-line-persistence.mjs`
- `tests/phase042/inline-source-navigation.mjs`
- `tests/run-suite.mjs`
- `tests/search/browser.mjs`
- `tests/search/editor-toolbar.mjs`
- `tests/search/native.mjs`
- `tests/search/windows-native.mjs`

复用且未改写的服务与组件：Rust workspace/search.rs、preview.rs、replace.rs，以及 SearchResultList、SearchCodePreview、SearchReplacePreview。
