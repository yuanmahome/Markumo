# Front Matter 与示例工作区 Windows 验收记录

日期：2026-11-05。基线：`main` / `6ebcff4b9ada7ead095a954cdc3b814098027e9a`（v1.2.1），开始前已 fetch 并确认与 origin/main 一致。所有修改留在 main，未修改版本、创建分支或工作树、推送或发布。

## 根因与修复

1. `frontMatterParser.ts` 原来的流式集合正则匹配任意以 `[` 开头的值，因此 `tags: [示例, Markdown]` 虽然已经被解析成标签，仍得到 `editable: false`，原因误写成跨行集合。原来的逗号拆分、寻找第一个结束引号和注释字符串也不了解引号上下文。
   - 新的扫描器先识别引号、转义、单引号成对转义和注释，再拆分单行数组；引号中的逗号、冒号、井号、锚点字符均保留为字符串。
   - 复杂嵌套、真实锚点／别名、多行集合、不支持的标量仍走源码降级。数组和多行字段不提供标量更新接口。
   - 标题只替换精确值区间；相同值返回原文，换行输入拒绝更新；保留其他字段、顺序、注释和引号。卡片补充 updated 展示。

2. `examples.rs` 把复制成功记成 complete，`initialize_launch` 随后又因 session 存在而不展示；初始化和展示混为同一个状态。迁移逻辑还可能仅因空旧目录就生成 marker，进而让新配置被判为老用户。
   - 状态拆成 `resources_ready` 和 `presentation`（pending / suppressed / shown），兼容旧 skipped / complete 数据。旧 complete 不能证明已经展示。
   - 复制完成仅设置资源就绪。界面接收目录树、README 并完成启动后才确认展示；确认需要当前窗口的 README 文件授权 token。
   - 历史会话保留，首次文件请求优先并抑制自动示例；手动帮助入口始终可用。
   - OS 文件锁覆盖配置初始化、状态读改写、目录预留和复制，进程退出自动释放锁；状态仍使用原子检查写入。复制保持 no-clobber，不覆盖已有示例文件。
   - 迁移 marker 不再单独代表历史用户；空旧目录不再生成完成迁移 marker。
   - 桌面失败重试验收额外发现：已保存的空 editorLayout 会清掉刚接收的 README。自动打开示例时不恢复该空布局；只允许空会话或仅含示例根目录的中断会话自动重试，用户文件与其他工作区不受替换。

3. 帮助入口过去先取得 example_workspace 字符串，再调用仅接受 recent_workspaces 路径的 open_workspace_path，新示例从未得到授权。
   - 新增无客户端路径参数的 `open_example_workspace`。原生从 ExampleStore 取路径，在当前窗口添加工作区，经根目录校验和现有 FileService 打开 README，返回完整工作区与 OpenFile。
   - WorkspaceController 使用现有添加工作区交互、文件接收和路径去重，保留原有根目录、分栏、未保存文档。确认展示发生在成功接收之后。
   - `open_workspace_path` 的 recent_workspaces 校验保持原样；没有放宽任意绝对路径访问。

关键文件：

| 文件 | 关键位置 |
| --- | --- |
| src/editor/markdown/frontmatter/frontMatterParser.ts | scan、scalar、parseFrontMatter、updateFrontMatterField |
| src/editor/markdown/wysiwyg/FrontMatterCard.ts | 标题局部更新，updated 展示 |
| src-tauri/src/examples.rs | configure、lock、open、acknowledge、兼容旧状态及并发测试 |
| src-tauri/src/profile_migration.rs | 仅实际导入后写入迁移标记 |
| src-tauri/src/commands/session.rs | 空会话／中断重试判定，清除空布局恢复 |
| src-tauri/src/commands/workspace.rs | open_example_workspace、acknowledge_example_workspace |
| src-tauri/src/lib.rs | 原生命令注册 |
| src/features/workspace/contracts.ts、tauriWorkspace.ts、WorkspaceController.ts | 专用 gateway、添加工作区、文件接收和确认 |
| src/app/useShellCommands.ts、useAppShell.ts | 帮助菜单及启动展示确认 |

## 自动回归

- `node tests/frontmatter-regression.mjs`：通过。解析 LF／CRLF、引号、转义、单引号成对转义、数组内逗号／冒号／井号、注释、普通字符串中的撇号、引号内锚点字符；相同值不变、标题局部替换、拒绝数组标量更新；复杂语法拒绝更新。Playwright 使用真实 DocumentManager / 编辑器，执行字段编辑、模式切换和降级显示。已加入 smoke / regression 入口。
- `cargo test --manifest-path src-tauri/Cargo.toml --lib`：42/42。示例测试包含复制与展示分离、重启重试、用户修改保留、显式文件请求、老配置识别、marker 误判、目录冲突和回退、同 Store 并发、4 个独立服务并发；会话测试覆盖空会话、仅示例根、用户根和用户文件。
- `node tests/lossless/browser.mjs`：73/73，pageErrors=0。
- `node tests/workspace/open-visibility.mjs`：12/12。
- `pnpm typecheck`：通过。NSIS 生产构建通过，现有体积和 dead_code 提示仍在。

本机日志：`test-results/examples-fix/` 下的 `frontmatter-final.log`、`rust-final.log`、`lossless-final.log`、`workspace-final.log`、`typecheck-final.log`、`build-production-final.log`。日志及用户配置备份不纳入 Git。

