# 大纲显示：用户偏好、文件能力与解析状态

## 基线与根因

2026-10-27 检查并拉取远端 main。开发基线 HEAD 为 `0f992d3c8a0860b9da604b2a63583df713c7102d`（包含已完成的空行持久化修复），远端 main 为 `17a5dec`。本次继续在 main 修改，不创建分支或工作树，不改版本号，不推送或发布。

原有编辑容器只按 showOutline、文档存在和布局空间显示侧栏，没有区分文件是否具备结构能力。outlineService 在加载完成后才检查词法/结构解析器和适配器，并把所有情况压成 items + notice，导致不支持的文件也占据侧栏和分隔条宽度。空结构、加载中和失败缺少独立状态。

此外，大纲命令被归入 Markdown 命令类别并受 Markdown 模式条件限制，Java 等已有适配器的文件无法正常使用菜单/快捷键；多个直接切换 showOutline 的入口没有统一能力保护。状态栏的符号路径还会在关闭大纲时请求结构提取。

## 状态设计与统一规则

- `showOutline: boolean`：现有持久化用户偏好，只由用户主动操作或加载其保存设置改变。没有新增 Markdown 大纲开关。
- `OutlineCapability = markdown | code | unsupported`：`outlineService.getOutlineCapability(document)` 根据**当前语言模式**查询 languages/index.ts，并核对 codeAdapters。Markdown 为 markdown；Lezer 结构解析器且存在适配器为 code；其余为 unsupported。二进制/媒体和 Hex 文档也不请求结构提取。能力判断不看标题、符号数量、加载成功与否，也不靠扩展名。
- `OutlineParseStatus = loading | ready | empty | error | paused`：属于现有 OutlineResult，表达当前解析结果。加载中、失败、空结构均不会改变能力或用户偏好。

实际可见性为 `showOutline && supported && !focusMode && !spaceCollapsed`。Shell 提供统一能力和开关入口；编辑容器继续使用原有布局空间预算和左右停靠规则，并从 manager.activeDocument 读取活动 Pane 的文档。解析状态不参与可见性判断。

## 八条显示规则测试矩阵

| 规则 | 文件/状态 | showOutline=true | showOutline=false | 验证 |
| --- | --- | --- | --- | --- |
| 1 | Markdown 有标题/无标题 | 显示标题或 Markdown 空状态 | 隐藏 | 浏览器完整 App + WebView2 |
| 2 | 代码有适配器、有结构（Java） | 显示代码结构 | 隐藏 | 浏览器完整 App + WebView2 |
| 3 | 代码有适配器、无结构 | 显示“当前文件暂无可提取的代码结构” | 隐藏 | 浏览器完整 App + WebView2 |
| 4 | Lezer 解析器、无适配器（HTML） | 隐藏整个面板与分隔条 | 隐藏 | 浏览器完整 App + WebView2 |
| 5 | 仅 StreamLanguage（Shell） | 隐藏整个面板与分隔条 | 隐藏 | 浏览器完整 App + WebView2 |
| 6 | TXT / LOG | 隐藏整个面板与分隔条 | 隐藏 | 浏览器完整 App + WebView2 |
| 7 | 支持的代码解析器加载中/语法树尚未完成 | 保持显示“正在加载代码结构…” | 隐藏且不提取 | 浏览器完整 App 受控 loader |
| 8 | 支持的代码解析器加载失败 | 保持错误提示与“重新加载代码结构”入口 | 隐藏且不提取 | 浏览器完整 App 真实 setLanguage 失败与重试链路 |

不支持文件的活动栏按钮禁用并显示“当前文件不支持大纲”；菜单和命令面板使用同一命令注册表的 enabled/detail；快捷键沿同一能力保护执行，不修改偏好。支持文件的选中状态由 showOutline 决定。大纲命令改为视图类全局命令，保留原命令 ID、自定义键位与默认 `Ctrl+Shift+O`，现在也适用于 Java。

## loading、error、empty 和性能

加载中和失败不会卸载或隐藏整个侧栏，也不会改变侧栏宽度。UI 专项逐帧检查显示状态并校验同一个 aside DOM 实例。重试复用 DocumentManager.setLanguage；现有语言加载器在失败后允许重新加载，不新增加载系统。

没有符号返回 empty，保留空状态；未完成语法或截断说明仍可显示。超预算文档返回 paused，保留能力及“文档较大，大纲已暂停。”提示。

不支持文件和用户关闭大纲时，useDocumentOutline 在提取前退出并取消待执行更新。状态栏符号路径也遵守现有大纲请求开关，避免在侧栏关闭后继续后台提取；启用时仍复用同一个提取服务、缓存和导航功能。源码、选区及历史不因显隐发生事务变更。

