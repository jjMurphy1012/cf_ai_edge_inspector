# CLAUDE.md

Project instructions for Claude Code sessions working on `cf_ai_edge_inspector`.

The canonical engineering guide lives in [`AGENTS.md`](./AGENTS.md) — Cloudflare Workers / Agents SDK / bindings / commands / error references. Read it first. Everything below is project-specific and layered on top.

## Project-specific decisions

These were locked in during the planning phase (see `PROMPTS.md`) and should not be relitigated casually.

- **Language**: TypeScript only. Do not mix JavaScript.
- **Stack**: Workers (runtime + deploy) + Agents SDK + Durable Objects (SQLite-backed) + Workflows + Workers AI. No Pages; static frontend ships via Workers `assets` binding.
- **Architecture boundary**: Agent is thin — intent routing, param validation, starting workflows, light state I/O, follow-up replies. Workflow is thick — all audit logic and the Workers AI call live inside workflow steps.
- **Workflow step rules**: Each step is idempotent with small serializable inputs/outputs. Do not pass raw HTML through step state; extract fields first. The Workers AI call lives in its own step so it can be retried independently and gracefully degraded to a findings-only response on failure.
- **Frontend**: Subscribes to Agent state for progress updates. Do not poll.
- **Model strategy**: MVP uses a single model — `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Only split follow-up to a lighter model after measured latency or quota pressure.
- **Scan result status taxonomy**: `success | partial | blocked | unreachable | invalid_url`. Treat `blocked` and timeouts as first-class findings, not system errors.
- **Durable Object migration**: Must use `new_sqlite_classes` in `wrangler.jsonc`. `new_classes` is the old KV-backed storage and is not acceptable.
- **Fetch policy**: 5–10s timeout, homepage only, no recursion, record redirect chain, cap subrequests well under the Workers free-tier limit.
- **Fallback**: If Workflows integration becomes a real blocker, a Durable Object-internal state machine is the pre-approved fallback for the coordination component. Do not downgrade preemptively.

## Code and comment language

All code, identifiers, and comments are written in English regardless of the conversation language.

## Documentation

- `README.md` — user-facing project documentation and the runtime LLM reference.
- `PROMPTS.md` — development-time AI-assisted work log. Append new entries as prompts are used; do not reconstruct at the end.
