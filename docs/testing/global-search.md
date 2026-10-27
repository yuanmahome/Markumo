# 全局搜索与替换验收报告

日期：2026-10-27。开发分支：`main`。开始开发时本地 HEAD 为 `cf52977a7a1152a56aef320a89aaf006ec074c6e`；再次 fetch 确认远程 main 仍为 v1.0.9 的 `17a5dec36ab0c42a02c0dcb508d500a8e6a7fe65`。

## 实现范围

旧工作区搜索的状态、原生查询和替换安全链路可以复用。原有问题是完整 UI 嵌在 Sidebar，依赖工作区根目录，结果没有稳定身份与版本，完成事件不能说明截断或跳过情况，也没有按需源码预览。此次将 UI 迁移为应用内浮窗，继续使用同一个 `WorkspaceController`，没有新增正文存储、全文索引或另一套查询引擎。

| 要求 | 实现与验证 |
| --- | --- |
| 统一查找/替换窗口 | 同一浮窗切换模式，保留条件与结果；Mod+Shift+F / Mod+Shift+R 使用原有可自定义命令配置 |
| 窗口管理 | 默认 820px / 70vh，最小宽度 560px，最大 85vh；小视口服从安全边距；拖动、边缘缩放、固定、位置尺寸持久化、Esc 与焦点恢复 |
| 原有布局 | 打开搜索不改变单文件/工作区模式，不展开或切换左侧资源管理器；旧 Sidebar 搜索只保留入口 |
| 实时查询 | 250ms 防抖、Enter 立即查询、空查询不扫描、IME 期间不查询；唯一 searchId、取消与迟到事件过滤 |
| 搜索状态 | idle/searching/complete/empty/canceled/limited/partial/error；结果达到上限明确标为不完整，跳过数与原因显示在窗口内 |
| 结果列表 | FileIcon、文件分组、折叠、路径/名称/数量排序、行列排序、稳定 ID、独立勾选、虚拟滚动、主题高亮与零宽标记 |
| 键盘 | 输入框方向键保持编辑语义；结果列表方向键/Home/End、Enter 打开、Mod+Enter 固定标签；Tab 边界、Esc 关闭、组合输入保护 |
| 右键操作 | 打开、固定标签、右侧分栏、复制命中文本/路径/相对路径/位置、文件管理器显示、仅搜索所在目录；没有文件授权的操作禁用 |
| 源码预览 | 单个懒加载只读 CM，选择时复用；当前命中单独描边加粗，其余命中高亮；真实行号、上下文、纯文本高亮降级 |
| Markdown | 预览仅使用源码语法解析，不创建 ProseMirror，不渲染图片、HTML、Mermaid 或数学资源 |
| 搜索范围 | 多根工作区、授权工作区内目录、全部已打开文本及无路径草稿；缓冲区优先；二进制、媒体、class/Hex 不加入文本缓冲区查询 |
| 文件过滤 | 标准 globset，在遍历和计入匹配上限之前生效；文件名/根相对路径、多规则、递归、括号候选、包含/排除；同名工作区根显示可区分路径 |
| 忽略规则 | 搜索忽略项是独立选项，界面明确标记；替换仍按原有忽略安全规则拒绝写入 |
| 替换预览 | 当前文件、选择命中、全部范围都先生成 Rust Diff；文件/单条/全选、折叠、取消；红删绿增并有符号与行列上下文 |
| 替换执行 | 打开文件走 canonical EditorState 事务，可 Undo/Redo 且不自动写磁盘；关闭文件复用原生版本校验、捕获组重算、编码、权限与原子安全写入 |
| 批次与冲突 | 不完整结果禁用“替换全部”；明确选择后可审阅受限预览；逐文件进度、取消未开始文件、关闭窗口不取消已批准批次、保留成功/失败/跳过报告 |
| 历史 | 20 条去重查询/替换文本及几何信息存入本机轻量 metadata，支持清空；不保存文档正文，不发送网络 |
| 集成 | 活动栏、文件树目录菜单、主菜单、命令面板、旧工作区搜索命令都打开同一窗口；当前文件 Mod+F/Mod+R 保留 |

## 关键文件

