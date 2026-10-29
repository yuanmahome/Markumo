# P0.1：Windows WebView2 内存高水位调查

调查日期：2026-10-28～29。状态：完整三轮验收仍在运行，最终数字待填。已确认的保留链、探针成本和原生诊断如下。

## 测量范围与复现

已阅读 P0 审计、原生对照、窗口对照及 Phase 04.2 内存优化报告，并检查文档、编辑器、渲染队列、图片、PDF、恢复、文件监控和原生窗口的生命周期。此前连续测试的后置场景含前序负载，不能直接当作该文件在新进程中的成本。

本轮采用 Windows 的实际 Tauri Release 构建，前端生产打包、Rust release 优化；仅追加各版本相同的测试计数及 DocumentManager 测试入口。它们是隔离的测试程序，不是已签名发布安装包。历史版本通过 `git archive` 导出完整只读输入构建，包含该版本的 Rust，未创建分支或 Git 工作树，也没有修改历史源文件。构建记录保留二进制 SHA-256、完整源输入指纹和原生目录树标识。

10 月 29 日拉取时 `origin/main` 为 `cdec8ae`（v1.1.2），本地 main 已包含用户的后续修改，到 `315de6b`。最终对照另构建干净的 `315de6b` 与同 HEAD 加本修复，避免将恢复快照及粗体输入的同期修改混算为本修复收益。较早 `a9b3c41 + CSS 修复` 候选保留其自身名称和输入指纹，不冒称最终 main。

```powershell
node scripts/memory-release-build.mjs --ref=v1.1.1 --label=p01-v111 --full-ref
node scripts/memory-release-build.mjs --ref=v1.1.2 --label=p01-v112 --full-ref
node scripts/p01-memory-investigation.mjs --label=p01-v111 --mode=isolated --rounds=3
node scripts/p01-memory-investigation.mjs --label=p01-v112 --mode=isolated --rounds=3
```

上述原始 Playwright 测量保留为探针对照；自然内存验收使用相同命令加 `--raw-cdp`。此传输只启用 Page/Runtime/Performance，不启用 Network/Debugger，发送次数随每个进程记录。后文单列开启 Network 的诊断实验，不把减少检查器成本当作产品修复效果。

在持有本报告本地提交对象及修复文件的 main 工作区，可用新标签重现，避免覆盖已留存构建。以下命令串行执行，最终两行分别测同 HEAD 的原始源和修复源；历史完整版本把 ref 换成 v1.1.1/v1.1.2、标签分别命名即可：

```powershell
node scripts/memory-release-build.mjs --ref=315de6b --label=repro-main-before --full-ref
node scripts/memory-release-build.mjs --label=repro-main-after
node scripts/p01-memory-investigation.mjs --label=repro-main-before --mode=isolated --rounds=3 --raw-cdp
node scripts/p01-memory-investigation.mjs --label=repro-main-after --mode=isolated --rounds=3 --raw-cdp
```

单独诊断用 `--mode=profile --rounds=1 --scenes=mixed240 --raw-cdp --native-sampling`；单独精确大文本用 `--mode=isolated --rounds=3 --scenes=text-exact2mib --raw-cdp`。本机 Node 为 22.2.0，最小传输使用 Node 内置 WebSocket。报告汇总/绘图脚本按本轮标签清单读取完整数据，不从单次截图或零散失败点生成中位数。

独立负载每个场景、每轮均启动新原生进程，使用新的 WebView2 UDF；应用 Profile 在仅属于本测试标签的目录中换新，旧 Profile 保留为备份。场景内部不主动 GC、不发送压力通知、不重建 WebView。冷点在观察到启动就绪后自然等待两秒；打开后等待目标编辑器、图片或 PDF Canvas 就绪及两帧，再等待一秒采样。关闭后记录实际时间戳与计划等待点。长循环关闭后的自然曲线覆盖 0/1/5/15/30/60 秒，其他独立文件覆盖 0/1/5 秒。新进程基线由每个后续独立场景重新验证。

所有点采集完毕后，工具只终止本次拥有的隔离进程树，再启动下一个独立场景。此清场不参与回收曲线，记录的 `expectedTermination=true`/退出码 1 是 Windows taskkill 的预期结果，不当作自然崩溃，也不当作生产重启优化。固定顺序累计负载只在整轮结束后终止。

