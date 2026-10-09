# AI Edge Inspector 面试说明与复现指南

本项目检查一个公开 URL 的 HTTP 响应，由规则产生问题清单，再由 Workers AI 解释。它不是递归爬虫、浏览器性能测试，也不能据此宣称网站没有漏洞。阅读本说明时，以本次代码与 `evidence/` 中的原始 JSON 为证据。

## 可以替换到简历的描述

- 基于 React、TypeScript 与 Cloudflare Workflows 实现 5 阶段网站审计，覆盖 6 类响应头、2 类 HTML 元数据和实际访问路径的 HTTPS／重定向检查，通过 WebSocket 同步进度与结构化结果。
- 将确定性规则与 Workers AI 摘要分离，为抓取设置 8 秒整体超时和 1 MiB HTML 读取上限，以 Zod 校验摘要结构；模型异常、超时或输出不合规时保留规则报告，并记录摘要来源与降级原因。
- 使用 Durable Objects／SQLite 保存审计历史与聊天，支持断线重连及基于历史追问；统一清理聊天、结果和同步状态，拒绝运行中清空与重复启动，补充规则回归测试和真实 WebSocket 端到端验证。

本次在 Node 22.19.0 下通过 64 项回归测试：审计核心 32、意图路由 22、AI 流兼容 6、计量工具 4。完整结果与实测时间见 `evidence/README.md`，不要把测试数量说成覆盖率，也不要把单次抓取时间说成整份 AI 报告的耗时。

## 一次请求具体怎么走

1. `src/app.tsx` 中的 React 页面通过 `useAgent`／`useAgentChat` 连接一个会话。未指定 `?room=` 时使用浏览器保存的随机会话 ID；同一显式 room 能重访，但 room 不是登录权限。
2. `src/chat-routing.ts` 识别“发起审计”“看历史”“看最新结果”“比较”与追问。单独 URL 或明确的 Analyze／Audit 才触发新任务，避免问句里提到 URL 就重新扫描。
3. `AuditAgent.startAudit()` 先同步把状态置为 running 并生成 runId，再异步启动 Workflow。这样第二个标签页在第一个任务启动尚未返回时也会被拒绝。启动失败会恢复为 error。
4. `WebsiteAuditWorkflow` 依次更新 validating、fetching、inspecting、summarizing、persisting。进度 5／25／55／80／95 是预设阶段标记，不是 CPU 用量、耗时比例或完成度预测。
5. `normalizeUrl()` 补齐裸域名的 https，拒绝非法协议、带凭据地址及常见内网字面量；每次跳转都再校验目标。
6. `fetchHomepageSnapshot()` 获取真实响应，最多跟随 5 次重定向，总预算 8 秒；只读最多 1 MiB 的 HTML，并保存终点 URL、状态码、响应头、标题和描述。非 HTML 不执行 HTML 元数据缺失判断。
7. `buildAuditDraft()` 根据事实生成 findings、严重性及规则建议。请求失败不等于服务器缺少响应头；被拦截或错误页也不能当成成功主页。
8. Workflow 的 `generate-ai-summary` 步骤用 `generateObject()` 回调把已有事实交给模型。`summarizeWithFallback()` 保证 Zod 校验失败、异常或 20 秒摘要超时仍有规则摘要。模型不能改变 findings。
9. `step.reportComplete()` 将结果回传 `AuditAgent.onWorkflowComplete()`。服务端校验 runId 后，以 run_id 主键 INSERT OR REPLACE 写入 SQLite，再广播 complete 状态。重复写同一 run_id 不增加历史条数。
10. 新连接重新读取已存结果；追问使用该结果，不重新请求目标站。Clear 同步清审计表和状态，并调用 SDK 的聊天清理处理器，使内存缓存和其他连接也一致。

## 6 类响应头与 2 类元数据

| 检查项                    | 用大白话解释                 | 能证明什么                              |
| ------------------------- | ---------------------------- | --------------------------------------- |
| Strict-Transport-Security | 告诉浏览器之后优先用 HTTPS   | 本次响应是否提供 HSTS，不代表策略值正确 |
| Content-Security-Policy   | 限制脚本、资源及嵌入来源     | 是否提供 CSP，不是验证所有规则安全      |
| X-Frame-Options           | 限制页面被 iframe 嵌入       | 缺少时同时识别 CSP frame-ancestors 替代 |
| X-Content-Type-Options    | 防止浏览器擅自猜 MIME 类型   | 是否出现该头，不是完整值校验            |
| Referrer-Policy           | 控制跳转时泄露多少来源 URL   | 是否存在该头                            |
| Cache-Control             | 明确浏览器／缓存如何存放响应 | 是否提供缓存指令，不证明缓存命中率      |
| title                     | 浏览器标签页和搜索结果标题   | 原始 HTML 中能否提取标题                |
| meta description          | 页面简介                     | 原始 HTML 中能否提取描述                |

