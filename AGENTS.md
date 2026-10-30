# AI 协作规则

## 只在 main 分支修改和提交

- AI 修改仓库文件或提交代码前，必须确认当前分支为 `main`。
- 所有代码、测试和文档修改都在 `main` 分支完成；不得自行创建开发分支或新的 Git 工作树。
- 如果当前不在 `main`，先检查并保护未提交内容，再安全切回 `main`；禁止为切换分支丢弃或覆盖已有改动。
- 其他分支及历史工作树仅用于只读检查和将更新合入 `main`，不得在其中继续编辑或提交代码。
- 只有用户明确要求特定分支或工作树时，才可例外。
- 提交信息使用中文，说明实际修改内容。
- 未经用户明确授权，不推送远程，不发布 Release，不修改版本号。

Avoid unnecessary secondary labels and descriptions.Let the layout do the explaining.
