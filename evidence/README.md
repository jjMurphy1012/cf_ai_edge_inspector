# 测试证据与面试口径

这些文件记录 **2026-10-09** 的实际测试，JSON 时间使用 UTC（当日纽约时间为 UTC−4）。测试只访问 `https://example.com` 和无法解析的 `http://`，每次使用新建的临时 room。未部署代码，也未修改共享演示 room。

**本地新代码与原线上部署分开记录。** `harnessSourceRevision` 是测试时本地 Git HEAD（尚未提交修改的基线），不代表线上部署的版本。`deploymentLabel` 区分原线上和本地工作区；本次没有取得线上构建的精确 commit。原始记录不应被后续复测覆盖。

## 可以直接核对的结果

| 文件                                                                                   | 实际结果                                                                                     | 使用边界                                                           |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [local-rules-e2e-final.json](./local-rules-e2e-final.json)                             | 最终本地工作区；Node 22.19.0；8 组检查通过；审计完成 236.92 ms                               | 推荐引用的最终功能回归；使用规则摘要，没有调用真实 AI              |
| [local-rules-benchmark.json](./local-rules-benchmark.json)                             | Node 23.11.0；3/3 通过；原始完成时间 203.42、42.62、48.25 ms；中位数 48.25 ms；P95 203.42 ms | 小样本、本地规则模式；没有预热排除，不能与线上 AI 算性能提升百分比 |
| [local-invalid-url.json](./local-invalid-url.json)                                     | `http://` 返回 `invalid_url`；完成 21.29 ms；重连、追问、Clear 通过                          | 非法输入单独一类，不混入正常网页的延迟分布                         |
| [local-protocol-guards-final.json](./local-protocol-guards-final.json)                 | 5 组协议与数据保护检查通过                                                                   | 包括绕过 UI 的请求、双连接广播、验证器保留已有 room                |
| [live-baseline-smoke.json](./live-baseline-smoke.json)                                 | 原线上单次 7 组检查通过；完成 7915.64 ms                                                     | 独立 smoke，不混入下面的 3 样本统计                                |
| [remote-baseline-benchmark.json](./remote-baseline-benchmark.json)                     | 原线上 3 次尝试：1 次通过，2 次等待 120 秒超时；唯一完成样本 4948.73 ms                      | 必须同时披露两个超时；不能只报“P95 4.95 秒”                        |
| [remote-invalid-url.json](./remote-invalid-url.json)                                   | 原线上非法 URL 路径通过；完成 4902.53 ms                                                     | 与正常网页分开统计                                                 |
| [remote-benchmark-harness-diagnostic.json](./remote-benchmark-harness-diagnostic.json) | 原线上额外 1 次非法 URL 诊断通过；记录了同 ID 的相邻重复 `text-delta`                        | 没有抓取外部源站；用于诊断传输重复，不是正常网页性能样本           |

`local-rules-e2e.json` 是早期本地 smoke（258.78 ms），`local-protocol-guards.json` 是增加已有 room 保护回归之前的 4 项协议检查。保留它们用于追溯，不与最终结果相加算成功率。

## 脚本究竟验证了什么

`validate-live.mjs` 先确认 room 的状态为 idle、无审计结果、无聊天记录，再发送 `Analyze URL`。它直接监听 WebSocket 状态，确认阶段经过 validating、fetching、inspecting、summarizing、persisting、done；非法 URL 只要求经过 validating 和 done。进度数字 5/25/55/80/95/100 是**阶段标记，不是耗时百分比预测**。

在首次收到 running 时，脚本立即发出 Clear RPC；启用 `--check-duplicate-start` 时，也立即发出第二次 start RPC，不等待 Clear 的网络往返。这验证服务端确实拒绝运行中清空和重复启动。极快任务或高网络延迟仍可能缩小检查窗口，因此非法输入测试显式跳过运行中检查，不把“未测到”写成通过。

