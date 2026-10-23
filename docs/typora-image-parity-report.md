# Typora 图片源码与错误占位验收报告

日期：2026-10-23。结论：正文内完整源码编辑、紧凑错误占位和自然尺寸缩放已实现；**整体 PARTIAL，不声明 1:1 全部通过**。磁盘文件操作菜单尚有缺项，原生 GUI 覆盖边界见下文。

参考：[行为研究](typora-image-behavior.md)、[真实菜单矩阵](typora-image-context-menu.md)、[此前 Typora 实机素材](images/typora-image-study/)。研究中的 PASS 表示观察成功，不代表 Markumo 实现通过。

## 实现与源文本事务

- 图片源码使用 ProseMirror 正文内 Widget，位于目标 image / image_source 节点之前；图片编辑不再调用 attachImageOverlay / positionImageOverlay，也不使用 fixed、absolute 或 Portal。预览及属性对话框的定位不属于图片源码 Widget。
- 独立图片源码在图上方；混排源码留在同一个段落，容器结构不变，宽度不足正常折行。源码输入框有独立文字行高，避免旁边大图片把文字选区拉高。
- 完整 Markdown、受控 HTML、引用式原始语法可以直接编辑。单击优先选 alt，双击选完整源码，Ctrl+A 限于当前图片源码。未修改的 HTML 属性顺序、空格和引号保留。
- 合法语法生成图片；临时不完整语法生成保存原文的 image_source 节点，每次实际修改经 MarkdownSourceBridge 发布规范文本事务。删除整段后可继续普通输入；修复语法后重新显示图片。
- 源码编辑拥有自己的剪贴板快捷键上下文。应用菜单剪贴板命令也按当前局部选区处理，并检查异步读写期间草稿和选区是否变化。撤销重做后恢复源码焦点，保证下一次 Ctrl+Y 仍进入文档历史。
- 失效、未加载图片仅展示小图标和完整源码；真实失败类型保留在 tooltip / 右键重试中。空路径显示“输入图片路径”视觉提示及文件夹。提示使用伪元素，不进入复制文本或保存内容；非空失效路径没有文件夹按钮。
- 八个缩放比例以自然尺寸计算后再受正文宽度限制，持久化为受控 HTML zoom，转换回 Markdown 会移除 HTML 尺寸属性。源码展开时缩放及切换图片语法仍有效，无常驻百分比按钮或图片操作栏。

正文流、草稿事务和大图处理的共同修改已在同一工作区的并发提交 effb382 中进入 main；本次后续提交补齐最终焦点、剪贴板、占位、选区布局及验收材料，没有重写该提交。

## 相同文件、素材与正文宽度

真实桌面：Windows 11，100% DPI；Typora 1.12.4（GitHub 主题）；Markumo 本地 Tauri debug 应用，使用隔离的 imageaudit 测试配置和当前源码 Vite 页面。没有把无界面 Chromium 截图当作桌面截图。

两端打开同一个 `test-results/typora-inflow-native/flow.md`，包含相同的 320×180 PNG、损坏文件、空路径和不可达回环 HTTPS 地址。可复用副本：[fixture.md](images/typora-image-parity/fixture.md) 与其 images 子目录。回环地址没有对外传输文件。

- Typora 窗口 780×693，正文约 x=30…738；Markumo 窗口 810×782，正文约 x=48…756；**两端正文宽度均约 708px**，没有用相同窗口宽度冒充相同正文宽度。
- 原生截图保持原始尺寸；comparison 图片只增加标签和左右拼接，不缩放、不重绘应用内容。
- 测试文件 626 字符。中文修改后撤销，再实际 Ctrl+S，文件 SHA256 与原始值一致：`379B1FCDA7BB4607D89590DA6BE6EDD0F57C888C92746162EC0DE1D48E1D9BD8`。
- Markumo 测试使用隔离配置。开发热更新产生的测试草稿未被删除；截图不包含恢复弹窗。未修改用户文档或 Typora 安全设置。

## 真实桌面对照

以下“通过”仅指列出的行为。字体、边框、间距和图标并非逐像素一致。

