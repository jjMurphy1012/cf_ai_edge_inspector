/**
 * workers-ai-provider 3.1.10 reads both native `response` and OpenAI
 * `choices[0].delta.content`. Some responses carry the same delta in both.
 * Prefer the OpenAI field only when they match in the SAME SSE event. Never
 * deduplicate adjacent tokens: repeated words can be legitimate model output.
 */
export function normalizeAiStream(source: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  function normalizeLine(line: string) {
    if (!line.startsWith("data:")) return line;
    try {
      const payload = JSON.parse(line.slice(5).trim());
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && payload.response === delta) {
        delete payload.response;
        return `data: ${JSON.stringify(payload)}`;
      }
    } catch {
      // Comments, [DONE] and malformed events are left to the provider parser.
    }
    return line;
  }
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines)
          controller.enqueue(encoder.encode(`${normalizeLine(line)}\n`));
      },
      flush(controller) {
        pending += decoder.decode();
        if (pending) controller.enqueue(encoder.encode(normalizeLine(pending)));
      }
    })
  );
}

export function withNormalizedAiStreaming(binding: Env["AI"]): Env["AI"] {
  return new Proxy(binding, {
    get(target, property) {
      if (property === "run")
        return async (...args: unknown[]) => {
          const result = await Reflect.apply(target.run, target, args);
          if (result instanceof ReadableStream)
            return normalizeAiStream(result);
          if (
            result instanceof Response &&
            result.body &&
            result.headers.get("content-type")?.includes("text/event-stream")
          ) {
            return new Response(normalizeAiStream(result.body), result);
          }
          return result;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
