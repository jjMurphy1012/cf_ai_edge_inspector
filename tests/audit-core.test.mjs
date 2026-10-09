import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  MAX_HTML_BYTES,
  MAX_REDIRECTS,
  buildAuditDraft,
  createInvalidUrlResult,
  extractMetaDescription,
  extractTitle,
  fetchHomepageSnapshot,
  normalizeUrl,
  summarizeWithFallback,
  summarySchema
} from "../src/audit-core.ts";

const URL = "https://example.com/";
const startedAt = "2026-10-09T12:00:00.000Z";
const healthyHeaders = {
  "content-type": "text/html; charset=utf-8",
  "strict-transport-security": "max-age=31536000",
  "content-security-policy": "default-src 'self'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cache-control": "public, max-age=60"
};
const html =
  '<title>Example</title><meta name="description" content="A test page">';

function response(body = html, overrides = {}) {
  return new Response(body, { headers: healthyHeaders, ...overrides });
}

async function fixture(body = html, overrides = {}) {
  return fetchHomepageSnapshot(URL, {
    fetchImpl: async () => response(body, overrides)
  });
}

function draft(snapshot) {
  return buildAuditDraft(URL, URL, startedAt, snapshot);
}

function ids(result) {
  return result.findings.map((finding) => finding.id);
}

test("normalization preserves paths/query, defaults to HTTPS, strips fragments", () => {
  assert.deepEqual(normalizeUrl(" example.com/a?q=1#section "), {
    ok: true,
    normalizedUrl: "https://example.com/a?q=1"
  });
  assert.deepEqual(normalizeUrl("http://EXAMPLE.com:80/a"), {
    ok: true,
    normalizedUrl: "http://example.com/a"
  });
  assert.equal(normalizeUrl("example.com:8443/a").ok, true);
  assert.equal(normalizeUrl("https://8.8.8.8/").ok, true);
  assert.equal(normalizeUrl("https://[2606:4700:4700::1111]/").ok, true);
});

test("invalid schemes and malformed input are not rewritten into public URLs", () => {
  for (const input of [
    "",
    "   ",
    "ftp://example.com",
    "javascript:alert(1)",
    "http:/example.com",
    "https:",
    "not a URL",
    "https://example.com/a b",
    "https://user:password@example.com",
    "https://example.com\\@localhost"
  ]) {
    assert.equal(normalizeUrl(input).ok, false, input);
  }
});

test("literal localhost/private addresses and local names are rejected", () => {
  for (const host of [
    "localhost",
    "foo.localhost",
    "intranet",
    "foo.internal",
    "foo.local",
    "127.0.0.1",
    "2130706433",
    "0x7f000001",
    "10.0.0.1",
    "172.16.2.3",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "[::1]",
    "[::ffff:127.0.0.1]",
    "[fc00::1]"
  ]) {
    assert.equal(normalizeUrl(`http://${host}/`).ok, false, host);
  }
});

test("healthy HTML captures six headers, two metadata values, and fetch duration", async () => {
  let calls = 0;
  const times = [100, 145];
  const snapshot = await fetchHomepageSnapshot(URL, {
    now: () => times.shift(),
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, URL);
      assert.equal(options.redirect, "manual");
      assert.ok(options.signal instanceof AbortSignal);
      return response();
    }
  });
  assert.equal(calls, 1);
  assert.equal(snapshot.responseTimeMs, 45);
  assert.equal(snapshot.title, "Example");
  assert.equal(snapshot.metaDescription, "A test page");
  assert.equal(Object.values(snapshot.headers).filter(Boolean).length, 6);
  assert.equal(snapshot.redirected, false);
  assert.equal(snapshot.htmlBytes, new TextEncoder().encode(html).byteLength);
  assert.equal(snapshot.htmlTruncated, false);
  assert.equal(draft(snapshot).status, "success");
  assert.deepEqual(ids(draft(snapshot)), []);
});