| 场景 | 桌面结果 | 原生对照与实际差异 |
| --- | --- | --- |
| 独立图片、标题附近 | 行为通过 | [对照](images/typora-image-parity/comparison-standalone.png)：源码在图前、标题不被覆盖、下文随布局移动；两端应用工具栏和段距不同 |
| 前后有文字 | 行为通过 | [对照](images/typora-image-parity/comparison-mixed.png)：BEFORE / 源码 / 图片 / AFTER 原顺序，自然换行；字体及换行断点不同 |
| 连续图片 | 行为通过 | [对照](images/typora-image-parity/comparison-consecutive.png)：只展开当前 B，保持原来的换行；源码输入框文字高度独立 |
| HTML 图片 | 行为通过 | [对照](images/typora-image-parity/comparison-html.png)：完整原始属性文本，160px 图片继续居中；未替换成 Markdown |
| 引用图片 | 行为通过 | [对照](images/typora-image-parity/comparison-reference.png)：保留 `![引用图片][logo]`；Markumo 引用定义使用折叠视图，Typora 展示方式不同 |
| 空路径 | 行为通过，外观部分一致 | [四类占位对照](images/typora-image-parity/comparison-errors.png)：完整语法、路径提示和文件夹；Typora 提示为灰色块，Markumo 为浅色文字，文件夹颜色不同 |
| 文件不存在 | 紧凑占位通过 | 同上：小图标及完整源码，没有灰色卡片和大段错误说明；破图图标形状不同 |
| 文件损坏 | 紧凑占位通过 | 同上：独立损坏原因保留在 tooltip，正文紧凑 |
| 网络不可达 | 真实失败通过 | 同上：在右键选择“加载图片”后请求 `https://127.0.0.1:14999/missing.png` 失败，tooltip 为加载失败；[加载前](images/typora-image-parity/markumo-errors-before-network-consent.png)仍等待显式加载，未绕过远程加载限制 |
| 列表、引用、表格 | 原生展开通过，修改事务由浏览器专项覆盖 | [列表](images/typora-image-parity/markumo-list.png)、[引用](images/typora-image-parity/markumo-quote.png)、[表格](images/typora-image-parity/markumo-table.png)：源码仍在对应容器中；未把浏览器 fill 等同于桌面键盘修改 |
| 中文 IME、Ctrl+Z / Ctrl+Y | 原生通过 | 使用实际微软拼音按键 a、Space 提交“啊”，[候选阶段](images/typora-image-parity/markumo-ime-composition.png)、[已提交](images/typora-image-parity/markumo-ime-committed.png)、[撤销](images/typora-image-parity/markumo-ime-undo.png)、[直接重做](images/typora-image-parity/markumo-ime-redo.png)。原生选中文本分别为“普通”“啊”，字符数在 626 / 625 间变化，图片持续可见 |
| 空路径文件夹 | 原生入口和取消通过 | 实际打开系统图片选择器，Escape 取消后文件仍为已保存的 626 字符。未将浏览器 chooseLocal 桩当成原生文件导入通过 |
| 保存、关闭并重新打开 | 原生通过 | Ctrl+S 后核对原文件哈希；关闭干净文档，系统选择器重新打开同一 flow.md，仍为已保存的 626 字符且图片正常，[重新打开截图](images/typora-image-parity/markumo-reopened.png)；完整 HTML 和引用拼写未改变 |

原生 **NOT TESTED**：真实系统剪贴板粘贴（自动化文本注入不能可靠代表粘贴）、系统选择器确认导入后的文件系统结果、小图/长图/大图完整矩阵、双分栏窄 Pane、外部删除后恢复、代码块旁删除全部空行、每种容器内键盘修改与跨模式保存。相应已覆盖的浏览器场景见下一节，不能替代这些原生项目。

## 自动化与构建

