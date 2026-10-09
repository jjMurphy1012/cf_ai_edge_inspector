import assert from "node:assert/strict";
import test from "node:test";
import { streamText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { withNormalizedAiStreaming } from "../src/ai-stream.ts";

function bindingFor(events, fragmentSize = 7) {
  return {
    async run() {
      const bytes = new TextEncoder().encode(
        `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`
      );
      return new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += fragmentSize) {
            controller.enqueue(bytes.slice(offset, offset + fragmentSize));
          }
          controller.close();
        }
      });
    }
  };
}

async function generate(events, normalize = true, fragmentSize = 7) {
  const binding = bindingFor(events, fragmentSize);
  const provider = createWorkersAI({
    binding: normalize ? withNormalizedAiStreaming(binding) : binding
  });
  return await streamText({
    model: provider("@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
    prompt: "Test only; no remote model is invoked."
  }).text;
}

test("the locked provider reproduces duplicate text for dual-format SSE", async () => {
  assert.equal(
    await generate(
      [{ response: "To", choices: [{ delta: { content: "To" } }] }],
      false
    ),
    "ToTo"
  );
});

test("matching fields in one event produce exactly one delta", async () => {
  assert.equal(
    await generate([
      { response: "To", choices: [{ delta: { content: "To" } }] },
      {
        response: " prioritize",
        choices: [{ delta: { content: " prioritize" } }]
      }
    ]),
    "To prioritize"
  );
});

test("legitimate repeated text in separate events is preserved", async () => {
  assert.equal(
    await generate([
      { response: "very ", choices: [{ delta: { content: "very " } }] },
      { response: "very ", choices: [{ delta: { content: "very " } }] },
      { response: "fast", choices: [{ delta: { content: "fast" } }] }
    ]),
    "very very fast"
  );
});

test("native-only and OpenAI-only events preserve original text", async () => {
  assert.equal(
    await generate([
      { response: "native " },
      { choices: [{ delta: { content: "openai" } }] }
    ]),
    "native openai"
  );
});

test("different fields in one event are never guessed to be duplicates", async () => {
  assert.equal(
    await generate([
      { response: "one", choices: [{ delta: { content: "two" } }] }
    ]),
    "onetwo"
  );
});

test("single-byte fragments preserve multibyte Chinese text", async () => {
  assert.equal(
    await generate(
      [{ response: "你好", choices: [{ delta: { content: "你好" } }] }],
      true,
      1
    ),
    "你好"
  );
});
