# PROMPTS.md

This file documents AI-assisted development used for `cf_ai_edge_inspector`.

## How this file is organized

Each entry records:

- `Purpose`: why the prompt was used
- `Tool / Model`: which AI tool was used
- `Prompt`: the exact or near-exact prompt
- `Outcome`: what was adopted, changed, or rejected

## Entries

### 2026-04-13 - Scoping, project selection, and architecture mapping (condensed)

Used GPT-5.4 Codex and Claude Opus 4.6 to lock in the assignment baseline (`cf_ai_`-prefixed public repo, `README.md`, `PROMPTS.md`, LLM + workflow + chat + memory, deployment strong-but-optional) and to pick the project concept `cf_ai_edge_inspector` — a chat-driven website audit agent.
MVP stack fixed as Workers (runtime + deploy) + Agents SDK (chat agent) + Durable Objects (state/history) + Workflows (multi-step audit) + Workers AI (summary and follow-up).

### 2026-04-13 - AI review of the AI-generated todo list

**Purpose**  
Use a second model to sanity-check the detailed implementation plan and todo list that was produced with AI assistance, before committing to it. The goal was to catch scope creep, unrealistic steps, and missing Cloudflare-specific risks.

**Tool / Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Review whether this plan is feasible — followed by the full 20-step todo list, the end-to-end use case walkthrough, and the README/PROMPTS polish standards for `cf_ai_edge_inspector`. Asked the model to judge feasibility, call out weak points, and flag anything Cloudflare-specific that the plan underestimated.

**Outcome**  
Plan confirmed feasible. Concrete adjustments adopted:

- Tighten the Agent vs. Workflow boundary — the Agent only handles intent routing, state I/O, and workflow invocation; all scanning logic lives inside the Workflow.
- Use `llama-3.3-70b-instruct-fp8-fast` for summaries and a lighter `llama-3.1-8b-instruct` for follow-up Q&A to control latency and usage.
- Treat "target site blocks Cloudflare egress" and fetch timeouts as first-class findings, not errors; set a 5–10s fetch budget and skip recursive crawling.
- If `new_sqlite_classes` is used for Durable Object storage, declare it explicitly in the migration.
- Keep Workflows as the coordination layer, but note a DO-internal state machine as an acceptable fallback if Workflows config becomes a blocker.
- Deploy as Workers + static assets only; do not add Pages.

### 2026-04-13 - Cross-model rebuttal on the review

**Purpose**  
Feed Claude Opus 4.6's feedback back to GPT-5.4 to stress-test each suggestion against official Cloudflare docs, rather than accepting the review blindly.

**Tool / Model**  
GPT-5.4

**Prompt**  
Evaluate each of these suggestions on feasibility and whether they match current Cloudflare documentation. For every point, say whether to adopt, adjust, or reject, and cite the relevant Cloudflare docs when possible — followed by the six adjustments from the previous Claude Opus 4.6 review.

**Outcome**  
Most suggestions confirmed, with two notable changes:

- Reverted the dual-model plan to single-model for MVP: start with `@cf/meta/llama-3.3-70b-instruct-fp8-fast` only; consider splitting follow-up to `llama-3.1-8b-instruct` only if latency or usage becomes a real problem.
- Added concrete status taxonomy for scan results: `success | partial | blocked | unreachable | invalid_url`.
- Reconfirmed `new_sqlite_classes` as a hard requirement, not a suggestion.
- Reconfirmed Workers + static assets binding over Pages; kept DO-only state machine as an explicit fallback if Workflows becomes a blocker.

### 2026-04-13 - Final consolidated plan (AI-on-AI second pass)

**Purpose**  
Run a second adversarial pass with Claude Opus 4.6 on top of GPT-5.4's rebuttal, to produce one authoritative todo list instead of two competing versions.

**Tool / Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Here is the other model's critique of your earlier suggestions (not necessarily correct). Produce the final version of the recommendation and a single consolidated todo list.

**Outcome**  
Produced the final 18-step todo list. Three non-obvious additions that were not in either earlier draft:

- Each Workflow step must be idempotent with small serializable inputs/outputs; do not push raw HTML through step state.
- The Workers AI call must live in its own Workflow step so it can be retried independently and cleanly downgraded to a findings-only response on failure.
- The frontend subscribes to Agent state for progress instead of polling — this is the most Cloudflare-native integration point and should be called out in the README.

### 2026-04-13 - Init execution from the final todo list

**Purpose**  
Kick off implementation using the final consolidated plan — initialize the repo and verify the `cf_ai_edge_inspector` scaffold.

**Tool / Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Execute init following the final todo list — followed by the 25-step consolidated plan (TypeScript, Workers + Agents + DO with SQLite + Workflows + Workers AI, Agent-thin / Workflow-thick, frontend subscribes to state, single-model MVP).

**Outcome**  
Workspace git-initialized on `main`; `README.md` and `PROMPTS.md` staged. `cf_ai_edge_inspector/` already contains the `cloudflare/agents-starter` scaffold (TypeScript, `wrangler.jsonc`, `src/`, Vite). Next: install deps, wire Workers AI / DO (SQLite migration) / Workflows bindings, then begin types-first implementation.

## Suggested future entries

Add entries as development continues for:

- prompt design for audit summaries
- workflow step design
- error handling and fallback behavior
- UI copy and interaction polish
- README wording and project framing
- deployment troubleshooting

## Guidance for future updates

- Record prompts as you use them instead of reconstructing them at the end.
- Keep prompts close to the actual text you used.
- If a prompt led to a rejected idea, note that briefly in `Outcome`.
- If you use Claude Code with `Claude Opus 4.6`, add it exactly under `Tool / Model`.
- If you use GPT-5.4 for implementation or debugging help, add separate entries instead of merging unrelated prompts together.