完成后，脚本读取保存的结果和聊天，断开连接，再建立全新的连接，逐项比较完整审计 JSON 和聊天记录。随后发送追问，确认新增文本答复且 runId 没变。最后 Clear，再用第三个连接确认结果为空、聊天为空、状态恢复 idle。**这证明新连接恢复，不证明服务器重启、Durable Object 被回收或跨区域故障恢复。**

`validate-guards.mjs` 另外验证：

1. 直接发送 `cf_agent_chat_clear` 也会被运行中锁拒绝。
2. 客户端把状态伪造为 idle 会收到 `cf_agent_state_error`；旁观连接仍看到原工作流正常完成。
3. Clear 的聊天清空事件会到达调用者和另一个连接。
4. 验证器遇到已有审计和聊天的 room 会拒绝执行，且原数据不变。

清理操作只允许发生在脚本**已确认原本全空且自己确实开始测试**的 room 中。`cleanup.ownsDisposableRoom` 记录该判断；初始检查失败时不会清空别人的数据。

## 时间指标怎么算

| 字段                     | 起点与终点                                                                           | 不代表什么                                                        |
| ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `auditCompleteMs`        | 客户端发出本次聊天请求 → 收到工作流 complete 状态；使用 `performance.now()` 单调时钟 | 不是 Worker CPU 时间，也不是源站响应时间                          |
| `firstRunningStateMs`    | 同一次请求 → 首次收到 running 状态                                                   | 不是完整审计延迟                                                  |
| `serverAuditWallMs`      | 审计结果里的 `completedAt - startedAt`                                               | 包括等待；不是纯执行时间                                          |
| `originResponseMs`       | 服务端抓取目标网页的响应/正文读取时间，来自审计 metadata                             | 不包括聊天、工作流调度、AI 摘要和前端同步；不是浏览器页面加载速度 |
| `reconnectRecoveryMs`    | 新建连接 → 状态、完整审计、聊天全部核对完成                                          | 不只是 WebSocket 握手耗时                                         |
| `clearAndVerifyMs`       | 发送 Clear → 清空检查和第三次连接检查全部完成                                        | 不只是 SQL DELETE 耗时                                            |
| `initialChatFirstBodyMs` | 聊天发送 → 首个传输 body                                                             | body 可能只是 `start` 事件，不能叫模型首 token 延迟               |

benchmark 默认 3 次、并发 1、样本间隔 1 秒、每次独立 room，最多允许 10 次。它保留所有失败，并在每个样本结束后写文件。完成后追问或清理失败的样本，已获得的完成延迟仍纳入延迟分布；没有完成的样本只记失败，不捏造时间值。

分位数使用 nearest-rank：升序排列后取第 `ceil(p × n)` 个值。这里 `p=0.95`。3 个样本的 P95 就是最大值；只有 1 个完成样本时任何分位数都等于那个值，几乎不能说明尾延迟。中位数也使用同一约定。

**3/3 测试通过率不是 100% 线上可用率；1/3 通过也不是长期 33% 可用率。** `partial` 是“网页有配置问题”的审计结果，工作流可以正常完成且测试通过。缺少 HSTS 等响应头也不等于已经证明存在可利用漏洞。

## 失败没有被删掉

线上 benchmark 的前两次尝试在 120 秒内没有收到 running 或聊天 body，只观察到初始 idle；当前证据不能确定根因。失败清理 RPC 成功后，又只读/清理复核了这两个临时 room，均为 idle、结果为空、聊天 0 条，详见 [remote-timeout-cleanup.json](./remote-timeout-cleanup.json)。原来的超时结果没有改为通过。

最初协议测试错误地期待收到服务端内部异常文本，实际 SDK 返回通用的 `State update rejected`。这是**测试断言问题**；修正断言后通过。首次输出保留在 [local-protocol-guards-initial-harness-failure.json](./local-protocol-guards-initial-harness-failure.json)，其临时 room 后续清理记录保留在 [local-protocol-harness-cleanup.json](./local-protocol-harness-cleanup.json)。

原线上还出现了重复增量文本和摘要末尾异常内容。原始文本在证据中保留。新代码对 AI 流的兼容处理有单元测试；本次本地最终 E2E 使用 `summarySource=rules`，因此**不能声称已经通过真实 Workers AI 验证了修复，也不能声称线上已经更新**。

