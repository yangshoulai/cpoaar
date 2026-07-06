# Auto Register Chrome Plugin

这是 `auto-register` 的 Chrome MV3 插件实验版，代码与 Python 项目解耦，可以单独拷贝成新仓库。

## 当前能力

- 使用 Chrome Side Panel 作为运行面板。
- 支持表单化分组配置，配置修改后自动保存。
- 支持 JSON 配置文件导入、导出。
- 展示注册节点流转、当前节点、节点结果和运行日志。
- 支持浅色和深色主题。
- 支持从头开始、继续执行、停止、手动重试当前节点。
- 注册流程包含“启动初始化”节点，会清理 `chatgpt.com`、`openai.com`、`auth.openai.com` 的 Cookie，并关闭相关标签页。
- 使用 Chrome 原生 Tab 和 Scripting API 操作页面 DOM。
- 支持 OutlookMail 邮箱服务、CPA 账号服务、HeroSMS、SMSBower、短信手动模式。
- Outlook 邮箱池分组支持从 OutlookMail 服务刷新后下拉选择。
- HeroSMS 和 SMSBower 国家列表已内置，国家选择支持过滤。
- 使用 IndexedDB 保存短信激活记录，用于本地手机号复用。
- 支持在注册流程结束后清理短信激活历史，本地清理和远程取消失败只记录日志，不影响流程结果。

## 加载方式

1. 打开 Chrome 扩展管理页：`chrome://extensions/`
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择当前目录：`chrome_plugin`
5. 点击插件图标打开 Side Panel。

## 运行说明

1. 在“插件配置”里按分组填写配置，或者直接导入 JSON 配置文件。
2. 配置修改后会立即自动保存，不需要点击保存按钮。
3. 点击“从头开始”启动完整流程。
4. 如果流程中断，重新打开面板后点击“继续执行”。
5. 如果某个节点失败，可以点击“重试当前节点”。插件会尽量跳回该节点开始时记录的浏览器地址后重新执行。

## 重要差异

- 插件版不启动本地 `1455` HTTP 服务。OAuth 跳转到 `http://localhost:1455/...` 即使页面打不开，插件也会通过 Chrome Tabs API 读取最终地址并提交给 CPA。
- 插件版不按请求设置 HTTP 代理。代理使用你本机 Chrome 的全局代理配置。
- 本地短信激活池使用 IndexedDB，不使用 Python 版 SQLite。

## 目录结构

```text
chrome_plugin/
  manifest.json
  src/background.js
  src/core/        # 配置、HTTP、日志、Tab 控制、流程执行器
  src/services/    # OutlookMail、CPA、HeroSMS、SMSBower、手动短信、IndexedDB 激活池
  src/nodes/       # 注册流程节点
  src/flow/        # 注册流程组装
  src/ui/          # Side Panel 页面
```
