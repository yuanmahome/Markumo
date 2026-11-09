# Markdown Live：卡顿定位、稳定路径修复与未通过项目

2026-11-09，基于 main `9c88461b3e4bf8026f281235fb5391f867ef7348`。远程 main 查询结果相同。已阅读 AGENTS.md、上一轮 Markdown 报告和 P03 架构报告。本轮没有创建分支或 worktree、修改版本号、提交、推送或发布。测试安装使用独立名称、配置和 WebView 数据目录，不覆盖生产安装或用户文档。

**P0 分区实时编辑仍未通过。** 本轮修复了既有 Live 路径中的实际热点，使 95 万字符样本从首次输入超时恢复为可以输入、撤销重做并保存重开。仍然是全文 MarkdownSourceBridge、全文 ProseMirror Document/View，不是渐进式分区 Live，也没有用静态 HTML 代替编辑器。现有双栏分区预览及多类型统计未重复开发。

## 1. 实际完成

| 定位结果 | 修改 | 实际边界 |
|---|---|---|
| 每张表格都有工具栏 Decoration；编辑前文后位置变化导致大量 DOM/事件重建 | 每个 Live Pane 仅保留一个活动表格工具栏；观察活动表格及容器尺寸，销毁时断开观察器 | 表格正文仍全部驻留 DOM |
| 搜索已关闭仍枚举全部代码块的 getPos；其内部位置查找随节点数增长 | 搜索关闭且已清空高亮时跳过枚举 | 搜索开启后的全文匹配、位置查找仍需优化 |
| canonical CM StateField 每次 Live 输入都触发隐藏的全文数学高亮解析 | 改为源码视图 ViewPlugin，没有源码视图时不执行该工作 | 源码视图含数学语法时仍全文扫描 |
| 普通单块修改仍遍历、序列化所有 SourceBlock | PM 内容差异定位单块，调用原无损序列化器验证局部结果，外部源码跨度原样保留 | 结构变化、引用依赖变化回到原路径；更新后续坐标和拼接全文字符串仍 O(n) |
| 光标与源码坐标转换线性遍历块 | 按共享块数组 WeakMap 缓存累计位置，二分定位 | 块数组变化后仍需建立累计位置表 |
| 首次打开先全文 tokenize，再对每个普通块重复 tokenize | 对完整结构边界复用同次解析的 token 投影 PM 节点；不能精确复用的列表等保留原解析 | 首次 tokenize 和 PM 构建仍覆盖全文 |
| 选区变化重复扫描空段落、嵌套 sourceId、扩展视图和全 DOM :focus-within | 空段 Decoration 按不可变 doc 缓存；跳过未改节点的嵌套 ID 扫描；选区路径跳过扩展刷新；从 activeElement 查祖先 | 文档改变仍有顶层线性工作；保留空文档首次 sourceId 初始化以保护组合输入段落 DOM |
| 列表及表格对齐插件每次修改遍历全文 | 只访问变化的顶层结构及相邻结构，保留跨边界列表合并 | 单个超大列表/表格仍可能很昂贵 |

源码保真、原 canonical CM Undo/Redo 和多 Pane 文档提交契约继续使用原实现，没有裁剪历史或按大小禁用功能。

## 2. Windows Release 方法与身份

机器：i5-12600KF、约 64 GiB RAM、Windows 11 Home China、WebView2 157.0.4341.42。使用真实 NSIS 隔离安装后的 Release EXE，每场景独立进程/Profile/UDF。并非开发服务器计时。程序包含两版一致的只读诊断计数及 DocumentManager 引用，身份记录在原始报告和构建清单中；未发布安装包。

基线为精确 HEAD 源码归档构建 `live2-before`；规模矩阵为 `live2-after`；最终源码构建为 `live2-final`，后者补充了空文档组合输入初始化保护。构建后校验全部 `src/`、`src-tauri/` 源输入 SHA-256，最终为 `1321424c0a0c8458b36adae2da9a6e6b8997ad21a7da42a779f2f410c0b4234c`。未打包 EXE SHA-256 为 `b8278c5882120c274ea20acedbeb84758a2cc079b37e8712abca47244f7f6b8f`；安装后二进制散列另见原始 JSON。安装器只允许同字节或 Tauri bundler 标志 UNK→NSS 三字节差异，其他差异使测试失败。构建时曾有 bundler 标志文件占用警告，NSIS 构建及安装成功；本报告不验证更新器。