| 文件 | 职责 |
| --- | --- |
| `src/components/search/GlobalSearchDialog.vue` | 浮窗、查询/选项/范围/历史、几何、快捷键与焦点、右键菜单、替换入口 |
| `src/components/search/SearchResultList.vue` | 分组虚拟列表、排序、键盘导航、稳定选择与复选框 |
| `src/components/search/SearchCodePreview.vue` | 唯一只读 CM 实例、当前/全部命中装饰、语法支持按需加载与销毁 |
| `src/components/search/SearchReplacePreview.vue` | 原有 ReplaceFile/ReplaceEdit 的 Diff 审阅与执行控制 |
| `src/features/workspace/WorkspaceController.ts` | 统一查询、取消、批量事件、预览版本、历史、范围、替换授权、事务与报告 |
| `src/features/workspace/searchModel.ts` | 轻量元数据、结果身份、Glob 列表拆分、基于 CM Text 行索引的有界缓冲区预览 |
| `src/features/workspace/contracts.ts` / `tauriWorkspace.ts` | 兼容扩展 IPC 模型与监听注册就绪屏障，复用既有查询/写入命令 |
| `src-tauri/src/workspace/search.rs` | 原搜索器增加范围、标准 Glob、编码、稳定命中/版本、UTF-16 位置、详细结束状态与共享预览生命周期令牌 |
| `src-tauri/src/workspace/preview.rs` | 按需版本化源码窗口、授权检查、两项有界 LRU，拒绝过期位置 |
| `src-tauri/src/workspace/replace.rs` | 复用捕获组、安全写入；补充已打开/草稿预览、过滤、逐项错误和只读保护 |
| `src-tauri/src/commands/workspace.rs` | 后台查询/预览、窗口所有者隔离、关闭取消与释放缓存、原生目录选择授权 |
| `src-tauri/src/lib.rs` / `workspace/mod.rs` | 注册预览、缓存释放、目录选择命令与模块 |
| `src/App.vue` / `src/app/useAppShell.ts` / `useShellCommands.ts` | 浮窗懒挂载与单一命令入口、与其他应用弹窗协调 |
| `ActivityBar.vue` / `Sidebar.vue` / `TreeNodeItem.vue` | 实际快捷键提示、移除旧完整搜索 UI、目录入口 |
| `src/features/shell/mainMenu.ts` / `keybindings/definitions.ts` | 查找、替换和目录命令复用可配置快捷键体系 |
| `src/components/common/Icon.vue` | 与现有图标一致的固定图标 |
| `tests/search/browser.mjs` / `native.mjs` | 浏览器真实组件交互与 Windows WebView2 原生链路验证 |
| `src-tauri/src/workspace/search_tests.rs` | Rust 查询、过滤、预览、替换、编码、安全、取消和预算专项 |
| `tests/run-suite.mjs` / `tests/outline/visibility.mjs` | 将搜索专项纳入 smoke/regression，适配搜索不再占侧栏的行为 |
| `scripts/memory-release-build.mjs` | 仅 global-search 隔离测试构建开放控制器测试入口，正式构建不注入这些入口 |

## Rust 与数据安全

新增直接依赖 `globset = 0.4`；它原本已由 `ignore` 间接引入，没有新增大型框架。前端只拆分逗号规则列表，完整 Glob 语法由 globset 编译，错误通过原有 IPC 返回。Windows 按平台惯例忽略 Glob 大小写，其余目标采用区分大小写规则。

搜索继续在 `spawn_blocking` 中遍历。每批 32 个结果，前端约 50ms 合并，至多 1000 处；保留 10 MiB/文件、100000 遍历项、10 秒等预算。命中包含文件版本、文档 ID、UTF-16 行列与截取后的列位置，长行不会把实际命中剪掉。CRLF/CR 仅在搜索/预览的临时字符串中归一，磁盘写入继续使用原编码和换行。

所有工作区路径仍经过根授权与符号链接/路径穿越检查。输入目录不建立额外授权；原生选择器返回的目录也必须属于已经授权的工作区。`opened` 范围只读取前端提供的文本缓冲区，不因此获得磁盘写权限。

替换继续由 Rust regex 在新读取并校验的文件中重算捕获组与字符边界。关闭文件保留原子写入和身份校验；已打开文件再次核对 FileToken、外部磁盘版本、Text 快照、组合输入与只读状态，通过 `applyWorkspaceReplacement` 修改同一权威 EditorState。没有重写保存、Markdown、TabGroup 或分栏内核。

## 资源与兼容性

不新增 WebView、常驻正文索引或全文件缓存。源码 CM 仅在首次选中结果后创建，选择切换复用一个实例，窗口关闭销毁。打开缓冲区利用现有 Text 行索引，只取上下文；关闭文件仅按需读取选中文件，缓存最多两项、总计 16 MiB，按所有者/路径/大小/修改时间与原搜索版本检查。IPC 返回约前 20/后 21 行且至多 256 KiB，超长行明确标记截断。

JS 预览 epoch 丢弃旧响应；原生预览共享窗口生命周期取消令牌，关闭时阻止正在读取的旧请求重新填充缓存。搜索窗口关闭释放源码窗口、替换快照与不需要的 Diff 数据，只保留有界结果和轻量报告/历史。

