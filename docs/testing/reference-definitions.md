# 引用定义阅读与编辑回归

2026-11-05，在 main 上修复。保留上一轮未提交修改；没有创建分支、修改版本、推送或发布。

## 根因

`MarkdownParser` 已在 Markdown-it 的 `strip_references` 之前保存原生引用定义范围，并将定义保留为 `protected_source`。双栏预览按 Markdown-it 语义移除定义 token，因此不把定义当正文。

实时排版的 `protectedView()` 则给 reference 生成常驻 details / summary。reference 不属于 `knownPreview`，所以 `finishSource()` 遇到它会直接返回，失焦和 Esc 无法恢复普通阅读状态。此外，结尾的受保护定义触发了普通原子块的尾部段落占位，不适合不可见的引用定义。

专项测试还发现：使用普通块删除移除第一条重复定义，会丢掉它之前的分隔符；后续重复定义可能紧接图片段落，无法再被 Markdown-it 识别为定义。

## 修复文件

| 文件 | 修改 |
| --- | --- |
| `src/editor/markdown/wysiwyg/MarkdownEditorController.ts` | reference 使用零尺寸、非正文 NodeView；链接及图片右键“编辑引用定义”；引用式链接属性也进入定义面板；删除仅移除定义原始源码范围，保留分隔符。 |
| `src/editor/markdown/wysiwyg/ReferenceDefinitionPanel.ts` | 浮动 URL / 原始定义编辑面板，完成、失焦、Esc 关闭；URL 更新只替换原生解析确认的目标值区间；保留标签写法、空白、角括号、可选标题；撤销交回正式文档历史。 |
| `src/editor/markdown/wysiwyg/referenceNavigation.ts` | 跳过隐藏原子的方向键与相邻删除处理；处理映射遗留的 NodeSelection；保护用户删除可见段落／文本选择时跨过的隐藏定义；不会从列表／表格内部提前跳出。 |
| `src/editor/markdown/wysiwyg/MarkdownParser.ts` | 保留 Markdown-it link/image token 的原生 `meta.label`；沿用原生定义范围、标签规范化及目标解析 helper；图片属性继续委托既有官方适配器。未定义图片的标签规范化也改为原生工具，避免 Unicode 大小写语义差异。 |
| `src/editor/markdown/wysiwyg/MarkdownSchema.ts` | 链接 mark 和图片保存 referenceLabel；有相同 URL 的不同引用仍可区分。 |
| `src/editor/markdown/wysiwyg/MarkdownTheme.css` | reference 空节点退出正文流，无边框、空白高度或占位；浮动面板样式；清除旧常驻引用源码框样式。 |
| `src/editor/markdown/wysiwyg/TrailingParagraph.ts` | 判断是否需要编辑尾段时忽略隐藏定义，避免定义导致多余空段；只有定义的文档仍保留必要编辑位置。 |
| `tests/reference-definitions.mjs`、`tests/reference-definitions-api.ts` | 真实编辑器专项回归及共享 ProseMirror 类型的测试入口。 |
| `tests/run-suite.mjs` | 将专项测试加入 smoke / regression 套件。 |

`MarkdownSourceBridge.ts` 的原始块、位置映射和 definitionsChanged / 新环境重解析机制继续沿用；没有通过删模型节点隐藏定义。`rendering.ts` 和 `splitPreview.vue` 的正常引用渲染已经正确，无需修改。不存在另写一套引用标签匹配语义的解析器；局部前缀匹配只在 Markdown-it 已验证完整定义后定位 URL 原始值区间。

普通阅读时 reference NodeView 内没有 textarea / summary。它保留在模型中，退出正文流；配合明确的 PM 键盘、选区与删除策略，而非仅添加 display:none。右键引用链接／图片可修改定义；未使用的定义保留在源码，可切到源码模式编辑。脚注仍可阅读，YAML 卡片与目录 UI 保留。

## 验证

测试运行于 Chromium，加载实际 DocumentManager、MarkdownEditorController、SourceBridge、菜单及 SplitPreview，执行真实点击、字段输入、方向键、鼠标拖选和历史操作，不是只测解析函数。外部导航由既有测试 fixture 拦截，以检查 Ctrl+点击路由而不打开外部程序。

- `node tests/reference-definitions.mjs --baseline`：使用 Git 中原控制器和主题的只读 Vite 覆盖，复现常驻定义 UI 和失焦不折叠。没有修改历史源码或切换分支。
- `node tests/reference-definitions.mjs`：最终 17/17，pageErrors=0。
- `pnpm test:smoke`：一轮完整套件 27/27，0 failed，含原有链接交互、表格、图片、脚注、剪贴板、源码保真、分栏与生命周期测试。后续追加的 Unicode、映射遗留选区和 CRLF 局部更新边界由最终专项测试覆盖。
- `pnpm typecheck`、`pnpm build`：通过。保留已有产物体积提示；没有为本轮修复发布安装包。

| 用户验收项 | 覆盖 |
| --- | --- |
| 1 单定义；2 多定义；3 多处引用 | 阅读内容与预览相同；同一定义的四处链接和图片立即更新；不同定义即使 URL 相同也独立更新。 |
| 4 开头／中间／末尾；5 空行；6 标题／表格／列表 | LF / CRLF 模式切换与保存重开；列表末尾和相邻段落的方向键；定义不增加段落间距、尾部占位。 |
| 7 编辑 URL；8 编辑标签 | 右键真实面板编辑，只有目标定义源码变化；旧标签变为未定义、新标签立即生效。 |
| 9 删除恢复；10 撤销重做 | 删除首个定义时重复定义接管；撤销恢复首个目标，重做恢复重复定义目标。 |
| 11 重新打开 | DocumentManager.saveSnapshot 保持原始换行；CRLF 编辑结果写入测试文件，读取后重新打开，目标地址和标题一致。 |
| 12 截图 | baseline / 修复后实时排版和双栏截图保留；修复后只显示“引用链接”。 |
| 13 光标与选择 | 左右／上下越过定义，映射遗留的原子选区脱离；鼠标跨定义选中前后正文；相邻 Backspace / Delete 不误删定义；选中可见内容删除仍保留隐藏定义；真实 sourcePosition / documentPosition 往返位置正确。 |
| 14 LF / CRLF | 未编辑时 bridge round-trip、模式切换、saveSnapshot 不变；编辑 URL 保留原始大小写标签、缩进、Tab、角括号、多行可选标题及 CRLF 字节。 |
| 15 普通链接／图片 | 普通链接回归；图片右键编辑共享定义；Ctrl+点击保持导航且不展开源码；脚注、Front Matter、TOC 阅读 UI 回归。 |

同时覆盖完整引用、折叠引用、快捷引用、重复定义 first-wins、未定义引用、大小写／空白规范化、Unicode 标签、多行标签空白，以及无源码变化的失焦／Esc 收起。

证据目录：`test-results/reference-definitions/`（不纳入 Git），包括 `results.json`、`regression.log`、`smoke.log`、`typecheck.log`、`build.log`、`saved-reference-crlf.md`，以及：

- `before-live.png`、`before-split.png`
- `after-live.png`、`after-split.png`
- `after-live-content.png`、`after-split-content.png`

没有声称本轮执行了新的 Windows 安装／升级验收；本轮验证的是实际编辑器组件和生产前端构建。整个修复不改变文件服务或既有用户配置。