950k 合成样本为 950,000 UTF-16 单位、1,245,969 UTF-8 字节、103,249 行，包含中文、emoji、标题、列表、表格和代码。它复现用户规模，并不是用户未提供的实际文档；也不能代表所有 Mermaid、公式、图片密集场景。另生成同正文 CRLF+BOM 样本。固定样本 SHA-256：`411b083b1a0e077aa9d67c76a034dc64bb35cb9a9ec0143697a5d33ed4573d36`。

计时从已运行应用的 native 文件打开请求开始，包括读取、解码、IPC、编辑器创建和两帧；不含应用启动，不声称物理磁盘冷读。输入通过 WebView2 `Input.insertText`，每键等待两帧，包含 CDP 往返；20 键 × 3 轮汇总 P50/P95，不能等同硬件键盘或原生输入法候选框时延。首屏没有像素级人工可读性验收。所有原始轮次保留，不剔除慢样本。

## 3. 性能前后对比

基线三次 950k Live 首屏为 6715.75 / 6711.16 / 6698.84 ms；三次首次实际输入均超过 30 s，测试终止，不虚构输入分位数。规模矩阵使用 `live2-after`，每项三次新进程，以下为中位数，持续输入分位数来自每项 60 键：

| 文档 | Live 首屏 ms | 首次输入操作 ms | 打开至首次输入完成 ms | 持续输入 P50 / P95 ms | 功能链路 |
|---|---:|---:|---:|---:|---|
| 100 KiB | 401.24 | 99.36 | 540.51 | 31.36 / 42.36 | 3/3 |
| 500 KiB | 1371.05 | 413.68 | 1866.79 | 95.50 / 123.11 | 3/3 |
| 950k 字符 | 3043.46 | 1042.24 | 4243.63 | 238.04 / 344.14 | 3/3 |
| 2 MiB | 4866.82 | 1685.02 | 6833.26 | 371.57 / 600.78 | 3/3 |
| 5 MiB | 11506.27 | 4524.13 | 17212.96 | 1099.42 / 1480.95 | 3/3，体验不合格 |
| 10 MiB | 23240.30 | 8004.51 | 34208.54 | 2303.22 / 4218.78 | 0/3，保存受阻 |

“功能链路”只指本轮自动化执行的输入→Undo/Redo→原文保存→修改保存→关闭重开→Source/Split/Live 往返，不能当作完整编辑能力验收。未编辑保存检查原始文件字节 SHA-256；修改保存独立生成含中文和 emoji 的预期字节并比对散列。文件权限、冲突和保存仍经过真实 Rust 命令，并实际写入测试文件。

同一 950k 规模矩阵中，Live→Source 204.09 ms，Source→Split 首屏 56.70 ms，Split→Live 2745.80 ms。Split 首屏不等待完整索引；这只是既有双栏功能的复测。尚未测量本轮双栏编辑刷新、大纲远跳、全局搜索替换和连续滚动的原生耗时。

最终构建另有 LF / CRLF+BOM 各三次完整功能链路通过；该六次与浏览器 smoke 时间重叠，仅作为功能补测，不用于主要性能比较。之后另做无并发浏览器测试的 950k 三次最终构建测量：首屏中位数 **3012.18 ms**，首键操作 **1018.81 ms**，打开至首键完成 **4134.43 ms**，持续输入 60 键 **P50 233.70 / P95 308.51 ms**；Live→Source 208.75 ms、Source→Split 54.50 ms、Split→Live 2727.28 ms。不同构建和不同轮次没有合并成同一组。

### 剩余输入延迟的 Windows 原生诊断