| 命令 | 结果与范围 |
| --- | --- |
| `pnpm typecheck` | PASS：vue-tsc 与 node tsconfig |
| `pnpm build` | PASS：最后一次 Vite 构建 14.29s；存在 chunk 大小提示，无构建错误 |
| `pnpm test:smoke` | **50/50 PASS，0 跳过，388.54s** |
| `pnpm test:regression` | **62/62 PASS，0 跳过，475.89s** |
| `node scripts/run-regressions.mjs scripts/markdown-live-toolbar-regression.mjs scripts/image-editing-regression.mjs` | 最终相关文件重跑 **2/2 PASS，32.66s**；包括 19 项应用工具栏场景、真实 App Ctrl+V 及 Ctrl+Z/Y，以及图片专项 |
| `node scripts/run-regressions.mjs scripts/image-editing-regression.mjs` | 添加选区高度断言后 **1/1 PASS，12.24s**；4 组受控 HTML 单元断言 + 14 图片浏览器场景，无跳过，无 pageerror |

完整 Smoke / Regression 在最后的空路径视觉提示、文字选区和历史焦点小修之前运行；这些后续修改已重跑相关专项、应用快捷键、typecheck 和 build，没有将早先全套结果伪称为最终每一行代码的完整重跑。本轮未新增 Rust 修改；原生应用编译成功不等于 Rust 全套测试通过。

专项源文件：[typora-image-parity-regression.mjs](../scripts/typora-image-parity-regression.mjs)，通过记录：[browser-results.json](images/typora-image-parity/browser-results.json)。覆盖：Widget DOM 前后顺序和 static 定位、真实行盒、未选中无 Widget、标题自然移动、其他图片 DOM 复用、完整语法选区、临时草稿逐事务发布、HTML 拼写、引用定义更新及跳转、空路径选择与键入、五类错误及修复、远程显式加载、全部八个自然尺寸百分比、两向语法转换、撤销重做及重新解析、4000×2400 图片限宽、列表/引用/表格内修改、双 Pane 长路径、普通链接、合成 composition、只读和受控 HTML 拒绝危险属性。

浏览器使用合成 composition 与直接 insertText 的项目，与上表真实微软拼音验收分别记录。

## 菜单矩阵差距（未完成）

用户要求按研究矩阵逐项实现。本轮没有完成所有项目；不能以源码编辑通过替代完整菜单验收。

| Typora 项目 | 当前 Markumo 状态 | 原因 / 边界 |
| --- | --- | --- |
| 八项缩放、分隔线、转换语法 | 浏览器行为通过 | 自然尺寸与限宽、源码同步、两向转换和历史通过；未逐项重做本轮原生八比例点击 |
| 通用复制/粘贴为、格式、段落、插入 | 现有菜单保留，PARTIAL | 图像与局部源码剪贴板上下文已修复，未按本轮完整原生矩阵逐项执行 |
| 打开图片位置 / 网络图片在浏览器中打开 | 未接入图片菜单 | 不能把存在底层接口当成用户菜单已实现 |
| 复制到当前 assets、复制图片到… | 未实现该菜单流程 | 现有空路径导入接口并不等价于这些独立操作及取消语义 |
| 重命名 / 移动图片到… | 未实现 | 需要同时验证文档授权、源/目标路径、取消时零修改和文档事务，不能通过简单改 src 冒充磁盘移动 |
| 删除图片文件 | 未实现 | 当前“删除图片”仅删除 Markdown 节点，可撤销；不会删除磁盘文件 |
| 上传图片 | 未实现上传流程 | 没有配置上传服务，也没有执行对外上传；未以配置缺失掩盖实现缺项 |
| 拷贝图片位图 / 将图像另存为… | 未实现该图片菜单流程 | 复制源码与复制位图是不同操作 |
| 表格、列表、引用专有通用菜单外观 | PARTIAL | 容器编辑保留，不声明所有菜单顺序、图标及启用条件一致 |

当前菜单另有加载/授权、对齐、放大预览、复制路径、引用定义跳转和图像属性；这些是 Markumo 的已有差异，不算 Typora 逐项通过。正文中没有恢复这些功能的常驻工具条。

交付边界：图片正文内源码编辑和紧凑占位已修复并有实机、自动化证据；**完整右键文件操作和全部原生验收尚未完成**。没有自动 push、修改版本号或发布 Release。
