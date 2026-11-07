# 跨窗口移空后的窗口生命周期修复

基线：main，c1cce68（v1.2.4）；不修改版本，不创建分支，不推送或发布。

## 根因与处理

旧 EmptyDetachedWindow 只对 detached 窗口生效，而且只记录曾经有文档，不能区分普通关闭最后一个标签和成功的跨窗口移动。主会话所有者由 LaunchKind::App 隐式推导，直接销毁主窗口会失去持久化能力。另有两个关联问题：临时窗口关闭时跳过 SessionWriter 刷新，以及 incoming-tab 监听注册晚于启动就绪状态。

新 EmptyWindowLifecycle 只在原生收据确认 committed、源端移除文档后登记本次移交。关闭前再次检查启动完成、无文档、无 dirty、无待完成移交、无文件任务/组合输入/关闭确认/更新安装，经过 WindowCloseGuard 的 handoff 分支刷新资源与状态。原生再核验目标存活、移交收据、源端空快照及目标快照。任一步失败保留源窗口。普通关闭标签、同窗口移动、复制、取消和未提交超时均不能登记自动关闭。

事件只是提示：receiveDetachCommitted 与超时查询最终进入同一 finishOutgoing。异步查询返回时检查原 pending 身份，已销毁窗口的回调不再移除文件。组合输入期间保留移交锁，文档管理器下一次通知输入结束后再移除被拖动分栏的标签；其他分栏即使显示同一个文件也保留，源窗口因此保持打开。

## 会话与授权

LaunchRegistry 显式保存唯一 session_owner。各窗口只能登记由自身文件 token 验证的元数据快照；persist_session 仍要求当前 owner（原更新协调器授权路径保持原样）。权限核验、原子写入、所有权迁移共用 registry 锁，避免旧 owner 的在途写入覆盖新 owner。

prepare_empty_window_close 在切换 owner 之前原子保存目标与其他窗口的合并会话，并保留源工作区根目录；将其他窗口文件补入恢复布局，使重启后文件可见。保存失败不更换 owner，也不允许自动关闭。事件促使新 owner 刷新；每次快照登记仍返回原生权威身份，不依赖事件送达。临时窗口关闭前也刷新快照，从而覆盖“晋升后立即打开文件并退出”的情况。窗口销毁清理 owner、快照、窗口顺序和恢复记录的内存声明。

文件最后一处引用移走时，文件写授权仍使用原独占 transfer_grant。若源端其他分栏仍引用该文档，只关闭拖动标签，为目标从源 token 派生独立受限 token，完整保留原路径、只读标记、编码与文件身份限制；回滚只释放派生 token，不能撤销源端授权。临时窗口可为自己持有 token 的文档保存恢复快照、删除自己声明的快照，不能读取/列举主恢复库。主窗口也不会把其他活跃窗口声明的快照列为遗留草稿，不能删除这些活跃快照。dirty 文档在目标获得持久恢复保护后才提交。自动保存继续通过同一 FileController；移交忙状态与工作区忙状态分开，防止移交结束错误清除其他文件任务。

## 资源释放

关闭前等待 Vue 更新、源文件 token 释放和 PDF teardown。窗口卸载后再等待资源屏障才销毁原生窗口；复用已有监听器、编辑器、Worker 和控制器清理。PDF 原有有界优雅关闭与强制终止保留，未用延迟猜测移交是否完成。

## 运行方式与证据

```powershell
pnpm typecheck
cargo test --manifest-path src-tauri/Cargo.toml --lib
node tests/lifecycle/ownership.mjs
node tests/recovery/browser.mjs
node tests/drag/browser.mjs
node scripts/memory-release-build.mjs --label=dnd-empty --installer
node tests/windows/empty-window-native.mjs
```

Windows 脚本静默安装本地 NSIS 包到 test-results/empty-window/installed，然后通过真实 Tauri IPC、WebView2、窗口与文件授权执行移交，并观察页面实际销毁和重启后的磁盘会话。不是模拟关闭事件。测试构建增加只用于观测/故障注入的探针和窗口聚焦权限，生产 capability 不变。跨窗口移交由生产 detach 函数触发；同窗口 Ctrl/Alt 使用 WebView 指针事件。组合输入使用真实编辑器的 composing 状态注入，尚不能替代 Windows 中文输入法的人工组合输入验收。