另外三个新进程仅用于 profiler / 渲染 trace，**不混入上述三轮性能数据**。在一个不含渲染 trace 的诊断中，20 次输入的 Live.dispatch 合计 343.80 ms（单次最大 23.30 ms），其中 PM.applyTransaction 117.70 ms、PM.updateState 111.40 ms、Bridge.prepare 23.00 ms、updateTools 1.00 ms。这些是嵌套调用，不能相加当成总耗时。

另一次 Performance 指标增量：ScriptDuration 357.73 ms、LayoutDuration 466.18 ms、TaskDuration 5375.67 ms、TaskOtherDuration 4372.28 ms。CPU profile 中大量时间显示为 `(program)`，单凭它不能判定具体浏览器子系统。因此再采集一次独立渲染 trace，20 次 `textInput` 事件合计 1782.20 ms，62 次主线程 `Commit` 合计 1729.83 ms，41 次 Layout 839.23 ms，PrePaint 644.28 ms，Paint 303.69 ms。不同事件有嵌套、不同线程可能重叠，且 trace 有额外开销，不能把这些总数相加或当作正常输入分位数。

这些证据支持下一阶段必须缩小全文 contenteditable/渲染树的工作集；继续只优化 Markdown 字符串同步已不足以解决当前约 234 ms 的总响应。**这是结合原始 trace 的工程推断，不是已实现的 PM 分区窗口。** 当前保留全模型路径，避免为了压低计时破坏浏览器原生选区、输入法和跨结构编辑。

## 4. 内存与生命周期

以下为原规模矩阵 loaded 快照的三轮中位数。基线在首键前采样，优化版在首键后采样；不是严格同阶段的配对峰值，也不是长时间内存曲线。JS Heap、embedder 与进程 Private 有重叠，不相加。

| 文档/构建 | 进程树 Private MiB | JS Heap Used MiB | embedder heap MiB | 连接 DOM 元素 |
|---|---:|---:|---:|---:|
| 950k 基线 Live | 1484.51 | 179.67 | 850.96 | 530371 |
| 950k 优化 Live | 1360.75 | 165.85 | 576.64 | 344557 |
| 2 MiB 优化 Live | 1951.34 | 273.96 | 1067.15 | 579707 |
| 5 MiB 优化 Live | 4618.54 | 569.88 | 2564.86 | 1448706 |
| 10 MiB 优化 Live | 8736.92 | 1166.49 | 4843.39 | 2897007 |

950k 工具栏由 6883 个降至 1 个，但主体 DOM 仍随全文增长。上一轮约 481 MiB / 1.6 GiB 是其他模式/场景的报告，不能与本轮 Live 数字直接计算改善比例。Rust、Browser、GPU、Renderer 等 Private 分项保留在每个原始样本；没有逐类型 retained 堆证据，不能宣称已精确归因所有 AST、字符串和图表缓存。

最终 950k loaded 各进程角色的 Private 中位数：Rust 6.32 MiB、Browser 42.29 MiB、Renderer 1182.14 MiB、GPU 103.40 MiB、Utility 合计 18.91 MiB、crashpad 2.60 MiB。各列独立取中位数，和总量中位数不必严格相等。当前自然进程内存主要在 WebView Renderer，仍需堆/原生分配证据区分 PM、DOM、字符串、布局及缓存，不能把整个 Renderer 都记为 JS Heap。

完成保存重开及模式往返后，关闭 1.5 s 的 950k 规模矩阵 Private 中位数仍达 3287.13 MiB，JS 170.39 MiB。canonical records、Live views、PM/CM 活动计数、Worker 均归零，连接 DOM 回到 159；这些计数只证明销毁路径执行，不能证明所有内存即时释放。

最终构建 loaded 的 Private / JS 中位数为 **1356.14 / 165.59 MiB**。关闭曲线如下，时间为计划等待点，采集本身还需要少量时间；本轮未完成逐类型 retained 分析、多轮长时间增长平台或独立窗口的资源证明。