6 类响应头是 5 类安全相关头加 1 类缓存头，不应说成 6 类安全头。请求的是原始 HTML，没有运行网页 JavaScript。1 MiB 后的内容未检查，因此达到上限时标注截断，不把没读到的元数据直接判定为缺失。

## 怎样产生和验证数字

- **5 阶段**：来自 workflow 的业务状态序列。有效 URL 应观察到这 5 个阶段，非法 URL 会提前结束；不等于恰好 5 个 `step.do()` 调用。
- **6 与 2**：逐个核对规则表，并用构造响应分别删除每个字段，断言产生相应 finding。数的是检查类别，不是每次必定发现 8 个问题。
- **8 秒**：`FETCH_TIMEOUT_MS = 8000`。定时器配合 AbortController 取消抓取，`Promise.race` 使调用方及时获得超时结果。预算包含跳转、响应和受限 HTML 读取，不含后续模型摘要。
- **20 秒**：单独的 AI 摘要截止时间，和抓取超时分别管理。请求取消信号传给 AI SDK，禁用自动重试，异常时走规则降级。
- **responseTimeMs**：Worker 侧抓取开始到受限读取完成的时间差，含跳转。不是 TTFB、LCP、浏览器加载时长或用户端完整响应时间。
- **auditCompleteMs**：测试客户端发送启动聊天帧到收到 complete 状态的单调时钟差。包括通信、Workflow、规则和摘要流程；不含后续重连、追问和 Clear。
- **通过比例**：完成所有端到端断言的样本数／尝试样本总数。blocked、partial 等是被审计站点的结果状态，不能与脚本是否通过混为一谈。
- **p50／p95**：升序排序后取第 `ceil(p × n)` 个元素（从 1 开始）。3 个样本的 p95 就是最大值，不能支持长期尾延迟或可用性结论。
- **降级率**：只对包含 summarySource 的版本计算 rules 次数／有来源记录次数。旧版没有字段时为 unknown，不能强行按 AI 成功计数。本地 rules-only 是主动禁用 AI，不能作为 AI 故障率样本。

`scripts/validate-live.mjs` 将断言结果、时间线、runId、目标、主机、代码版本信息写入 JSON。`scripts/benchmark.mjs` 串行重复该脚本，保留失败；禁止从最终报告中删掉慢请求或失败来美化结果。线上旧部署与本地新版本不同环境、不同 AI 路径，不能据此计算“优化了百分之多少”。

## 测试怎么组织

纯规则测试注入 fetch 和 AI 回调，不需要外网、密钥或 Cloudflare 登录。输入合法／非法 URL、返回完整／缺字段 HTML、模拟跳转、403／429、超时、超大 HTML 与错误模型 JSON，然后断言输出状态和 finding。

端到端测试使用真实 AgentClient、WebSocket、Workflow 和 SQLite：发起审计，观察进度，运行中尝试 Clear 和再次启动并确认被拒绝；关闭连接重连，确认 runId 和聊天仍在；追问并确认没有新审计；Clear 后再建第三个连接确认状态、聊天、数据库均为空。

`npm run check` 检查格式、lint 和 TypeScript，`npm test` 检查逻辑，`npm run build` 检查可打包。构建成功不代表线上部署成功；真实本地 E2E 也不证明云端模型已验证。

## 本次逐步改动

1. 对照简历数字阅读原始 workflow、Agent、前端和验证脚本，记录原代码可做的事情。
2. 运行原有检查和线上独立测试会话，保存原版本证据。
3. 抽出 audit-core 纯模块，让抓取边界、规则判断、模型输出检查可以独立测试。
4. 修正错误协议解析、超时错误识别、抓取失败后的误报、非 HTML 判断和无上限读取。
5. 增加每跳 URL 检查、抓取上限、模型超时及摘要来源，明确规则降级路径。
6. 在启动工作流前占用运行槽位，按 runId 接受完成回调，防止重复提交和过期回调污染状态。
7. 使用 SDK 清理入口统一聊天缓存／消息与业务状态，阻止原生 Clear 帧绕过运行中限制。
8. 添加可离线调用模型替代逻辑的本地 rules 演示模式，实际网络抓取仍发生；演示模式只作用于 dev，不修改生产 build。
9. 添加确定性测试、端到端断言及原始指标文件，在 CI 固定 Node 22.19.0 并使用 npm ci、check、test、build。
10. 用模拟双格式 SSE 事件重现锁定 provider 的重复输出，在同一事件两个字段完全相等时仅保留一个，保留跨事件的合法重复词；该兼容修复经过本地测试，未证明是线上重复文本的唯一根因。
11. 独立复核修正网址路径含 history 等词时被误识别为命令的问题，保护已有会话不被验证器失败清理，并补齐恶意未闭合 HTML 的边界测试。
12. 根据验证结果改写简历和面试稿；未验证的新版本云端 AI 路径与依赖告警明确保留为限制。

## 面试一分钟说法