这里的“冷”是新进程与新 Profile，不表示重启 Windows 或清空系统文件缓存。窗口实际内容区固定 1200×780，DPR=1，屏幕 2560×1440。当前 WebView2 为 `156.0.4314.50`，与旧报告的 `155.0.4283.62` 不同；旧表不能与新表拼成版本 A/B。版本对照、编译和回归串行执行，不重叠运行两个测量程序。

固定顺序的连续负载另起三轮新进程/Profile，顺序为普通 Markdown、200 代码块、60 次分栏合并、大图独立查看、大图 Markdown、PDF、Split、240 次混合循环、旧大文本夹具。每一步关闭文档并自然采样，期间不主动 GC，保留累计高水位。顺序可直接复现：

```powershell
node scripts/p01-memory-investigation.mjs --label=p01-v112 --mode=sequence --rounds=3 --scenes=ordinary,code200,panes,image,markdown-image,pdf,split,mixed240,text2mb --raw-cdp
```

单一文档循环每次完整打开普通 Markdown Live，等待挂载后关闭。混合循环沿用旧压力脚本的操作：打开 50 代码块，再打开两张本地图的图文，切回代码文档，同一任务中请求 Source/Live 切换，再切回图文并关闭全部文档。它测试快速模式请求和销毁竞态，不将其中每个中间模式都称为完成可见绘制；完整模式挂载、编辑和 Undo/Redo 另由功能回归验证。每 15 次保留原始点，包含要求的 30/60/120/240 点。

旧名 `large-2mb.txt` 实际为 **3,376,894 字节，约 3.22 MiB**。保留它复核旧报告；另提供 `text-exact2mib` 场景，使用精确 2,097,152 字节的固定 ASCII 文本。大图是 6000×4000，编码 PNG 实际 72,026,043 字节；不能把其成本只按像素或压缩小图估算。所有夹具的字节数和 SHA-256 随原始数据保存。

## 口径与证据边界

`p01-process-tree.ps1` 从本次 Rust 根 PID 出发，按 ParentProcessId 和创建时间闭包枚举，仅统计该树的 Rust 与 msedgewebview2。依据命令行的 `--type` 分类 Browser、Renderer、GPU、Utility、Crashpad，并保留 Utility 子类型、PID、父 PID、创建时间、Private、Working Set、CPU 和句柄数。不会全局合计其他应用的 WebView2。

另按 PID+创建时间核对进程连续性。旧 Playwright 记录有两个采样点短暂出现第二个 GPU 进程，父进程均为本次 Browser，原 GPU PID 仍在，后一采样点新增 PID 已不在；不能把“见过两个 PID”直接解释为重启或崩溃。这两个进程都计入当时的合计，具体新增用途未确认；逐点添加/移除及原始 GPU 是否持续存在另存于 JSON 的 `processAudit`。

Private 为 .NET `Process.PrivateMemorySize64`；Working Set 为 `WorkingSet64`。二者分列，进程 Working Set 合计可能重复共享页面，不能称为唯一物理占用。Windows 任务管理器截图中的“内存”既未同时提供列定义，也与 Private Bytes 不同；189.7 MB、226.7 MB 不用于计算本报告版本差值。MiB 统一为 1,048,576 字节。

JS Heap、全部 DOM/监听器计数、连接态 DOM/图片/Canvas、CM/PM 创建和活动数、Worker、Blob、Observer 及 DocumentManager 容器分别记录。计数探针使用弱容器，活动计数归零只证明显式销毁路径执行，**不能证明被销毁对象已不可达**。JS 与原生采样存在驱动/CIM 延迟，原始时间戳均保留；离散采样不保证捕获瞬时峰值。

原始 JSON 的 `passed` 表示操作、资源关闭等待及运行时错误检查完成，不表示 Private 已满足某个阈值，也不表示 240 次已经证明平台期。后文根据真实曲线另作性能验收判断，没有通过调整内存预期阈值来获得“通过”。

侵入式诊断使用独立 `--mode=profile` 进程：CDP 堆快照、弱引用见证、JS 分配采样和 Chromium MemoryInfra，依次记录自然等待、诊断 GC、诊断压力通知。不会把这些结果并入自然验收中位数，也没有在生产代码加入 GC、压力通知或 WebView 重启。