| 最终构建 950k 阶段 | 进程树 Private MiB | JS Heap Used MiB |
|---|---:|---:|
| 打开前冷进程 | 199.49 | 约 7.5 |
| 保存重开及模式往返后，关闭 1.5 s | 3294.14 | 217.98 |
| 关闭后约 10 s，自然回收 | 325.99 | 23.58 |
| 关闭后约 30 s，自然回收 | 326.02 | 23.59 |
| 最后显式 GC，仅诊断 | 313.53 | 13.87 |

显式 GC 发生在所有性能测试及自然回收快照之后，不作为自然释放结果。自然回收确实发生，但与冷进程仍有差距；当前证据不能证明零残留或长时间无增长。

## 5. 测试与失败记录

新增真实 Live 回归包含 84 个快慢序列化差分修改、380 个映射范围/旧实现对照位置、950k 编辑和 Undo/Redo、两 Pane 同步及共享不可变块数组、关闭销毁、搜索关闭时零代码位置枚举、空文档组合输入首字段落 DOM 保持。并保留既有源码无损、表格、数学、列表和媒体回归。

完整 smoke 首次运行在 `blank-line-persistence.mjs:215` 空段落 ArrowUp→ArrowDown 的光标断言失败（1 != 0），此前源码字节和 2912 个空白差分用例已通过；原日志保留。该脚本独立重跑全部通过，未改断言；不能称首次整套零失败。这一导航用例在既有 P03 报告也有间歇失败记录，但仍需要后续稳定性排查。最终测试结果以归档日志为准。

继续运行剩余回归时，`render-tasks-phase2.mjs` 仍断言双栏应一次驻留全部 40 个代码围栏，实际为 10；这是上一轮虚拟预览后的旧测试约束。本轮将该测试改为验证初始/滚动驻留有界、40 个不同围栏全部可滚动到达、近视口高亮及切回 Live 后预览 DOM 完全卸载。没有修改产品预览逻辑；旧失败日志保留，修正后的测试通过。

最终 `pnpm typecheck` 通过；smoke 清单 35 个脚本均已分批通过（首次前 13 个、补跑中间 17 个、修正旧预览断言后最后 5 个），**不是单次完整零失败**。新增 Live 大文件回归、源码无损 73/73、Mermaid/媒体、生命周期等均在这些日志中。Rust 产品代码未改动，本轮没有重跑 Rust 套件，不沿用旧报告的 Rust 通过数冒充本轮结果。

原规模矩阵有三次 CRLF+BOM `Reopen mismatch`：测试把规范化 LF 内存正文与含 BOM/CRLF 的磁盘字节散列混比。此时两次磁盘保存 SHA 已通过；修正 oracle 后单独三次及最终构建三次均通过。旧失败未删除，旧 runner 快照保留；不能将修正测试混写成旧矩阵全过。

10 MiB 三次均在 `saveOriginal` 被现有历史保护拒绝：`history_backup: 保存前历史备份失败，原文件未覆盖：文档超过 8 MiB，未记录历史版本`。拒绝后的磁盘 SHA 重新核对为原始值。没有关闭历史或绕过保护来制造通过结果，故没有 10 MiB 成功保存/重开的证据。

## 6. 修改文件

应用源码：`mathHighlight.ts`、`wysiwyg/LiveSearchController.ts`、`LiveTableToolbar.ts`、`MarkdownEditorController.ts`、`MarkdownParser.ts`、`MarkdownSourceBridge.ts`、`listNormalization.ts`，新增 `changedBlocks.ts`（均位于 `src/editor/markdown/`）。

测试/工具：新增 `tests/live-large/{fixture.html,fixture.ts,profile.mjs,regression.mjs}`、`scripts/live-large-native.mjs`、`scripts/live-large-report.mjs`，更新 `tests/run-suite.mjs`、`tests/phase042/render-tasks-phase2.mjs`；新增本报告及其同名数据目录。没有 Rust 产品代码、splitPreview 或 DocumentStats 改动。

## 7. 未完成项与下一阶段阻碍

