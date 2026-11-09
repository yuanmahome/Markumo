# Markdown 大文件优化：阶段性实现与验收缺口

日期：2026-11-09。**整个任务及 P0 完整实时排版验收尚未通过，当前不能视为完成品。** 全部仓库改动位于 main，基线为远程同步后的 `bd792225b6e6b895b3b7658c42ec04dcd0062a52`（1.2.5）。未修改版本、创建分支/worktree、提交、推送或发布 Release。

## 瓶颈与已有原型

- 双栏原来在 EditorPane 中阻止大文件正文传入，并在 splitPreview 中以 1 Mi 字符关闭预览；未触发拦截时仍全文 Markdown-it 解析、生成 HTML、插入 DOM。可见性观察只延迟媒体，不能回收正文 DOM。
- 实时排版的 MarkdownSourceBridge、ProseMirror Document/View 仍覆盖全文。局部普通文本已有块级快路径，结构性变化仍可全文解析；本轮没有替换其源码保真和权威 CodeMirror 历史。
- Rust 文件服务还在打开和保存时拒绝超过 200,001 行的文本，导致初版原生 5/10 MiB 矩阵失败。已对 Markdown 路径取消这条行数限制。原有文件读取/保存 **16 MiB 容量限制仍未解决**，不能声称任意大小的 Markdown 已能打开。
- 已审查 P03 报告、WindowMap、SegmentedWindowEditor、SegmentedScrollRail 及 Rust text_document 原型。其 UTF-8/CRLF 映射、串行事务、组合输入保护可复用，但跨窗选择、完整编码/保存/工作区接入仍是门槛，未接入正式 Markdown。
- Windows 基线的合成 950,000 字符文档：实时排版切入单次约 6.54 s；之后定位/聚焦/输入阶段出现渲染器无响应，已中断并保留诊断记录。没有可报告的 Live 输入 P50/P95。本轮没有解决这个根因，不以取消大小判断代替优化。

## 实际实现

1. 移除双栏和 Live 的 1 Mi 字符能力拦截及源码降级提示；EditorPane 不再因为大小传入空正文。
2. `preview/structure.ts` 使用 Markdown-it 真实块规则识别完整边界，在 Worker 中分批发布坐标，及时释放临时块 token；首批完成即可显示，后续继续索引。Front Matter、脚注延续段落额外保护。结构索引不存正文副本；但 Worker 接收完整字符串快照，初始化行表仍为全文 O(n)，尚非原生流式 DocumentSource。
3. 初始分组预算 16,384 UTF-16 单位或 32 个完整块；预算只在完整结构结束时封组。单个超过 131,072 单位的结构显示局部提示与源码定位入口，不截断语法冒充完整结构。巨型代码/段落的完整有界查看与编辑尚未实现。
4. Fenwick 高度索引、ResizeObserver 实测高度、视口及缓冲分区、最多 12 个挂载分区、非驻留占位。轨道超过 8,000,000 px 时进行几何映射，避免浏览器像素上限让尾部不可达。未索引尾部保留几何占位，远处行定位在索引发布后继续处理。
5. `PreviewPartition.vue` 复用原媒体/代码/公式/图表渲染与清理流程。离窗卸载释放观察器、异步任务和图片句柄；全局链接定义在后台索引完成后补齐并重渲染驻留分区。源码坐标在图片操作时映射回全文并校验局部快照。已修复分区容器更名引起的放大按钮定位样式与图片边框选择器遗漏；媒体测试也改为验证虚拟化后的滚动容器，而非要求 35 个图表同时驻留 DOM。
6. 统计面板支持字数、Unicode 字素字符、去空白字符、汉字、英文词、行、非空行组、选区字/字符及按 300 字/分钟估算阅读时间。**目前全部是明确标注的源码统计，未实现可见正文统计。** 默认主项字数；五种主项持久化到原设置体系，不覆盖旧设置。
7. 统计按不可变 CodeMirror Text 叶节点 WeakMap 缓存；仅将缺失叶片送入单 Worker，串行计算，旧版本任务取消。结果过期时显示统计中；不永久保存统计专用全文字符串。选区变化会重新调度，有进一步合并任务的空间。

## Windows Release 测量口径

机器为 i5-12600KF、约 64 GiB RAM、Windows 11 Home China、WebView2 157.0.4341.42。使用独立配置和 WebView 数据目录，每个样本三个独立进程。基线为 Release EXE；优化版为实际 NSIS 安装后的 Release EXE。隔离安装包不注册生产文件关联、不使用生产配置。没有执行强制 GC、裁剪撤销历史或降低图片质量。隔离测试安装保留在 `test-results/markdown-large/installed-verified`；静默卸载未完成，已终止等待的测试命令，未操作生产应用。测量 EXE 副本也保留在该目录的上一级。

不是用户原始文件：950k 是生成的恰好 950,000 UTF-16 单位混合中文、英文、emoji、标题、列表、表格与代码的样本，UTF-8 为 1,245,969 字节，共 103,249 行；其他普通样本按真实 UTF-8 字节生成，包含 100/500 KiB、1/2/5/10 MiB。生成器记录 SHA-256，原生矩阵逐项核对规范正文 SHA-256。**这不是编辑后真实写盘 SHA 验收**；原有源码保真回归单独验证保存和 CRLF。

