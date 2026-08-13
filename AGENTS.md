# AGENTS.md — 本工作区协作规则

## 视觉 / 附件处理（必须遵守）

Reasonix 主模型（DeepSeek）**不支持视觉**：用户直接发送图片会触发 provider 400
（`unknown variant image_url`）。桌面端已配置 `UserPromptSubmit` hook
（`.reasonix/hooks/vision-gate.cjs`）自动拦截**仅图片**消息：图片被登记到
`.reasonix/hooks/pending_vision.json`，本轮被阻断（不报 400），等待下一轮处理。
**非图片附件（pdf/docx/xlsx/zip 等）不触发 hook**——先按“纯文本类文件”直接读内容处理，必要时才走豆包。

### 每轮开始必查

收到用户消息后，**第一件事**检查 `.reasonix/hooks/pending_vision.json`：

- 不存在 → 正常处理本条消息。
- 存在且 `consumed == false`：
  1. 读取 `images` 列表（图片绝对路径）。
  2. **先把 `consumed` 置为 `true` 写回文件**（防重复处理）。
  3. 调用 `run_skill({name: "doubao-chat"})`，按其中"视觉/多模态辅助"章节：
     `attach_chat.sh` 复用常驻 doubao 会话 → `fill` 提示 → `run-code setInputFiles`
     上传每张图片 → Enter → 等「朗读」按钮出现 → 提取豆包回答。
  4. **审查/交叉验证**豆包结论（可能不准确/编造），整合后回答用户，
     回答开头注明"已由豆包识别"。
  5. 处理完成：**把 `consumed` 置为 `true` 写回，保留 `pending_vision.json` 文件**。
     不要删除该文件——删除后 120 秒窗口内该附件会再次触发 hook 阻断，导致
     "回复继续"又被拦下。保留 `consumed=true` 记录即可让 hook 放行后续消息。
- 存在但 `consumed == true` → 图片已被处理过，**正常处理本条消息**（不要删除文件，不要重复调豆包）。

### 其他

- 绝不把图片字节/附件内容作为消息直接发给不支持视觉的模型。
- 非图片附件（txt/csv/md/json/log/pdf/docx 等）：先直接读文件内容处理；内容是图像/扫描件时才走豆包识别。
- 豆包输出仅作参考，涉及事实/数据需 Reasonix 交叉验证后呈现。

## 文档驱动开发（必须遵守）

项目已建立文档体系（`docs/`），**后续任何开发必须遵守**：

1. **先读文档再动手**：开发某模块前，先读 `docs/ARCHITECTURE.md` 对应章节 + `docs/modules/<模块>.md`，再读代码。
2. **先改文档后改代码**：任何结构/API/数据流变化，**先更新对应文档再动代码**，文档与代码同一次 commit。
3. **子代理模式**：大改动用子代理 —— 把模块文档摘要 + 具体任务交给子代理（explore 调研 / task 开发），子代理只读目标模块文档与代码；父 agent 收口集成、跑校验（node --check / vue-tsc / build / py_compile）、更新文档、提交。
4. 文档目录：`docs/ARCHITECTURE.md`（总体架构）、`docs/DEVELOPMENT.md`（开发流程契约）、`docs/modules/*.md`（每模块一份）。
5. 文档与代码冲突时**代码优先**，但必须回写修正文档（记入 commit message 或紧随其后的文档 commit）。
