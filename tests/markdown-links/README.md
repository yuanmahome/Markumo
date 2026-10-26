# Markdown 链接交互回归

```sh
pnpm test
pnpm test:markdown:live
pnpm test:links
```

三种入口均运行完整的 28 项链接交互检查。需要 Playwright Chromium，可运行 `pnpm exec playwright install chromium` 安装，或用 `MARKUMO_CHROME` 指定本机 Chromium 可执行文件。

测试通过真实 DocumentManager 挂载 Live 编辑器，用浏览器鼠标和键盘完成点击、拖动与修饰键切换。检查真实相对文件打开事件和 Tauri 外链 IPC 请求，以及临时源码 DOM、PM/DOM/规范文档选区、正文、dirty、Undo/Redo、属性面板与监听器释放。外部网络请求被阻止，导航在受控接口处记录；粘贴和中文输入另用 ClipboardEvent/CompositionEvent 验证。

覆盖普通点击编辑与收起、Ctrl/Meta 首击与快速连击、文件与锚点、查询参数、编码路径、裸 URL、引用链接、拖动与取消、只读、多 Pane、模式切换及危险路径。结果写入忽略跟踪的 `test-results/markdown-links/`。

可对远程基线做反证检查：

```sh
node tests/markdown-links/regression.mjs --baseline
```

该选项从本地 `origin/main` 读取原始 Live 控制器，不修改工作区。未修复的控制器会在第一次 Ctrl+点击的 `sourceEntries` 断言处失败。

## Windows 桌面验证

`desktop.mjs` 连接运行于 `9473` 调试端口的实际 Markumo WebView，执行 7 项原生集成检查。使用独立的应用标识和数据目录构建，避免读写日常配置。启动进程前设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9473`。

在隔离实例中，通过原生文件夹选择器打开测试工作区。准备 `main.md`，包含以下链接和正文，并准备 `codeExplain.md`，其中包含 `# Target heading`：

```markdown
# Link verification

Start plain text.

[定制项目配套代码讲解文档](codeExplain.md)

[带锚点文件](codeExplain.md?view=raw#target-heading)

[缺失文件](missing.md)

[未授权文件](../../../../AGENTS.md)

[内部锚点](#local-heading)

## Local heading
```

```sh
node tests/markdown-links/desktop.mjs
```

该检查使用真实文件打开、错误提示与分栏，不替换 Tauri IPC 或工作区权限验证。只在既有相对导航事件入口观察请求次数，并检查实际打开的文档和目标窗格。