## 真实安装与桌面结果

使用 Windows NSIS 安装程序和安装后的 EXE，使用 computer-use 的 Windows UI 操作菜单、编辑字段、切换模式和保存；没有把 Rust 单元测试当成桌面验收。

隔离安装采用相同源码，以外部 Tauri 配置覆盖 identifier / productName / appDirectoriesOverride，避免清理现有 AppData。正式安装另使用仓库默认配置。测试配置与各轮 profile 归档保留在 `test-results/examples-fix/`。

| 场景 | 结果与实际证据 |
| --- | --- |
| A 全新独立配置 | 通过。安装后自动显示真实目录树及 README；文档目录为 Markumo Examples (1)，状态在展示后为 shown。 |
| B v1.2.0 升级 v1.2.1 | 通过。下载并实际安装官方 v1.2.0，再以本地修复包升级。两次安装退出码均为 0，卸载注册项版本由 1.2.0 变为 1.2.1，安装位置 D:\tools\Markumo。升级前后 files.json、workspaces.json、last-session.json、editor-settings.json 逐字节一致。正常启动恢复原有 5 标签、1 根目录，不强制示例。应用正常运行期间 recent 更新、设置补齐属于运行行为，未将其误记为安装前后字节不变。 |
| C 卸载重装保留配置 | 通过。真实运行隔离版 uninstall.exe /S 后 profile 仍存在；重新 NSIS 安装并启动使用同一路径和状态。 |
| D 历史会话和打开文件 | 通过。隔离历史文件正常恢复；生产配置恢复 5 标签和 1 根。帮助操作后原历史标签／根目录逐一仍在，变为 6 标签和 2 根。未保存标题在打开示例后仍留在原标签，随后保存仅改变标题值。 |
| E Explorer 双击 Markdown | 未完整通过。系统 .md UserChoice 是 Typora.md，未改变用户默认关联。已验证真实原生 EXE 接收 Markdown 文件请求、首次文件启动优先用户文件且 presentation=suppressed / path=null；这不能替代 Explorer 默认双击启动 Markumo 的完整验收。 |
| F 初始化失败后重试 | 通过。临时移走隔离安装的 examples 资源使复制失败，持久状态 resources_ready=false / pending，并保存空会话。恢复资源后重启；验收发现的空布局问题修复后，沿用 Markumo Examples (4)，目录树与 README 同时出现，状态才变为 shown。另覆盖已保存示例根但没有 README 标签的中断状态。 |
| G 首次关闭再打开 | 通过。正常关闭／重新启动恢复同一示例路径、树和 README，没有另建目录。 |
| H 多窗口并发初始化 | 通过已执行的场景：同时发起两个文件启动，真实同进程两个窗口分别显示用户文件，没有自动创建示例。资源复制的并发另由 4 个独立 ExampleService 实例测试验证同一路径和 OS 锁；未将此单元测试描述为 4 个 GUI 窗口同时复制的结果。 |
| I 帮助手动入口 | 通过隔离旧配置和实际升级用户配置。实际旧状态为 skipped / path=null；点击帮助后真实目录树出现、README 打开，状态为 shown；已有工作区追加保留。重复点击无重复根和标签。 |
| J 修改示例后再次打开 | 通过。在隔离测试新建的示例 README 加入“验收用户修改 J”，再次从真实帮助菜单打开后 UI 显示修改，磁盘内容仍在，复用同一路径和 README 标签。 |
| K 合法 Front Matter | 通过。真实安装版显示标题、三个标签（含逗号／冒号）、created、updated、status。依次切换源码／双栏／实时排版并保存，CRLF 文件 SHA256 与原文件一致；真实标题编辑后逐字节比较仅标题值改变。生产环境完整教程的原始 title / tags 示例也正常显示。 |
| L 复杂 YAML | 通过。真实安装版显示“包含 YAML 锚点或别名引用”并保留编辑源码入口；进入源码保存后 SHA256 与原始复杂 YAML 文件一致。 |

生产安装的打包资源目录 `D:\tools\Markumo\examples` 包含 README 和五个子目录，均可读取。实际升级用户通过帮助创建的可写工作区为 `C:\Users\18089\Documents\Markumo Examples (5)`，已在 Windows 文件资源管理器中打开，能找到 README 和五个子目录。

最终安装包：`src-tauri/target/release/bundle/nsis/Markumo_1.2.1_x64-setup.exe`。
SHA256：`13116DFFFD015864E0A1E29B16734D14E6C609B44649F319BD927AF47F2B2C06`。
这是 `--no-sign` 构建的本地验收包，没有发布。已安装的 EXE 与构建 EXE 仅有 Tauri 预期的 NSIS / UNK bundle-type 三字节标记差异。

## 剩余范围

E 的 Explorer 默认双击场景仍未完成，需要在默认关联本来就是 Markumo 的独立 Windows 用户环境验收。H 已做真实并发文件窗口和独立服务资源并发测试，但没有声称完成四个 GUI 窗口同步复制资源的操作。复杂 YAML 按设计继续使用源码编辑；这不是无损可视化 YAML 全语法编辑器。

未清空原 AppData，未删除原设置／会话，未改用户默认 Markdown 关联。原始配置备份和测试创建的示例目录均保留。帮助操作正常将示例追加到用户会话，原历史标签和根目录保留。
