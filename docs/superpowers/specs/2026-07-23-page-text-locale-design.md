# 页面文本中英兼容改造设计

## 目标与范围

将注册、重新授权与 xAI 流程中“通过页面可见文案定位或判断状态”的逻辑统一改造成中英兼容。浏览器插件自身的节点名称、日志与错误提示继续使用中文，不属于本次国际化范围。

本次只保证简体中文与英文页面；不通过浏览器语言参数强制改变页面语言。

## 现状审计

当前页面文本依赖分散在通用浏览器工具和多个节点中。影响流程控制的中文匹配主要包括：

- `src/core/browser.js`：邮箱输入框提示、注册按钮、继续/提交按钮；
- xAI：`xaiOpenSignupPageNode.js`、`xaiSignInNode.js`、`xaiHelpers.js`、`xaiRefreshOAuthAndLoginNode.js`、`xaiWaitEmailVerificationCodeNode.js`、`xaiFillProfileNode.js`、`xaiWaitRegistrationCompleteNode.js`、`xaiSubmitConsentNode.js`；
- OpenAI/ChatGPT：`openChatGptPhoneFirstNode.js`、`reauthorizeHelpers.js`、`createPasswordNode.js`、`waitEmailVerificationCodeNode.js`、`waitSmsVerificationCodeNode.js`、`addPhoneNumberNode.js`、`phoneFirstAddPhoneNumberNode.js`。

部分现有判断已有英文候选词，但中文与英文都散落在节点内，且错误状态只匹配中文。这会导致英文页面进入错误分支或超时。

## 方案

采用“结构化定位优先、中英文本回退”的两层策略。

1. **结构化定位优先**：保留并优先使用 URL、`data-testid`、`name`、`type`、`input[value]`、表单 `action`、关联 `label` 等不依赖展示语言的特征。
2. **集中化文案回退**：新增核心页面匹配模块，按业务语义导出冻结的中英关键词集合，例如 `signUp`、`primarySubmit`、`emailSignIn`、`phoneContinue`、`allow`、`deny`、`oneTimeCode`、`smsSendFailed`、`whatsAppCode`、`accountCreateFailed` 与 `invalidCode`。
3. **统一规范化**：匹配前统一小写化、压缩空白，并同时读取 `textContent`、`value`、`aria-label`、`title` 与可用的关联标签文本。中文不做大小写转换；英文按小写匹配。
4. **显式排除**：许可动作匹配必须排除“拒绝/取消/不允许”及英文等价词，避免宽泛关键词点击到反向按钮。

## 模块边界与数据流

- 新模块只负责文案定义、文本规范化和“是否命中某一语义”；不执行 DOM 操作。
- `BrowserTabs` 与各节点继续负责 DOM 查询、元素可见性及点击/填写。
- 元素定位顺序固定为：专用选择器或属性 → 元素语义属性 → 语义化中英文本回退 → 失败并保留诊断信息。
- 页面错误状态改为使用相同语义表，不再直接比较中文错误句子。

## 兼容与失败策略

- 页面不含中文或英文任一已知文案时，保留现有超时/失败流程，不猜测按钮含义。
- 多个按钮命中时，沿用现有可见、可点击、精确匹配优先的评分规则，并在允许类操作中强制过滤反向词。
- 文案回退命中时，日志保留命中的实际按钮文本和所用语义，便于后续适配页面变更。

## 验证策略

- 为文本匹配模块添加不依赖浏览器的测试，覆盖中文、英文、空白/大小写规范化与反向许可词过滤。
- 针对通用按钮、xAI 登录/OAuth、OpenAI 手机/邮箱验证各准备最小 DOM 夹具或等价单元测试，验证中英文路径得到相同节点状态。
- 保留现有 URL、`data-testid` 等路径测试，确认结构化定位在文本回退前生效。

## 非目标

- 不新增印地语或其他语言；后续只需向集中语义表增加语言变体。
- 不修改站点交互节奏、账户策略、浏览器指纹或验证码处理。
- 不翻译插件侧边栏、日志、节点显示名及错误消息。