test("each missing header produces its own expected rule and severity", async () => {
  const cases = [
    ["strict-transport-security", "missing-hsts", "medium", "partial"],
    ["content-security-policy", "missing-csp", "medium", "partial"],
    ["x-frame-options", "missing-x-frame-options", "low", "success"],
    [
      "x-content-type-options",
      "missing-x-content-type-options",
      "low",
      "success"
    ],
    ["referrer-policy", "missing-referrer-policy", "low", "success"],
    ["cache-control", "missing-cache-control", "medium", "partial"]
  ];
  for (const [header, expectedId, severity, status] of cases) {
    const headers = { ...healthyHeaders };
    delete headers[header];
    const result = draft(await fixture(html, { headers }));
    assert.deepEqual(ids(result), [expectedId], header);
    assert.equal(result.findings[0].severity, severity);
    assert.equal(result.status, status);
  }
});

test("CSP frame-ancestors is accepted as the X-Frame-Options alternative", async () => {
  const headers = {
    ...healthyHeaders,
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'"
  };
  delete headers["x-frame-options"];
  assert.deepEqual(ids(draft(await fixture(html, { headers }))), []);
});

test("a reachable HTML page missing all configured fields emits exactly eight checks", async () => {
  const result = draft(
    await fixture("<html></html>", {
      headers: { "content-type": "text/html" }
    })
  );
  assert.deepEqual(ids(result), [
    "missing-hsts",
    "missing-csp",
    "missing-x-frame-options",
    "missing-x-content-type-options",
    "missing-referrer-policy",
    "missing-cache-control",
    "missing-title",
    "missing-meta-description"
  ]);
  assert.equal(result.status, "partial");
  assert.equal(result.fallbackRecommendations.length, 3);
  assert.match(result.fallbackRecommendations[2], /Cache-Control/);
  assert.equal(
    summarySchema.safeParse({
      summary: result.fallbackSummary,
      recommendations: result.fallbackRecommendations
    }).success,
    true
  );
});

test("title and description checks are independent", async () => {
  const withoutTitle = draft(
    await fixture('<meta name=description content="Description">')
  );
  assert.deepEqual(ids(withoutTitle), ["missing-title"]);
  const withoutDescription = draft(await fixture("<title>Title</title>"));
  assert.deepEqual(ids(withoutDescription), ["missing-meta-description"]);
});

test("static metadata handles case, whitespace, attribute order and entities", () => {
  assert.equal(
    extractTitle("<TITLE>A &amp; B &#x4E2D;&#25991;</TITLE>"),
    "A & B 中文"
  );
  assert.equal(
    extractMetaDescription(
      '<META CONTENT = "It\'s &quot;fine&quot;" NAME = "Description">'
    ),
    'It\'s "fine"'
  );
  assert.equal(
    extractMetaDescription("<meta name=description content=plain>"),
    "plain"
  );
  assert.equal(
    extractMetaDescription('<meta name="description" content="a > b">'),
    "a > b"
  );
});

test("commented-out tags and script strings are not metadata evidence", () => {
  const fake =
    '<!-- <title>Fake</title><meta name="description" content="Fake"> -->' +
    '<script>const x = "<title>Wrong</title>";</script>';
  assert.equal(extractTitle(fake), null);
  assert.equal(extractMetaDescription(fake), null);
  assert.equal(extractTitle(fake + "<title>Real</title>"), "Real");
});

test("HTTP-to-HTTPS and relative redirects are counted and inspected at final destination", async () => {
  const visited = [];
  const snapshot = await fetchHomepageSnapshot("http://example.com/", {
    fetchImpl: async (url) => {
      visited.push(url);
      if (visited.length === 1)
        return response(null, {
          status: 301,
          headers: { location: "https://example.com/start" }
        });
      if (visited.length === 2)
        return response(null, { status: 302, headers: { location: "/final" } });
      return response();
    }
  });
  assert.deepEqual(visited, [
    "http://example.com/",
    "https://example.com/start",
    "https://example.com/final"
  ]);
  assert.equal(snapshot.finalUrl, "https://example.com/final");
  assert.equal(snapshot.redirectCount, 2);
  assert.deepEqual(ids(draft(snapshot)), ["redirect-detected"]);
});

