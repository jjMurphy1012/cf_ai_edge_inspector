import assert from "node:assert/strict";
import test from "node:test";
import { classifyIntent } from "../src/chat-routing.ts";

const starts = [
  ["https://example.com", "https://example.com"],
  ["example.com", "example.com"],
  ["https://example.com/history", "https://example.com/history"],
  ["example.com/summary", "example.com/summary"],
  ["https://history.com/compare", "https://history.com/compare"],
  ["Analyze example.com", "example.com"],
  [
    "Please audit https://example.com/path?q=value",
    "https://example.com/path?q=value"
  ],
  ["Inspect (https://example.com).", "https://example.com"],
  ["请分析 https://example.com", "https://example.com"],
  ["Analyze not-a-valid-host", "not-a-valid-host"],
  ["ftp://example.com", "ftp://example.com"]
];
for (const [text, url] of starts) {
  test(`an explicit audit target is routed to the validator: ${text}`, () => {
    assert.deepEqual(classifyIntent(text), { kind: "start_audit", url });
  });
}

const questions = [
  ["Why does https://example.com have this finding?", "follow_up"],
  ["What should I fix first on example.com?", "follow_up"],
  ["Check the security headers", "follow_up"],
  ["Review the saved result", "follow_up"],
  ["Compare https://example.com with my previous scan", "compare"],
  ["Show recent audits for example.com", "history"],
  ["Show latest result for https://example.com", "latest"],
  ["和上次的结果比较", "compare"],
  ["查看历史记录", "history"],
  ["显示最新结果", "latest"],
  ["  ", "empty"]
];
for (const [text, kind] of questions) {
  test(`a saved-result question does not launch an unwanted audit: ${text}`, () => {
    assert.deepEqual(classifyIntent(text), { kind });
  });
}