1. **P0 Live 窗口化尚未实现**：首次全文解析、全文 PM 初始化、完整 DOM 和每 Pane 独立 View 均存在。单块同步快路径仍复制后续元数据和拼接整串；结构性编辑仍可回到全文解析。950k 持续输入约 0.24–0.34 s，仍不流畅，不能签收完整实时排版目标。
2. 跨分区选择、全文复制、全局坐标与撤销、窗口卸载前提交、输入法驻留、表格/公式/图表跨窗口上下文尚没有正式 Live 实现。原稳定编辑路径保留，但未对 950k 全部复杂功能做原生逐项签收；OS 中文输入法候选框未测，仅合成 composition 和原生 Unicode 注入。
3. Rust 原型优先复用其磁盘 piece tree、UTF-8/CRLF 映射、revision/cancel、流式搜索与窗口接口。但当前 feature 隔离、UTF-8/BOM、仅保存副本，尚未接入生产文件授权、身份冲突、所有编码、历史、原子覆盖保存及恢复。必须先建立共享权威文档和全局选择/历史契约，再让 PM 只投影结构窗口；直接把原型一页套到 Live 会丢失上述能力。
4. **16 MiB 打开/保存整体容量限制未消除**；8 MiB 历史快照和恢复预算也需流式迁移，不能简单删除 MAX_BYTES 或绕过保护。10 MiB 的保存阻碍已由真实安装版验证。
5. 双栏结构索引仍随 content 重新启动，稳定 ID、变更区重扫、依赖失效、跨 Pane 共享及高度/滚动锚点复用未实现。审查发现 structure.ts 使用 `{html:true}`，正式 semantics 还有 breaks/linkify/CJK 等配置，尚未统一；不能声称完全一致。
6. 正文统计、可配置正文/源码口径和新一轮统计取消/独立窗口/内存矩阵未实现，继续保留上一轮源码统计。本轮未将其改名为正文统计。
7. 复杂表格/Mermaid 密集、超长代码/单段、滚动帧率、远程大纲/搜索、真实用户文档、全部窗口能力和逐类内存归因仍待测。没有以首屏可见或双栏成功代替这些验收。

参考 [Nomo](https://github.com/nomo-md/nomo) 的共享会话、视口预取、离屏回收思路；其当前公开主线已采用 Rust/GPUI，旧 WebView 路径与 Markumo 不能直接等同。应基于明确源码版本研究结构索引和布局协议，不能把不同渲染架构的 README 性能数字作为 Markumo 验收。

## 复现与证据

原始报告、构建身份、失败记录、运行器快照、诊断 profile 和测试日志 gzip 归档在 [数据目录](markdown-live-20261109/summary.json)。summary 保存每个未压缩文件的 SHA-256。生成脚本还校验最终应用源码身份、成功样本的保存 SHA 和被拒绝保存的原文件 SHA。

```powershell
pnpm typecheck
node tests/live-large/regression.mjs
pnpm test:smoke
# 标签必须新建，避免覆盖既有基线二进制。
node scripts/memory-release-build.mjs --label=<new-label> --isolated-installer
# 将 NSIS 安装到独立测试目录，再设置精确安装后的 EXE。
$env:INSTALLED_BINARY='<isolated-install>/markumo.exe'
$env:CLOSE_CURVE='1'
node scripts/live-large-native.mjs <new-label> 3 950k
```

新增计时/内存采集脚本只在测试副本上保存，不使用或覆盖用户原文。隔离测试安装和原始生成物保留在被 Git 忽略的 `test-results/`，本轮不发布为产品安装包。

## 后续发布授权

上述性能测量及源码指纹冻结后，用户明确要求发布新版本，随后在 main 将版本字段递增为 1.2.6，发布说明位于 `docs/releases/v1.2.6.md`。前文“未修改版本号、未提交、未推送、未发布”描述优化与测量阶段；发布准备阶段另行执行校验和仓库发布工作流。原始诊断构建及结果保持原身份，不将其源输入散列改写为递增版本后的应用源码。

版本递增后本地 `pnpm check`（类型检查、生产前端构建）、`cargo check --locked` 和 Rust 库测试 72/72 通过；浏览器回归采用上文相同编辑实现的 35 项分批结果，远程 Quality Gate 另按发布提交执行。构建保留既有大 chunk 和未使用代码警告，不将其表述为零警告。
