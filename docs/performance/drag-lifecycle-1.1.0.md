# 拖放与窗口生命周期验收（1.1.0）

日期：2026-10-27。仅在 main 修改。发布由用户明确授权，版本为 1.1.0。

## 根因与修复

- 文件树使用 HTML5 拖放，标签使用 PointerEvent，落点、取消和组件销毁各有不同监听。现统一由 TabDragService 持有元数据载荷、捕获、目标和 rAF；失效目标与异步读取通过工作区控制器取消，避免空分栏和误开文件。
- Windows 丢失 DOM 捕获后可能收不到窗口外释放。按需启用物理按键释放观察，只在确认实际释放后移交；取消、最小化和切换到其他应用不创建窗口。没有为浮标新增 WebView。
- 原浮标坐标被限制在视口内，产生边框吸附。移除坐标钳制，离开窗口/失去捕获时隐藏 DOM 浮标，返回时恢复。浮标本身不会跨原生窗口绘制。
- Tauri 的全局事件分发使接收窗口的事件也进入源窗口，回拖时误关闭刚接收的文档。改为 emit_to 与当前窗口监听，按 handoffId 精确接收、提交或回滚。
- 旧移交未完整覆盖媒体、换行、保存授权和确认丢失。现传递原始保存快照及媒体元数据，源文档暂时锁定，接收确认后才关闭源引用；失败回滚文件授权。已提交但成功响应丢失时保留目标正文。
- 同 Pane 排序曾两次重置 CodeMirror 状态，100 次排序创建 200 次插件。排序现在仅调整标签位置；同文档复用视图。分栏共享单一规范 EditorState/Text，分别持有光标、滚动和必要视图。
- A–N 模式切换复验发现旧视图的延迟焦点事务可能进入同 Pane 的新视图，触发 transaction startState 异常。新增视图归属检查；销毁旧视图后再派发事务的回归在修复前稳定复现、修复后通过。
- 关闭窗口先卸载 Vue、编辑器、Worker 和预览资源，再销毁原生窗口；清理 rAF、布局订阅、拖动监听、查询和文件授权。搜索连接延迟至首次真实查询，窗口销毁按 owner 取消查询。

## 功能验收

浏览器拖放专项 10/10：文件中心、四边、重复打开、未保存共享编辑、独立光标、Undo/Redo、100 次排序、跨 Pane 移动/复制、无效目标、读取失败/目标销毁、Escape、旧视图事务隔离、浮标边界、50 次分合与组件卸载。

Windows WebView2 原生专项 8/8：未保存正文、模式/编码/光标/滚动、独占文件授权、回拖关闭空窗口、图片、PDF 及 Worker 释放、接收冲突回滚、提交成功响应丢失、脏窗口取消/保存关闭、磁盘字节重开、CRLF。

用户实际手测确认“拖出去和拖回来是对的”；故障注入时原生释放通知 2 次，捕获丢失且 DOM pointerup 被抑制后仍完成移交，结束后拖动状态 false、浮标 0。随后修正边界吸附并由浏览器专项覆盖。

## 原生内存测量

真实 Windows Release + WebView2，同一计数探针；每点操作后自然等待约 1 秒；不强制 GC，不刷新页面。单位 MiB。表内依次为 Rust Private / WebView2 Private 合计 / 页面 JS Heap 合计。Private 不是实际物理驻留量，Working Set 合计可能重复计算共享页，不能作为独占总内存。

基线提交 bc819959ebe65a5426d07c41ac442729b3c9f30b，二进制 SHA-256 8fd163e8717b57bec86f8fec8aca9e3e7f6275f920499326c6147ae161ca1256。

修复量测基于 9629b60146ef8b1ee1fbf0a438ccb377d8ddaa75 的待提交修改，二进制 SHA-256 036dd244e251145defe0100462131362fcd6be33c2930c9fa66eebae457f6034。期间 main 另合入工作区修复 9629b60，因此整体差值不能全部归因于本改动。该探针构建包含当时本地大纲改动；正式发布提交排除这些改动，量测关闭了大纲。原始日志与 before/after/cleaned 采样保留在本地 test-results/drag（忽略目录）。

| 场景 | 修复前 Rust / WV / Heap | 修复后 Rust / WV / Heap | 修复后窗口数 |
|---|---:|---:|---:|
| A blank startup | 6.21 / 187.58 / 6.38 | 6.73 / 189.75 / 6.39 | 1 |
| B open 100 KiB Markdown Live | 6.66 / 221.88 / 10.77 | 6.81 / 273.35 / 11.37 | 1 |
| C same document in two panes | 6.67 / 235.77 / 13.31 | 6.81 / 342.85 / 13.91 | 1 |
| D reorder tabs 100 times | 6.66 / 325.41 / 11.56 | 6.82 / 300.18 / 10.51 | 1 |
| E split and merge 50 times | 6.68 / 333.67 / 24.85 | 6.77 / 321.03 / 18.00 | 1 |
| F workspace open 50 dropped files | 6.80 / 388.71 / 40.65 | 6.88 / 354.19 / 22.11 | 1 |
| G create one detached window | 7.23 / 481.21 / 31.45 | 7.82 / 444.24 / 38.90 | 2 |
| H return document and close detached window | 8.85 / 411.59 / 32.66 | 8.12 / 381.33 / 19.31 | 1 |
| I detach and return 60 times | 未测量 | 13.01 / 409.05 / 29.94 | 1 |
| J open/close search and settings 20 times | 7.00 / 358.01 / 16.49 | 13.02 / 504.57 / 23.11 | 1 |
| K Markdown code, local image, formula and diagram | 7.07 / 357.95 / 19.05 | 14.77 / 483.62 / 40.02 | 1 |