数据见 [原生表格](markdown-large-20261109/native-table.md)、[汇总 JSON](markdown-large-20261109/summary.json)、[原始基线](markdown-large-20261109/before.json.gz)、[安装版矩阵](markdown-large-20261109/after.json.gz)、[Live 无响应诊断](markdown-large-20261109/liveFailure.json.gz)。每格 P95 只有三次观测，采用 nearest-rank，实质为三次最大值，不代表稳定尾延迟估计。

- 首屏时间：调用切换双栏至预览首标题出现并经过两帧；不等待全文索引。首次资源渲染完成不包含在此数值中。
- 索引完成：后台结构索引发布 complete；不等于所有图片、公式、图表均已渲染。
- sourceDom 字段只测源码可编辑 DOM 出现，不包含实际键入成功，不能作为严格的首次可输入时间。
- Private 是 loaded/closed 时点的 Rust + WebView2 进程树快照，**不是峰值曲线**。JS Heap 单列；CDP DOMCounters 含未回收节点，不能与连接 DOM 混用。
- 关闭后 Worker 和编辑器存活计数归零、连接 DOM 约 156；Private/Heap 未立即回落，不能据此认定泄漏已消除。没有完成长期多轮增长/回收审计。
- readDecodeIPC 是磁盘、解码与 IPC 合计，尚未分别埋点。scrolling 是程序化滚动 rAF 间隔，不是人工滚动或真实系统输入法验收。

## 测试及未完成项

通过：TypeScript 检查；72 项 Rust 单元测试；Mermaid/统一媒体完整回归（含 25 类图表、安全策略、35 图表按需渲染、缓存预算、缩放交互及 20 次循环清理）；原有 28 项链接交互回归；源码保真回归（含 25 类语法语料、11 条输入路径、CRLF、撤销重做及模式往返）；新增结构边界/Fenwick/巨型结构局部提示、Unicode/统计面板/设置迁移、100k 至约 10.5m 字符浏览器分区导航回归；Windows 安装版普通样本双栏矩阵。

**仍未完成，不能进入“整体优化已完成”的验收状态：**

- Live 的渐进解析、局部 ProseMirror 投影、活动编辑保护、跨分区选择/删除/粘贴及真正大文件实时排版性能；目前 Live 仍是全文路径，存在严重卡顿/无响应风险。
- 稳定结构 ID、按修改范围修补索引、多 Pane 共享索引/解析缓存。当前预览内容变化会重建后台索引，不能声称每键只解析局部。
- 统一流式权威文档源、消除多 Pane 临时全文字符串、去除原生 16 MiB 打开/保存容量限制。
- 脚注、Front Matter、TOC 的完整预览语义及跨分区全局导航；保护结构边界不等于完整实现渲染语义。全局链接定义已补齐。
- 巨型单结构的完整查看/编辑，精确到块内位置的同步滚动及重排锚点全场景验证。
- 可见正文统计、统计面板文件切换/重启的原生完整验收。
- 大纲远距离跳转、搜索/替换、多文件多 Pane、导入导出、外部冲突、工作区恢复、真实中文 IME 和编辑后原生保存的完整矩阵。
- Mermaid/图片/表格密集压力文档的三轮原生性能、真实输入 P50/P95、内存增长曲线、当前 nomo 同条件原生对照。

## 参考与复现

已阅读 nomo `67f3d8d39f1da29282989cec21367d1bbc770474` 的 [viewport_model.rs](https://github.com/nomo-md/nomo/blob/67f3d8d39f1da29282989cec21367d1bbc770474/src-gpui/src/nomo_mark/viewport_model.rs)、[session_window.rs](https://github.com/nomo-md/nomo/blob/67f3d8d39f1da29282989cec21367d1bbc770474/src-gpui/src/nomo_mark/session_window.rs)、[parse.rs](https://github.com/nomo-md/nomo/blob/67f3d8d39f1da29282989cec21367d1bbc770474/src-gpui/src/nomo_mark/parse.rs)、[resident_budget.rs](https://github.com/nomo-md/nomo/blob/67f3d8d39f1da29282989cec21367d1bbc770474/src-gpui/src/nomo_mark/resident_budget.rs)。参考其结构边界、占位尾部、测量高度与驻留预算思路，未复制其实现；当前 GPUI 与先前 P03 的 Web 版不能混为一次性能对照。

```powershell
node scripts/markdown-large-fixtures.mjs
pnpm typecheck
node tests/markdown-large/structure-regression.mjs
node tests/markdown-large/stats-regression.mjs
node tests/markdown-large/regression.mjs
node tests/markdown-source-fidelity/regression.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib
node scripts/memory-release-build.mjs --label=md-verified --isolated-installer
# 安装隔离测试 NSIS 包后，将 INSTALLED_BINARY 指向其 markumo.exe
$env:SPLIT_ONLY='1'
node scripts/markdown-large-native.mjs md-verified 3 950k,100kb,500kb,1024kb,2048kb,5120kb,10240kb
node scripts/markdown-large-report.mjs
```

安装版 NSS 与未打包 EXE 的 UNK 标记有三个字节差异；测量脚本验证除该标记外完全一致，并分别记录 SHA-256。精确源文件 manifest 哈希、EXE 哈希、所有轮次与失败尝试均按报告记录，不用新代码冒充旧二进制实测结果。