test("an HTTP final response produces a transport finding", async () => {
  const snapshot = await fetchHomepageSnapshot("http://example.com/", {
    fetchImpl: async () => response()
  });
  const result = buildAuditDraft(
    "http://example.com/",
    "http://example.com/",
    startedAt,
    snapshot
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(ids(result), ["https-not-enforced"]);
});

test("redirects to private destinations are rejected before sending another request", async () => {
  let calls = 0;
  const snapshot = await fetchHomepageSnapshot(URL, {
    fetchImpl: async () => {
      calls += 1;
      return response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" }
      });
    }
  });
  assert.equal(calls, 1);
  assert.match(snapshot.error, /public/);
  assert.deepEqual(ids(draft(snapshot)), ["site-unreachable"]);
});

test("redirect loops stop at the configured hop limit", async () => {
  let calls = 0;
  const snapshot = await fetchHomepageSnapshot(URL, {
    fetchImpl: async () => {
      calls += 1;
      return response(null, { status: 302, headers: { location: URL } });
    }
  });
  assert.equal(calls, MAX_REDIRECTS + 1);
  assert.equal(snapshot.redirectCount, MAX_REDIRECTS);
  assert.match(snapshot.error, /exceeded 5 redirects/);
});

test("a network failure reports unreachable without fabricated missing fields", async () => {
  const snapshot = await fetchHomepageSnapshot(URL, {
    fetchImpl: async () => {
      throw new Error("DNS lookup failed");
    }
  });
  const result = draft(snapshot);
  assert.equal(result.status, "unreachable");
  assert.deepEqual(ids(result), ["site-unreachable"]);
  assert.equal(snapshot.error, "DNS lookup failed");
});

test("403 and 429 responses report blocked without auditing a challenge page", async () => {
  for (const status of [403, 429]) {
    const result = draft(await fixture("blocked", { status, headers: {} }));
    assert.equal(result.status, "blocked");
    assert.deepEqual(ids(result), ["site-blocked"]);
  }
});

test("HTTP error pages report the status without inventing homepage metadata failures", async () => {
  const result = draft(await fixture("error", { status: 500, headers: {} }));
  assert.equal(result.status, "partial");
  assert.deepEqual(ids(result), ["non-success-status"]);
});

test("non-HTML response metadata checks are explicitly skipped", async () => {
  const result = draft(
    await fixture('{"status":"ok"}', {
      headers: { ...healthyHeaders, "content-type": "application/json" }
    })
  );
  assert.equal(result.status, "partial");
  assert.deepEqual(ids(result), ["non-html-response"]);
  assert.equal(result.metadata.htmlBytes, 0);
});

test("HTML body is bounded and truncation does not create false missing metadata", async () => {
  const snapshot = await fetchHomepageSnapshot(URL, {
    maxHtmlBytes: 32,
    fetchImpl: async () => response("x".repeat(100) + html)
  });
  assert.equal(snapshot.htmlBytes, 32);
  assert.equal(snapshot.htmlTruncated, true);
  assert.deepEqual(ids(draft(snapshot)), ["html-truncated"]);
  assert.equal(MAX_HTML_BYTES, 1_048_576);
});

test("the eight-second deadline aborts a hanging fetch even if its promise never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let settled = false;
  const promise = fetchHomepageSnapshot(URL, {
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      return new Promise(() => {});
    }
  }).then((snapshot) => {
    settled = true;
    return snapshot;
  });
  t.mock.timers.tick(7_999);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const snapshot = await promise;
  assert.equal(FETCH_TIMEOUT_MS, 8_000);
  assert.equal(signal.aborted, true);
  assert.equal(snapshot.error, "The request timed out after 8 seconds.");
});

test("the same fetch deadline covers slow HTML body reading", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const promise = fetchHomepageSnapshot(URL, {
    fetchImpl: async (_url, options) => {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<title>Partial"));
          options.signal.addEventListener("abort", () =>
            controller.error(options.signal.reason)
          );
        }
      });
      return response(body);
    }
  });
  // Let fetch resolve so the HTML reader is waiting before advancing the clock.
  await Promise.resolve();
  await Promise.resolve();
  t.mock.timers.tick(8_000);
  assert.equal((await promise).error, "The request timed out after 8 seconds.");
});

