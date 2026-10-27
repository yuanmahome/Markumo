# 发布与自动更新

`.github/workflows/release.yml` 在推送 `vX.Y.Z` 标签时构建 Windows x64、Linux x64、macOS Apple Silicon 和 Intel。也可在 Actions 手动填写已有标签重试。版本必须与 package.json、Cargo.toml、tauri.conf.json 一致。

工作流使用 Node 24、固定 pnpm 12.11.2、锁文件和 Rust stable。每个系统运行类型检查和 Rust 检查后生成安装包。四个构建全部通过，发布脚本确认所有安装包和签名存在后，才上传并公开 Release。失败时不会将不完整版本设为 latest；可从 Actions 下载成功任务的构建产物。

自 1.0.3 起，项目采用 AGPL-3.0-only；package.json、Cargo.toml 和 Tauri bundle 的许可证标识保持一致，根目录 LICENSE 通过 licenseFile 与资源配置随安装包分发。

## 更新签名

以下仓库 Actions Secrets 必须长期保留：

- `TAURI_SIGNING_PRIVATE_KEY`：Tauri updater 私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：私钥密码。

公钥写在 `src-tauri/tauri.conf.json`。同一产品后续版本必须沿用同一密钥，不能每次 CI 临时生成；私钥及密码不得提交到仓库或放进构建产物。初次配置已在本机用户目录 `.tauri/markumo/` 保存恢复副本，请单独安全备份。

`docs/releases/vX.Y.Z.md` 同时作为 GitHub Release 描述和 `latest.json.notes` 的来源；缺失时使用简短回退说明，超过 64 KiB 拒绝发布。Release 包含安装包、`SHA256SUMS` 和合并后的 `latest.json`，不单独上传 `.sig` 附件。CI 构建仍生成并传递 `.sig`，发布脚本读取签名并嵌入 `latest.json` 的各平台 `signature` 字段；缺失签名仍会阻止发布。`SHA256SUMS` 只列出公开附件。更新地址固定为 `https://github.com/yuanmahome/Markumo/releases/latest/download/latest.json`，使用 HTTPS 和 Tauri 原生签名验证。Windows 使用 NSIS；Linux 的应用内更新适用于 AppImage，deb 用户安装新版 deb；macOS 使用 `.app.tar.gz` 更新，`.dmg` 用于首次安装。

应用启动就绪后默认延迟 10 秒检查版本，此后每 4 小时再检查。设置 → 更新可关闭自动检查；自动后台下载默认关闭，新旧配置一致。开启后仅自动下载已验证的更新，从不自动安装或重启。下载期间可编辑，关闭面板和切换专注模式不中断任务；已下载资源保留到当前会话安装或退出。安装前通过进程级租约阻止冲突窗口与安装，专用确认支持保存全部（包含未命名文档）；任一保存取消、冲突、IME、文件操作或严格会话持久化失败均停止安装且保留下载。更新后以真实运行版本核验一次性成功提示。开发模式不执行安装。

当前 Windows 包没有商业代码签名证书，Mac 使用 ad-hoc 签名且未公证。它们与 updater 的必需签名是独立机制：Windows 可能出现 SmartScreen，macOS 首次运行可能需要在“隐私与安全性”中允许。未来正式分发证书可另行配置，不要移除更新签名。

## 发布下一版

1. 同步更新三个版本字段、Cargo.lock，以及 `docs/releases/vX.Y.Z.md`。
2. 运行 `pnpm typecheck`、`pnpm build`、Rust 检查。
3. 提交后推送代码与标签：`git tag vX.Y.Z`，`git push origin main vX.Y.Z`。
4. 等待四个构建及最终发布任务成功，检查 Release 的 4 个 updater 平台、安装包和 SHA256SUMS。

`scripts/release.mjs` 拒绝覆盖已经公开的版本；修改安装包应发布新版本。草稿发布失败可重试同一个标签。不要移动已公开的标签。

本地打包需要设置相同的 `TAURI_SIGNING_PRIVATE_KEY` 和 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 环境变量。只校验编译、不生成签名安装包时可使用 `pnpm build` 或 `cargo check`。

Windows 所有 `pnpm tauri build` / `build.bat` / CI 入口都会把生成的安装包、NSIS 输出目录及主程序设为 Medium 完整性，防止从受限工作目录继承 Low 标签，导致安装器无法写入普通安装目录。仅修改生成产物的安全元数据，不改变签名字节或用户安装目录的权限。

`pnpm tauri dev` 同样在启动前将 Cargo 的开发输出目录及已有主程序设为 Medium，后续热重编译产物继承该级别。否则从 Low 标签工作区启动的开发程序可能将普通桌面文件判定为“不可写”。修复启动脚本或产物标签后，已经运行的 Low 进程仍需重启；不需要修改文档权限或以管理员运行。Windows 原生回归：`node tests/dev/windows-integrity.mjs`。

实现参考：[Tauri updater](https://v2.tauri.app/plugin/updater/)、[GitHub Actions 官方工作流文档](https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)。