原始 Windows 结果：test-results/empty-window/native-results.json。
构建输入与二进制摘要：test-results/phase042/build-dnd-empty.json。

## 修改文件

- src/features/shell/EmptyWindowLifecycle.ts（替代 EmptyDetachedWindow.ts）
- src/features/shell/WindowCloseGuard.ts、windowResources.ts、launchSession.ts
- src/features/windows/tabDetach.ts
- src/app/useAppShell.ts、desktopStartup.ts
- src/features/files/FileController.ts
- src/features/recovery/RecoveryController.ts、tauriRecovery.ts、types.ts
- src/components/viewers/PdfViewer.vue
- src-tauri/src/files/mod.rs、session.rs、commands/session.rs、commands/detach.rs、commands/recovery.rs、detach.rs、lib.rs
- scripts/memory-release-build.mjs
- tests/lifecycle/ownership.mjs、tests/windows/empty-window-native.mjs

## 限制

- 恢复快照仍受原 8 MiB 文本预算限制；无法取得恢复保护的 dirty 文档安全取消移交。
- 不迁移 undo 历史；这是已有跨窗口协议的限制。
- 原 owner 的历史恢复记录可能作为未声明草稿保留，不会为了移交清空恢复库。
- 源工作区根目录保留用于重启恢复，当前目标窗口不自动展开源工作区。
- 这里只验证资源计数和真实窗口销毁，没有做长时间 RSS/Private Bytes 泄漏曲线。
- 尚未覆盖物理鼠标跨窗口 OLE 拖动及真实 Windows 输入法组合输入的人工复测；不能宣称所有硬件输入场景均已验收。

## 最终验证结果（2026-11-07）

- Windows NSIS 安装版：18/18 项自动场景通过；退出码 0。
- Rust：71/71；类型检查通过；生命周期 6/6；恢复 12/12；拖动 UI 10/10。
- 安装版资源采样：[{"records":0,"cm":0,"pm":0,"workers":0}]。
- 测试二进制 SHA-256：52b397c2a9024999d2406372a46803ec6f7b7e32adc24cbbfb41f51cd92cda8d。
- 本地测试包曾出现 bundler type 写锁警告；本次没有验证更新器安装路径，该包不作为发布包。

| 验收项 | 自动验证 |
| --- | --- |
| 1 主窗口最后文件移到新窗口 | 通过 |
| 2 主窗口最后文件移到已有窗口 | 通过 |
| 3 detached 窗口移空 | 通过 |
| 4 file 窗口移空 | 通过 |
| 5 两文件只移一个 | 通过，源保留 |
| 6 多分栏，同一文件移出一处 | 通过，源保留另一处，dirty/文本与授权正确 |
| 7 同窗口分栏移动 | 通过 |
| 8 Ctrl/Alt 复制 | 安装版 WebView 指针事件通过；该同窗口测试关闭了原生 OLE bridge |
| 9 dirty 文档成功移交 | 通过，内容和 dirty 保留，目标保存成功 |
| 10 目标拒绝 | 通过 |
| 11 取消 | 通过 |
| 12 超时 | 通过，测试探针阻止目标 take，真实原生 reservation 回滚 |
| 13 commit 通知丢失 | 通过，真实 committed 收据经状态查询处理 |
| 14 两次并行移交 | 通过 |
| 15 源端文件任务 | 通过，任务结束才关闭 |
| 16 组合输入 | 编辑器组合态注入通过（含 commit 后才进入组合态），真实 OS IME 待人工 |
| 17 新 owner 继续编辑保存/新文件 | 通过 |
| 18 所有权迁移后重启 | 通过 |
| 19 最后应用窗口 | 普通关闭最后标签保持窗口，通过 |
| 20 文件夹工作区与空标签 | 通过，不因正常空标签关闭工作区窗口 |

测试安装器曾关闭原本运行的 D:/tools/Markumo/markumo.exe；测试结束后重新启动原安装程序。测试仅使用独立数据目录，没有将测试代码覆盖到该安装目录。

## v1.2.5 发布准备

用户随后授权发布新版本。版本统一更新为 1.2.5，发布说明位于 docs/releases/v1.2.5.md；发布前 pnpm check、Rust 71/71 与完整 smoke 31/31 全部通过。上述 Windows 18/18 验证针对版本递增前的同一修复代码。