test("valid AI output is schema-validated and explicitly labeled", async () => {
  const result = await summarizeWithFallback(
    draft(await fixture()),
    async () => ({
      summary: " No issues were found in the configured checks. ",
      recommendations: [" Recheck after changes. "]
    })
  );
  assert.equal(result.source, "ai");
  assert.equal(result.fallbackReason, null);
  assert.equal(
    result.summary,
    "No issues were found in the configured checks."
  );
});

test("malformed AI output always falls back to the deterministic draft", async () => {
  const audit = draft(await fixture());
  for (const object of [
    null,
    {},
    { summary: "   ", recommendations: ["a"] },
    { summary: "a".repeat(321), recommendations: ["a"] },
    { summary: "valid", recommendations: [] },
    { summary: "valid", recommendations: ["a", "b", "c", "d"] },
    { summary: "valid", recommendations: [" "] }
  ]) {
    const result = await summarizeWithFallback(audit, async () => object);
    assert.equal(result.source, "rules");
    assert.equal(result.fallbackReason, "invalid-ai-output");
    assert.equal(result.summary, audit.fallbackSummary);
    assert.deepEqual(result.recommendations, audit.fallbackRecommendations);
  }
});

test("AI provider exceptions fall back without failing the completed audit", async () => {
  const audit = draft(await fixture());
  const result = await summarizeWithFallback(audit, async () => {
    throw new Error("AI unavailable");
  });
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "ai-error");
  assert.equal(result.summary, audit.fallbackSummary);
});

test("rules-only mode is explicit and needs no model binding", async () => {
  const result = await summarizeWithFallback(draft(await fixture()));
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "rules-only");
});

test("AI uses its own twenty-second deadline, then returns rules", async (t) => {
  const audit = draft(await fixture());
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const promise = summarizeWithFallback(audit, async (s) => {
    signal = s;
    return new Promise(() => {});
  });
  t.mock.timers.tick(19_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await promise;
  assert.equal(AI_TIMEOUT_MS, 20_000);
  assert.equal(signal.aborted, true);
  assert.equal(result.source, "rules");
  assert.equal(result.fallbackReason, "ai-timeout");
});

test("invalid URL completion contains one finding and an explicit rules source", () => {
  const result = createInvalidUrlResult(
    "ftp://example.com",
    "Unsupported scheme",
    startedAt,
    "run-1"
  );
  assert.equal(result.runId, "run-1");
  assert.equal(result.status, "invalid_url");
  assert.equal(result.normalizedUrl, null);
  assert.deepEqual(ids(result), ["invalid-url"]);
  assert.equal(result.metadata.summarySource, "rules");
});

test("unfinished comment/script/style blocks do not expose fake metadata", () => {
  for (const opening of ["<!--", "<script>", "<style>"]) {
    const source =
      opening + '<title>Fake</title><meta name="description" content="Fake">';
    assert.equal(extractTitle(source), null, opening);
    assert.equal(extractMetaDescription(source), null, opening);
  }
});

test("repeated unfinished metadata tags are consumed without rescanning their suffixes", () => {
  assert.equal(extractTitle("<title>".repeat(20_000)), null);
  assert.equal(extractMetaDescription("<meta ".repeat(20_000)), null);
  assert.equal(
    extractMetaDescription("<meta " + "a".repeat(100_000) + ">"),
    null
  );
  assert.equal(extractTitle("<script>".repeat(20_000)), null);
  assert.equal(extractMetaDescription("<!--".repeat(20_000)), null);
});

test("similarly named custom tags are not metadata elements", () => {
  assert.equal(extractTitle("<title-custom>Fake</title>"), null);
  assert.equal(
    extractMetaDescription('<meta-custom name="description" content="Fake">'),
    null
  );
  assert.equal(
    extractMetaDescription('<meta custom name="description" content="Real">'),
    "Real"
  );
});

test("comment markers inside a script do not hide following real metadata", () => {
  const source =
    '<script>const x="<!--";</script><title>Real</title><meta name="description" content="Real">';
  assert.equal(extractTitle(source), "Real");
  assert.equal(extractMetaDescription(source), "Real");
});

test("script markers inside a comment do not hide following real metadata", () => {
  const source =
    '<!-- <script> --> <title>Real</title><meta name="description" content="Real">';
  assert.equal(extractTitle(source), "Real");
  assert.equal(extractMetaDescription(source), "Real");
});