Windows、Linux 沿用 Mod=Ctrl；macOS 沿用项目 Mod=Meta。窗口交互使用 PointerEvent、ResizeObserver 和视口约束，没有 Windows 专属几何算法。Windows Chromium 和原生 WebView2 已实际运行；macOS/Linux 原生运行未在本机执行，不能据此声称原生兼容实测通过。macOS 大小写不敏感卷的 Glob 行为目前没有专门探测，仍按非 Windows 的区分大小写规则处理。

## 自动化结果与复现

结果日志置于忽略的 `test-results/search/`。Windows 临时目录最初不允许测试的原子回滚副本读写；使用仓库内隔离 TEMP/TMP 后测试通过，没有更改产品的保存策略。

```powershell
pnpm check
pnpm typecheck
pnpm build
pnpm test
$searchTestTemp = Join-Path (Get-Location) 'test-results/search/tmp'
New-Item -ItemType Directory -Force $searchTestTemp
$env:TEMP = $searchTestTemp
$env:TMP = $searchTestTemp
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
node tests/search/browser.mjs
node scripts/memory-release-build.mjs --label=global-search
node tests/search/native.mjs
$env:MARKUMO_PHASE042_RELEASE_LABEL = 'global-search'
pnpm test:regression
```

- Rust：21 项通过，覆盖大小写/全词/多命中/无效正则/捕获组/中文与 UTF-16 列/UTF-8、UTF-16LE/BE、GB18030/LF、CRLF、CR/长行/二进制与大小预算/多根与同名根/目录越权/遍历阶段 Glob/忽略保护/取消/结果上限/未保存与草稿/只读/外部冲突/空替换/有界预览/锚点/2100 文件。
- 浏览器：9 组通过，实际操作完整 App/Vue 组件，测试事件投递网关只用于制造延迟/错误；查询、模型、UI、编辑事务与 Undo/Redo 仍为产品实现。覆盖防抖与迟到事件、虚拟列表、预览复用、方向键、折叠、替换选择与预览应用、IME、Glob 列表、主题、固定、拖动缩放、焦点、反复开关、订阅数量、历史重载与清空。
- 原生：13 组通过，使用隔离 Release、独立配置与真实 Windows 文件；完整 Tauri → Rust → 文件/缓冲区链路，不以假的原生搜索或写入替代。测试包含原有 Ctrl+F/Ctrl+R、真实 Ctrl+Z/Ctrl+Y、关闭窗口期间的写入、取消后剩余文件保留、实际剪贴板位置、目录授权、分栏、CRLF 与 UTF-16LE 磁盘字节、外部修改拒绝、快速预览、资源回收。
- 回归：11/11 脚本通过；搜索浏览器专项已进入 smoke/regression；保留既有 Markdown、链接、空白行、大纲、懒加载、渲染任务和 Pane 生命周期覆盖。Windows A–N 14 场景使用最终 global-search 构建，200 个静止代码块嵌入 CM 创建数/live/peak 全为 0。

| 命令 | 最终结果 |
| --- | --- |
| `pnpm check` | 通过，实际调用 typecheck 与 build |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | 通过，28 项链接/Markdown 浏览器交互检查 |
| `cargo check --manifest-path src-tauri/Cargo.toml` | 通过 |
| `cargo test --manifest-path src-tauri/Cargo.toml` | 21 passed / 0 failed |
| `node tests/search/browser.mjs` | 9/9 交互组通过 |
| `node tests/search/native.mjs` | Windows WebView2 13/13 通过 |
| `pnpm test:regression`（global-search Release） | 11/11 脚本通过，包含 A–N 14 项原生验收 |

最后一次 Windows 原生实测：2100 个文件加真实小工作区的过滤查询 41ms；20 次并发预览切换、旧响应丢弃与最终选中显示共 75ms。搜索前后均只有 1 个 WebView。反复打开/关闭窗口 15 次，强制 GC 后 JS heap 从 24,516,744 降至 13,565,888 字节，DOM Nodes 从 3438 降至 2183，CDP Documents 保持 2；这是短期回收检查，不代表长期运行的内存上限承诺。预览实例 DOM 身份在切换间保持相同，关闭后实例 DOM 不存在，事件订阅没有累积。

生产构建存在既有的大 chunk/Pandoc Node 模块外置提示；Rust 有已有工具和保留兼容入口的 dead_code 提示，均非构建错误。当前按行 Rust regex 不支持跨行匹配，输入区明确提示。源码预览和替换预览受上述预算约束；结果不完整时不得伪装完整范围执行替换。

提交 SHA 随最终交付记录提供。此次不推送、不发布、不修改版本号；用户并行修改的 `src/editor/outline/codeAdapters.ts`、`outlineService.ts` 以及 `tests/outline/visibility.mjs` 中对应的未完成语法断言保留且排除在搜索提交外；该测试文件仅将搜索不占侧栏的适配行纳入本次提交。