修复后将 I 扩展到 60 轮以检查长期趋势；其余操作次数保持一致。基线 H 存在正文被错误关闭的问题；I 因前置文档已丢失未执行，不能把空窗口采样当成完成 20 轮。后续 J/K 前置状态也与修复后不同，不能直接计算优化百分比。

修复后连续移交的自然采样：

| 轮数 | Rust Private | WV Private | JS Heap | DOM 节点 | JS 监听器 |
|---|---:|---:|---:|---:|---:|
| 5 | 8.64 | 378.28 | 27.84 | 5041 | 892 |
| 10 | 10.32 | 384.41 | 15.36 | 3661 | 619 |
| 15 | 9.68 | 391.13 | 19.87 | 3661 | 619 |
| 20 | 10.23 | 395.15 | 28.41 | 5041 | 892 |
| 25 | 9.56 | 395.48 | 33.20 | 5041 | 892 |
| 30 | 11.15 | 395.77 | 20.21 | 3661 | 619 |
| 35 | 11.22 | 399.65 | 28.56 | 5041 | 892 |
| 40 | 11.54 | 408.45 | 32.80 | 5041 | 892 |
| 45 | 12.25 | 410.93 | 40.50 | 5264 | 1002 |
| 50 | 12.46 | 412.20 | 16.54 | 3661 | 619 |
| 55 | 12.25 | 413.06 | 20.71 | 3661 | 619 |
| 60 | 13.01 | 420.12 | 29.89 | 5041 | 892 |

每个采样点均为 1 个窗口、1 个 Pane、1 份规范文档、1 个主 CM、0 个浮标、7 个进程（含 6 个 WebView2 子进程）。JS Heap、DOM、监听器没有随轮数单调累积；进程私有内存仍有上升，不能宣称整体内存下降或严格平台期，更不能据此证明不存在任何泄漏。浏览器分配器缓存及长期窗口循环需要更长时间的独立分析。

明确验证的优化是：100 次排序新增主 CM 插件由 200 次降至 0 次，编辑器 DOM 与状态保持；分栏合并后视图数回落为 1；真实脏窗口关闭时 CM/PM/records/Blob 全为 0；PDF 关闭时 Worker 为 0。既有 200 个静止代码块仍要求嵌入 CM 为 0，由 A–N 验收验证。

## 执行命令与结果

- pnpm check（含 typecheck 和 build）：通过。构建仍有既有大块体积及 Pandoc 外部模块提示。
- pnpm test：28 项交互通过。
- pnpm test:regression：12/12 浏览器套件通过；Windows A–N 另以同一最终探针二进制执行。
- cargo check --manifest-path src-tauri/Cargo.toml：通过。
- cargo test --manifest-path src-tauri/Cargo.toml：28/28 通过。
- 排除本地大纲改动的发布源码快照：pnpm check、pnpm test（28 项）、大纲 24 场景（10/10 组）全部通过。
- node tests/phase042/acceptance-a-to-n.mjs --label=dnd-after：修复视图归属问题后 14/14 通过，页面/控制台错误 0；200 个静止代码块嵌入 CM 为 0。
- node tests/search/native.mjs --label=dnd-after：Windows 原生全局搜索 13/13 通过。
- node tests/drag/browser.mjs：10/10 通过。
- node tests/drag/native-memory.mjs --label=dnd-after --rounds=60 --foreground：11/11 场景完成，包含 60 轮拖出/回拖。
- node tests/drag/native-memory.mjs --label=dnd-after --functional --foreground：8/8 通过。

## 修改范围

前端：TabDragService、TreeNodeItem、TabBar、EditorPaneItem、DocumentManager、tabDetach、FileController、useAppShell、main。Rust：commands/tab_drag、commands/detach、detach、workspace/search、lib、commands/mod 与 Windows API features。新增拖放浏览器/原生功能/内存测试，接入现有回归入口；搜索原生测试允许指定构建标签。WorkspaceController 的延迟搜索和读取复用、workspace 命令的窗口定向事件已随并行工作区提交 9629b60 进入 main。

## 限制

macOS WKWebView、Linux WebKitGTK 未做本地 GUI 实测；对应打包成功不能替代交互验收。混合 DPI/负坐标覆盖坐标单元测试，未做真实多屏操作。Windows 物理释放补偿为平台实现，其他平台沿用 DOM 捕获路径。此报告不承诺进程私有内存下降或已排除长期缓存增长。