[Chromium MemoryInfra](https://chromium.googlesource.com/chromium/src/+/main/docs/memory-infra/README.md) 可提供 V8、Blink、PartitionAlloc、Skia、字体、图像及 GPU 等子系统信息；子系统 `size` 可能重叠，不能直接相加当作进程 Private。CDP 的[压力通知与分配接口定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)用于诊断可回收性；它不是生产优化方案。

## 确认的对象滞留与最小修复

已取得的修复前 Release 堆快照显示：关闭 240 次混合循环、活动编辑器/Worker/文档容器均归零并诊断 GC 后，仍有一份 Live Controller、一份 PM View、一份 SourceBridge 及 37 个 SourceBlock 可达。共有 263 个标记为 detached 的原生 DOM 节点；冷快照为 2。对象数量不等于其保留大小，不能把这份编辑器解释成全部数百 MiB 原生增长。结构统计排除了属性值为 `system / Hole` 的 V8 对象字面量模板；它们不持有文档数据。

三条 CSS 实际保留链分别为：

1. Document/StyleEngine → `MarkdownEditorController-*.css` 的 `<link>` → 注册的 load/error 回调 → Vite preload 的共享词法上下文 → `showActive()` 的 Pane 宿主/文档状态。
2. Document → `katex-*.css` 的 `<link>` → 回调 → 公式队列及渲染调用的共享词法上下文 → 已销毁的 Live Controller/PM/SourceBridge/DOM。
3. Document/head → `ImageViewer-*.css` / `PdfViewer-*.css` 的链接回调 → `EditorPane.setup()` 内创建的异步组件加载函数 → Pane 实例/VNode/响应式上下文。修复前独立图片/PDF 的 detached 节点为 68/178，Vue Effect/Computed 结构计数为 187/234，冷基线为 2/166。

本地 Vite 6.4.4 的 preload helper 在 CSS 链接上注册 load/error 监听，没有在完成时移除这两个监听；链接常驻 `document.head`。导入函数定义于带文档状态的调用内时，其上下文会通过这条链保留。此问题在 Vite 开发服务器中不使用同一 preload helper，故仅做开发服务器生命周期计数会漏检。

修复把 Live 编辑器导入函数放在 `DocumentManager.ts` 的模块作用域，把 KaTeX/CSS 和 Mermaid/DOMPurify 的导入放在 `renderers.ts` 的模块作用域；图片/PDF 异步组件定义移入 `asyncViewers.ts`，各 Pane 仍各自创建组件实例和视图状态。导入仍按需执行，任务的 AbortSignal、代际、可见性检查和错误路径保留；模块加载回调不再捕获某次文档/渲染任务。未清空历史、草稿、源码缓存预算或恢复快照，未改变 Live/Split/PDF/图片功能和 Markdown 无损流程。

新增 `tests/lifecycle/native-retention.mjs` 在实际生产打包的 Release 中验证普通 Live、公式图片、Split、PDF、独立大图关闭后，Controller、Bridge、规范文档记录、主 CM 和媒体宿主的弱引用在诊断 GC 后均失效；此项加入 Windows Release regression，补足 destroy 计数不能发现的所有权问题。

另确认 DOMPurify 的 `removed` 数组保留最后一次净化时移除的真实节点/属性。在只修复 CSS 链的候选中，Split 关闭后编辑器均已回收，但仍有 100 个 detached 原生节点：其中 44 个代码复制按钮、4 个图表容器及属性等。强路径经模块的私有 purifier → `removed` → `{from: node}`，而非编辑器历史。这是“最后一次输入”的保留，不是已证明每次循环累计一份的泄漏；它的大小随最后输入变化。

新增 `html/sanitize.ts`，所有应用侧 DOMPurify 调用在 `finally` 清空未使用的诊断数组，保持同一个净化调用、配置、Hook 和返回字符串。覆盖 HTML 预览、图表、剪贴板和大纲；不放宽任何净化规则，也不把诊断数组作为安全决策。所有权回归对比原净化输出和安全过滤结果；原生 Release 回归额外检查关闭快照中不再存在被保留的复制按钮/图表节点。新修复与较早 CSS 候选分开标记，最终二进制另建。

早期 Split 快照还发现测试代码 `waitForFunction(() => queryA && queryCM)` 将 DOM 返回为未释放的 JSHandle，根位于 DevTools console。谓词已改为布尔值，弱引用回归重新运行。该测试持有的一份 CM 不归因为应用泄漏；其旧快照保留并注明，不能据此宣称修复了 CM 实例泄漏。

## JS 恢复而 Private 不恢复：原生证据

轻量 CDP 的 v1.1.2 独立诊断进程，混合 240 次关闭后自然等待 60 秒，Renderer Private 为 130.77 MiB，JS Heap Used 15.53 MiB、Capacity 18.25 MiB，外部 backing storage 2.61 MiB。GC 后 Renderer 131.49 MiB、Heap Used 15.30 MiB。仍约 500 MiB 的 GPU Private 不属于 JS 堆；继续清空源码对象无法解释或释放它。

MemoryInfra 的同进程时间相关点显示：自然等待后的 Renderer，V8 size 18.67 MiB、Blink GC size 33.48 MiB、Blink 实际对象约 3.37 MiB、PartitionAlloc buffer committed 11.20 MiB、malloc size 41.50 MiB、web cache 5.46 MiB。它们包含重叠与不同分配口径，**不能把这些数相加当作完整 Private 分账**。Blink GC 的已分配页面远高于实际对象，是已释放对象与分配器页面保留的证据之一；未被 MemoryInfra 完整分账的差额仍保留为无法归因，不能一概称为正常缓存。

GPU 在自然等待 60 秒仍为 501.47 MiB；诊断 GC 后 502.30 MiB。MemoryInfra 的 Skia GPU resources size 为 251.52 MiB，压力通知后降为 0.047 MiB；GPU Private 随之降至约 72.6 MiB。另一次 Playwright 诊断的 Skia 数值不同，说明缓存高水位随时序和负载变动。此实验确认很大一部分是可回收的原生渲染资源，同时不能把约 430 MiB 的 Private 差值全归给 Skia，剩余驱动/分配器提交量未取得函数级分账。

Skia/GPU 资源计数还可能描述显存或共享图形资源，不是 GPU 进程 Private Bytes 的直接子集。这里用同进程、同时间线的压力响应确认可回收性，不将图形资源 size 当作 Windows 私有提交量的等额组成。

作为实现背景，Chromium 当前的 [Skia 限额计算](https://raw.githubusercontent.com/chromium/chromium/main/gpu/config/skia_limits.cc) 按设备内存选择 Ganesh 资源缓存预算；[共享图形上下文](https://raw.githubusercontent.com/chromium/chromium/main/gpu/command_buffer/service/shared_context_state.cc) 再设置该预算，另有 transfer cache。这支持“文档关闭不等于运行时缓存清空”的解释。但它不是本机 WebView2 的匹配符号/源构建，不能由源码默认预算反推本机 Private 上限，或替代 240 次实际曲线的平台期判定。

堆快照本身有显著成本：同一轻量进程在闭合 GC 点 Renderer 为 131.49 MiB，取快照后为 446.19 MiB，JS Heap 几乎不变；MemoryInfra malloc size 同时从 41.13 升至 355.21 MiB。已增加快照后、读取分配采样后两个点，避免把诊断器分配误当成文档泄漏，或误称为压力通知无法回收的产品常驻内存。

### 检查器响应体缓存

本机 Playwright 1.64.1 的 Chromium NetworkManager 默认发送不带参数的 `Network.enable`，已核对安装包的 `lib/coreBundle.js:37391`。早期原生采样中，有 125 条大分配样本分别精确匹配两张图的 Base64 字节数加 12 字节（1,921,484 / 1,229,916）；它们不是按 RGBA 像素尺寸归因的证据，采样记录数也不等于全部实际分配次数。与之同时，Renderer PartitionAlloc buffer 在 Playwright 诊断 GC 点约 208 MiB，轻量 CDP 对照约 11 MiB；同二进制自然 240 次总 Private 也显著下降。Chromium [NetworkResourcesData](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/third_party/blink/renderer/core/inspector/network_resources_data.cc) 的实现会把资源正文转为字符串并保留到驱逐/清理，支持检查器响应体缓存这一归因；具体 WebView2 构建没有匹配符号，不用当前 Chromium 默认预算冒充本机实测预算。

独立的 `--raw-cdp --network-cache-control --native-sampling --mode=profile --scenes=mixed240 --rounds=1` 已完成：同一 CDP 会话开启 Network，负载关闭、自然等待及两次诊断 GC 后，Renderer PID 45708 的 Private 为 362.95 MiB；关闭 Network 并再次诊断 GC 后为 142.87 MiB。Heap Used 仅从 15.326 到 15.314 MiB，backing storage 均为 2.598 MiB，GPU PID 35636 仍约 365.9 MiB，没有靠更换进程取得下降。

同阶段 MemoryInfra 中，Renderer buffer 的 allocated objects 从 **198.01 降至 7.55 MiB**，committed 从 205.38 降至 13.91 MiB；Blink GC size 从 63.73 降至 34.98 MiB。约 220 MiB 的 Private 变化是检查器相关 native 保留及其清理的合计，不能全当作 Base64 正文大小，也不能记为应用修复收益。两次操作前后都已诊断 GC，结合原生样本大小、NetworkResourcesData 的实现及域开关，对响应体保留有直接受控证据。所有自然验收保持 Network 关闭。

该控制还揭示了原生归因的剩余缺口：GPU 的 Skia resources 在关闭 Network 前已仅约 0.047 MiB，但 GPU Private 仍约 365.9 MiB；后续压力通知使同 PID Private 降至约 74.0 MiB。这里约 292 MiB 的可回收量不能再称为 Skia resource size，它仍属于未取得完整函数级分账的原生/驱动/分配器高水位。不能用另一次追踪的 Skia 数字覆盖这个差异。

公开符号服务器能够返回匹配 msedge PDB 的元数据，但约 654 MiB 的符号文件传输及小范围重试超时，未取得可用符号；因此没有宣称 ETW 或函数级原生堆归因已经完成。本轮以 CDP 原生分配采样、MemoryInfra、堆强路径和受控实验报告已能确认的分配族，未解决的原生部分明确留下。

原始快照/追踪位于忽略的 `test-results/p01/`，[紧凑诊断证据](p01-memory-diagnostics-20261028.json) 保存文件 SHA、保留路径、结构计数、分进程点和分配族。旧追踪经 Perfetto 导出后事件 ID 会重新编号，不与 CDP dumpGuid 硬匹配；新追踪用 Performance.Timestamp 对齐，旧追踪用多点时间间隔相关并记录最大残差。未捕获到的 cold dump 明确列出，不能补造冷点分配族数据。

### 分类结论

| 类别 | 本轮证据与边界 |
| --- | --- |
| 确认的应用对象滞留 | 三条 CSS preload 所有权链、DOMPurify 最后一次 removed 诊断节点；已直接修复。现有证据是首实例/最后输入保留，不冒称每轮累计一整份编辑器，也不拿它们解释全部数百 MiB |
| 预期常驻 | 主工作区的 Tauri/WebView、Shell 订阅、已加载的模块/Schema/语法定义、CSS 与字体；最后标签关闭并不销毁它们 |
| 对象释放但分配器未全部归还 | 诊断例中 Blink GC 页面与实际对象量相差明显；PartitionAlloc buffer committed 11.20 MiB、对象 7.57 MiB，其中 decommittable 1.43 MiB；malloc size 41.50 MiB、对象约 27.60 MiB。这不是说全部差额都能立刻归还 OS，分配族还可能重叠 |
| 图片、字体与 GPU 缓存 | Blob 引用/Canvas/Worker 关闭为零，仍可存在图像与 GPU 资源缓存；Skia/GPU 的压力响应提供直接可回收性证据。字体资源/字形缓存另有记录，不与图像/Private 合并成一个未验证总数 |
| 检查器自身保留 | Network 响应正文、未释放 DOM JSHandle 和堆快照的 native 分配分别对照；不能计为产品修复收益或应用泄漏 |
| 无法完整归因 | 全部 Private 与已知分配族之间的差额、驱动内部提交量，以及瞬时额外 GPU 进程的具体用途。未取得符号，不补造函数级归因；240 次之后是否仍有迟到增长需按实际曲线和后续更长负载判断 |

因此，“编辑器和 Worker 数量归零、JS Heap 已回落”只回答了一部分资源的生命周期。要解释整体 Private，必须同时看真实强引用、引擎页面/模块和原生图形缓存，并排除检查器自己制造的保留。

## 分资源生命周期审查

两个正式版本的独立三轮各有 222 个关闭态/循环关闭态点。所有这些点的文档 records、活动主 CM/嵌入 CM/PM、Worker、Blob URL、Canvas 像素和 IO 目标均为 0。与此同时，监听器最高仍约一万；自然等待和堆快照表明，显式销毁、等待 GC 的节点、真正仍可达的节点必须分开计算。

| 资源 | 所有者和释放位置 | 本轮判别依据 |
| --- | --- | --- |
| CodeMirror / ProseMirror | `DocumentManager.destroyView()`；`MarkdownEditorController.destroy()`；`CodeBlockView.destroy()` | 活动计数与实际堆对象交叉检查；已销毁但被 CSS 回调保留的 PM 不能称为已回收 |
| SourceBridge / 源码 | Controller 的 bridge；规范 EditorState、保存基线及历史属于 records | 关闭移除 records；桥接没有按文件持有的全局无限缓存；确认的首文档保留链另行修复，不通过清空历史掩盖 |
| Markdown 解析 | `MarkdownParser.ts` 的 referenceDefinitions 使用 WeakMap | environment 作为弱键；模块 Schema、tokenizer 和已加载语法定义常驻，与逐文档泄漏区分 |
| Vue 响应式订阅 | `useDocumentOutline.ts`、`EditorPane.vue` 及 Shell 的生命周期监听 | 检查订阅解除和卸载；root Shell 订阅是预期常驻；CSS 捕获的 Pane/Controller 可能间接保留响应式对象，须用堆验证 |
| EventListener / Observer | `renderVisibility.ts` 按 Document/root/margin 合并；disposer 移除目标与最后组 | IO 目标关闭归零；DOM 监听器等待 GC 与常驻 CSS 监听器分别分析，不能拿累计创建数当存活数 |
| Worker | PDF Viewer、转换 Worker 的创建/terminate 路径 | 探针 live 与诊断进程的 CDP Worker targets 交叉核查；不把 Worker 模块代码缓存当 Worker 实例 |
| 图片 / Blob / Canvas | `images.ts` 共享 Blob 引用池；`ImageViewer.vue`；`ImagePreview.ts` | 关闭撤销 URL、断开图片 src，池按文档回收；连接态图片像素与原生图像缓存不是同一指标；大图另看外部 backing storage |
| PDF.js | `PdfViewer.vue` teardown；`PdfPage.vue` 卸载 | LoadingTask 有界等待销毁，Worker 最终 terminate，Canvas 清零，TextLayer.cleanup；64 MiB Canvas 预算不代表整个 PDF 进程内存上限 |
| Tauri WebView / 原生窗口 | `useAppShell.ts` 的关闭握手、`EmptyDetachedWindow.ts`、Rust `WindowEvent::Destroyed` | 最后文档关闭时主 WebView 仍显示工作区，不会销毁 Browser/Renderer；真正窗口销毁时原生清理 owner 的文件、搜索、转换、移交和会话资源 |
| Blink / V8 / 系统与 GPU 分配器 | 非 JS 资源、已提交但未回收页面、模块代码与图像/字体/渲染缓存 | 继续以 MemoryInfra 和压力响应分解；不能仅由 Heap Used 下降推断原生保留全部合理或全部泄漏 |

## 修改范围

| 文件 | 原因 |
| --- | --- |
| `src/editor/core/DocumentManager.ts:38,775` | 将 Live 动态导入移到模块作用域，避免 CSS preload 回调捕获首次打开的记录和 Pane |
| `src/editor/markdown/wysiwyg/renderers.ts:10,223,305` | 隔离公式/图表导入闭包，保留原队列、取消、缓存上限与懒加载 |
| `src/components/viewers/asyncViewers.ts:5`、`src/components/layout/EditorPane.vue:16` | 共享异步组件定义，隔断首个媒体 Pane 的 setup 上下文保留；实例仍逐 Pane 创建 |
| `src/editor/markdown/html/sanitize.ts:5`、`src/editor/markdown/html/SafeHtmlRenderer.ts:155`、`src/editor/markdown/wysiwyg/LiveClipboard.ts:161`、`src/editor/outline/outlineService.ts:23`、上述 renderers:239 | 使用原净化逻辑，结束后释放 DOMPurify.removed 中的诊断节点 |
| `tests/lifecycle/ownership.mjs`、`tests/lossless/api.ts` | 新增净化输出/安全过滤与诊断所有权断言 |
| `tests/lifecycle/native-retention.mjs`、`tests/run-suite.mjs` | 原生 Release 的弱引用及 detached 预览节点回归进入 Windows regression |
| `scripts/memory-release-build.mjs` | 支持完整历史归档构建、校验 main、正确解引用 tag、构建前后输入一致性和二进制溯源 |
| `scripts/p01-*` | 隔离进程/Profile 测量、最小 CDP、分进程采样、堆/MemoryInfra 分析、三轮校验、汇总与绘图；全部属于诊断/验收工具 |

本次未改依赖版本、应用版本号或生产内存策略。没有生产定时 GC、压力通知、重启 WebView、清空 Undo/Redo 或恢复数据，也没有停用预览功能。`scripts/p01-*` 的追踪/强制回收仅在用户明确启动的隔离诊断进程中执行。

## 本轮仍未解决的原生边界

- 主窗口在最后一个文档关闭后仍承载交互工作区，WebView、模块、样式、字体和引擎线程不随标签销毁。不能承诺它立即回到新进程基线，也不能把这些常驻项当成逐文件泄漏。
- 原生渲染缓存的可回收性已由诊断压力响应验证，但自然等待 60 秒没有使 GPU Private 全部回落。没有取得 WebView2/驱动的完整匹配符号，因此尚不能给出所有 Private 的函数级分账，未归因差额没有被填成“正常缓存”。
- WebView2 并非没有内存管理 API。[MemoryUsageTargetLevel](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.memoryusagetargetlevel?view=webview2-dotnet-1.0.4191.47) 是 best-effort 的目标，可让非活动 WebView 继续运行脚本，但可能换出页面，恢复活动时需显式设回 Normal。它不保证 Private 的固定上限；本轮未验证其 Private、恢复延迟和前台交互收益，所以没有接入产品，也没有用 Working Set 下降替代 Private 优化。
- 240 次是本次规定的观察窗口。若末段仍增长，必须保留曲线并标记未证明平台；即使某个场景的末段趋稳，也不外推到无限时间或所有文件组合。更长循环、不同图像集合和匹配符号的 GPU/原生分配追踪仍是后续验证范围。
- 结果仅覆盖这台 Windows 11 x64、RTX 4060 Ti/指定驱动、DPR 1 与 WebView2 156 环境。最小 CDP 仍是检查器，不是零成本；不同 GPU、高 DPI、内存压力和其他平台需另测。没有把旧 Runtime 155 的数据与新 Runtime 156 拼接为优化百分比。

## 待完整验收后填写

- 三轮版本对照、中位数和范围。
- 各子进程变化、原生分配与缓存归因。
- 优化前后同环境对照及 240 次平台期判断。
- 无损保存、Undo/Redo、冲突和生命周期回归结果。
- 最终结论与仍未解决的原生限制。

首次探针预试验启用了过多追踪事件，序列化超过 Node 字符串上限而中断。其堆快照可以用于保留链分析，追踪污染后的进程数字不作验收数据。正式诊断已限制为 MemoryInfra 事件和有界追踪缓冲，需以成功完成的后续记录复核。

另有一次轻量 CDP 三轮控制在第二轮结束附近断连，未取得确定的退出原因，整份不完整报告不纳入三轮中位数；10 月 29 日以新增退出/socket 诊断重新完整跑三轮。早期不兼容旧版设置 schema 的启动失败、修复期间源输入发生变化而被构建断言拒绝的候选，也未参与验收。失败 JSON、旧二进制构建日志和重跑记录保留在 test-results，汇总器拒收 incomplete/failed/profiling 数据，绝不补造缺失轮次。

最终构建的首次独立矩阵又在第四个新进程等待 CDP 接口时超时；45 秒后 Rust、Browser、Renderer、GPU 仍在运行，未取得应用崩溃证据。该不完整轮次排除，保留进程树；探针改用每进程独立调试端口，避免重复绑定同一端口和旧 HTTP 连接的影响，并补充启动阶段 stderr/退出记录。重跑复用同一已校验 SHA 的产品二进制，不通过重启正在采样的场景或放宽内存阈值通过测试。