“我做的是一个 Cloudflare 上的网站响应审计工具。用户贴一个 URL，Agent 启动 Workflow，经过校验、抓取、规则检查、摘要和保存五个阶段。规则检查六类响应头和标题、描述两类元数据，WebSocket 把进度推到页面。AI 只解释已有结果；抓取有八秒预算，摘要做 Zod 校验并有独立超时，失败时仍返回规则报告。Durable Object 按会话保存进度，SQLite 保存历史，用户断线回来可以继续追问。我特别处理了运行中清空与重复启动的一致性问题，并用重连、追问、Clear 后第三次连接来验证。”

## 高频追问

**为什么不用一个同步接口做完？** 一次请求等待网络和模型容易拖长。Workflow 把步骤和完成回调管理起来，前端断线后后台任务仍能推进；DO 管会话状态，WebSocket负责通知。当前只是小范围演示，不能据此声称做过大规模并发压测。

**Durable Object、SQLite、Workflow 各管什么？** DO 是每个会话的服务端对象，负责状态和串行入口；SQLite 是放在对象里的持久存储；Workflow 执行跨步骤工作。断开 WebSocket 只是断开通信，不等于清空数据库。

**为什么 Zod 通过还可能不准确？** Zod 只检查字符串、数组和长度等结构，不能判断事实。检测结果由确定性规则产生，模型只看这些事实；仍需要人工对齐摘要语义。不能说 schema 消除了幻觉。

**为什么不能运行中 Clear？** 如果刚删完记录，旧 Workflow 随后回调，就会把“已清空”的数据写回来。当前实现直接拒绝运行中清空；要支持取消，需要取消工作流、会话版本号与旧回调屏蔽共同设计。

**8 秒内一定返回吗？** 不是。8 秒是页面抓取预算，完整链路还有调度、规则、AI、保存和网络通信；本地定时器也有调度误差。

**为什么不说 HTTPS 强制跳转已经验证？** 只输入 https:// 时只能知道这条 HTTPS 路径。若要观察 HTTP→HTTPS，要从 http:// 发起。当前不会为了每个 HTTPS URL 再自动发一次 HTTP 探测。

**你怎么保证数字可信？** 把规格、单元测试与实测分开。实测保留目标、版本、运行环境、全部样本及失败，并清楚定义开始／结束点。相同条件重跑才谈性能对比。

## 重点学习顺序

1. HTTP 状态码、跳转、响应头、TLS／HTTPS、HSTS。能解释拿到 403 为什么不能说网站缺少所有头。
2. async／await、AbortController、Promise.race、ReadableStream。能解释超时取消与只限制返回时间的区别。
3. 状态机和并发交错。能画出 idle→running→complete／error，并解释为何要先占槽再 await。
4. WebSocket、DO 和 SQLite 的边界。能区分连接、内存状态、数据库记录；理解 run_id 主键的幂等写入。
5. Zod、模型输出结构化、降级、prompt 中的不可信网页数据。能分别模拟异常、超时和错误 JSON。
6. 实验设计、p50／p95、样本量、故障分母、客户端／服务端计时。能现场打开 JSON 算出同样结果。

## 复现与边界

```bash
npm ci
npm run check
npm test
npm run build
npm run dev:demo
# 另一个终端，使用启动输出中的实际端口
node scripts/validate-live.mjs https://example.com --host 127.0.0.1:5173 --protocol ws --check-duplicate-start --output evidence/my-local-e2e.json
node scripts/benchmark.mjs https://example.com --samples 3 --host 127.0.0.1:5173 --protocol ws --output evidence/my-local-benchmark.json
```

使用真实 Workers AI：`npx wrangler login` 后执行 `npm run dev`；发布执行 `npm run deploy`。本次机器上的 Cloudflare 登录已失效，因此最新代码的云端部署和真实模型集成需要重新登录后补测。源码构建保持生产 AI binding，dev:demo 明确采用规则摘要。

room 名称不是鉴权。本项目仍为公开演示工具，没有用户登录、租户权限与完整速率限制；默认随机 room 降低意外串会话风险，不构成安全隔离。URL 校验拦截常见内网字面量，不提供 DNS rebinding 防护。SQLite 侧只展示最近 5 条并不等于总存储只保留 5 条。依赖审计仍有 37 项告警（含开发工具）；自动修复受版本冲突阻止，需另做配套升级。详情见 evidence/README.md，不将本次成果表述为生产安全认证。

## 参考资料

- [Cloudflare Workflows Workers API](https://developers.cloudflare.com/workflows/build/workers-api/)
- [Cloudflare Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Cloudflare Vite Plugin API](https://developers.cloudflare.com/workers/vite-plugin/reference/api/)
- [Workers AI Bindings](https://developers.cloudflare.com/workers-ai/configuration/bindings/)

API 用法同时与仓库锁定依赖的类型和实现核对；文档最新版不等于本项目的依赖版本。