## 复现命令

使用 Node 22.19.0 或更高版本。最终 E2E 客户端确实在 Node 22.19.0 下运行，记录见 JSON 的 `runtime`。在第一个终端启动本地服务：

```bash
npm ci
npm run dev:demo -- --port 5173
```

在另一个终端执行。下面使用新输出文件名，避免覆盖原始证据：

```bash
npm test
npm run check
npm run build

node scripts/validate-live.mjs https://example.com \
  --host 127.0.0.1:5173 --protocol ws \
  --check-duplicate-start --deployment-label local-rules-recheck \
  --output evidence/recheck-local-e2e.json

node scripts/benchmark.mjs https://example.com --samples 3 \
  --host 127.0.0.1:5173 --protocol ws \
  --check-duplicate-start --deployment-label local-rules-recheck \
  --output evidence/recheck-local-benchmark.json

node scripts/validate-live.mjs http:// \
  --host 127.0.0.1:5173 --protocol ws \
  --expect-status invalid_url --skip-running-guard \
  --deployment-label local-rules-recheck \
  --output evidence/recheck-local-invalid.json

node scripts/validate-guards.mjs \
  --host 127.0.0.1:5173 --protocol ws \
  --deployment-label local-rules-recheck \
  --output evidence/recheck-local-guards.json
```

`dev:demo` 使用真实本地 Workers/Workflow/Durable Object 运行时和规则摘要，不要求 Cloudflare 登录，也不调用远程 AI。审计公开 URL 仍需要互联网；注入模拟 fetch 的纯函数单元测试才可离线运行。

要重新验证现有线上部署，可显式指定 host；是否已部署新代码必须另外确认，不要默认打开重复启动的新 RPC 检查：

```bash
node scripts/validate-live.mjs https://example.com \
  --host cf-ai-edge-inspector.zheng-jiaju.workers.dev --protocol wss \
  --deployment-label existing-live-recheck \
  --output evidence/recheck-remote-e2e.json
```

## 面试中怎么说

“我把网页抓取、确定性检查、摘要、持久化分成几个步骤，通过 WebSocket 看到进度。为了证明它能工作，我在新 room 里跑端到端测试：运行中不允许 Clear 或重复启动；断开后重新连接能拿到同一个结果和聊天；Clear 以后再次连接确认数据真的清空。”

“数字来自脚本的原始时间记录，不是估算。我把源站抓取时间和用户等待整个审计的时间分开，也把本地规则模式与线上 AI 模式分开。3 次本地小样本的完成时间是 203.42、42.62、48.25 毫秒；它只能说明那次演示测试。线上原版本同批 3 次里有 2 次超时，我保留了失败，所以不会用一个成功样本包装成稳定性或生产 SLA。”

“如果要证明提升 25%，我还需要固定测试环境、模型、目标集合和并发数，分别测修改前后足够多的样本，说明预热、超时和失败处理，再用同一指标算 `(修改前 - 修改后) / 修改前`。本次证据还不能支持这个结论。”

## 静态检查与依赖状态

最终 Node 22.19.0 下 `npm run check`（格式、lint、TypeScript）、`npm test`、`npm run build` 均通过。**64 项测试**包括审计核心 32、意图路由 22、AI 流兼容 6、计量工具 4；测试项数量不是代码覆盖率。构建仍提示客户端某个 chunk 大于 500 kB，未进行首屏体积优化。

`npm audit` 对全部锁定依赖（含开发工具）报告 **37 项**：8 low、10 moderate、16 high、3 critical。它不等于已证明应用存在 37 条可利用路径，但也不能说依赖安全检查已通过。自动非强制修复被 Wrangler 与 Workers types 版本冲突阻止，本轮没有强制降级或进行未经回归的大版本升级。证据为 [dependency-audit-summary.json](./dependency-audit-summary.json)。后续需要单独做 SDK、工具链与间接依赖的一致性升级和回归。