原有 WeakMap 按 Text/语法树的缓存、80ms 更新合并、代码 256 KiB / Markdown 1 Mi 字符预算，以及代码 1000 项 / 50000 节点 / 30ms 提取限制均保留。增量语法解析继续使用原有最多三次、每次 8ms 的推进策略。codeAdapters 和语言注册表的提取实现未改写。

## 多 Pane、停靠与已有功能

- 左 Pane Java、右 Pane TXT：活动 Pane 切至 TXT 隐藏；切回 Java 恢复。代码符号导航作用于当前活动 Pane。
- 单文件模式、大纲独占左侧时在左；工作区文件树或搜索占据左侧时在右；关闭左侧内容面板后恢复左侧。
- 自动隐藏时 outline-sidebar 和 outline-resizer 同时释放宽度；恢复支持文件后重新使用保存宽度。窗口过窄或专注模式临时隐藏不修改 showOutline。
- 保留原 OutlineView 的折叠、展开、滚动、导航、Markdown 章节拖动及 Undo/Redo，没有新增第二套大纲。
- 浏览器测试验证用户保存的 330px 宽度；原生测试验证 310px 宽度在两次正常退出和应用重启后保持。

## 修改文件

- `src/editor/outline/outlineService.ts`：能力判断、显式解析状态、错误结果。
- `src/editor/outline/useDocumentOutline.ts`：按能力/请求调度、加载状态、取消和重试状态判断。
- `src/components/layout/EditorContainer.vue`：活动 Pane 能力、可见性、错误重试。
- `src/components/layout/OutlineView.vue`：空状态和错误重试入口。
- `src/components/layout/ActivityBar.vue`、`MarkdownLiveToolbar.vue`：一致的按钮能力判断。
- `src/components/layout/StatusBar.vue`：关闭大纲时不后台请求结构。
- `src/app/useAppShell.ts`、`useShellCommands.ts`、`src/App.vue`：统一能力与用户操作入口。
- `src/app/useShellPreferences.ts`：明确持久化偏好的边界，设置格式保持不变。
- `src/features/shell/keybindings/definitions.ts`：将现有大纲命令适用于支持代码结构的文件。
- `tests/outline/visibility.mjs`：真实 App UI 的 24 个要求场景，加 paused 预算检查。
- `tests/outline/webview.mjs`：Windows 原生文件、设置落盘及两次应用重启。
- `tests/run-suite.mjs`：将大纲 UI 专项加入 smoke/regression。

## 自动化与实测

| 检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | 28 项浏览器交互检查通过 |
| 大纲 UI 专项 | 10/10 组通过，覆盖要求 1–24 及 paused 预算 |
| `pnpm test:regression`（当前隔离桌面构建） | 10/10 通过，含 Windows 桌面综合验收 A–N 14/14，零错误 |
| Windows WebView2 大纲专项 | 原生文件显示/隐藏、宽度释放、设置落盘、正常退出并重启两次均通过 |

```powershell
pnpm typecheck
pnpm build
pnpm test
node tests/outline/visibility.mjs
node scripts/memory-release-build.mjs --label=outline-visibility
node tests/outline/webview.mjs
$env:MARKUMO_PHASE042_RELEASE_LABEL='outline-visibility'
pnpm test:regression
```

大纲 UI 专项挂载真实 App、偏好服务、命令/菜单、布局及编辑器，直接操作真实 DOM；测试仅通过 Vite 暴露现有 Shell 进行观测，并注入已有 languageLoader 接缝以控制 loading/error，不替换大纲服务。还记录实际提取调用次数，断言不支持或用户关闭时为零。

Windows 专项使用最新隔离构建、生产 Tauri open_recent、原生 editor-settings.json 和正常窗口关闭链路。检查 Markdown/Java/空状态/HTML/Shell/TXT/LOG 的实际可见性与宽度，用户关闭后切换文件，退出并重新启动两个应用进程验证 false/true 偏好均持久化。

测试明细保存在未纳入 Git 的 `test-results/outline/visibility.json`、`webview.json`、`regression.log`、`build.log` 和 `test.log`；桌面综合验收记录为 `test-results/phase042/acceptance-a-to-n.json`。

边界：loading/error 的受控失败与逐帧稳定性在 Chromium 完整 App 中验证；WebView2 使用实际正常语言加载链路，未人为损坏已打包语言资源。大文档维持原有暂停策略，不承诺超预算结构提取。
