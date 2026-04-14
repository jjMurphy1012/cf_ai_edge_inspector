# PROMPTS.md

Development prompts used while building `cf_ai_edge_inspector`.

## How I used the two models

I deliberately split the work across two models so each major decision was produced by one and reviewed by the other. The idea was to keep one model honest — single-model drift and confidently-wrong API names are both real problems, and a second model usually catches them.

- **GPT-5.4 (Codex)** — implementation. Repo setup, starter conversion, `wrangler.jsonc` wiring, the actual `AuditAgent` + `WebsiteAuditWorkflow` code, Wrangler auth, deployment, and post-deploy checks.
- **Claude Opus 4.6 (Claude Code)** — review and cleanup. Plan feasibility checks before anything was built, cross-model audits of GPT's output, architectural tightening (Agent-thin / Workflow-thick, step idempotency, isolated AI step, frontend subscribing to state), docs, and end-to-end sanity passes.

The runtime LLM is Workers AI / Llama 3.3 and is documented in `README.md`. It's intentionally separate from the dev-time models below.

Each entry has two fields:

- **Model** — which tool I used
- **Prompt** — what I actually asked it

## Entries

### Stage 1 — Planning

#### 2026-04-13 — Assignment scoping and project pick

**Model**  
GPT-5.4 Codex, Claude Opus 4.6

**Prompt**  
What are the hard requirements for Cloudflare's AI app assignment vs. the recommended stuff? Give me a few Cloudflare-native project ideas, rank them by platform fit and risk, pick one, and map the four required pieces (LLM, workflow, chat, state) to the smallest stack that covers them.

#### 2026-04-13 — Feasibility review of the first plan

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Look at my 20-step plan for `cf_ai_edge_inspector` and tell me if it's actually doable. Flag anything Cloudflare-specific I'm underestimating — subrequest limits, DO migration format, Workflows vs DO trade-off, Workers AI latency, Pages vs Workers+assets.

#### 2026-04-13 — Cross-checking the review against the docs

**Model**  
GPT-5.4

**Prompt**  
Here's what Claude said about the plan. Go through each point and check it against current Cloudflare docs. For every one, tell me adopt / adjust / reject and link the doc. I need concrete decisions on the status taxonomy, model choice, DO SQLite migration, and deployment.

#### 2026-04-13 — Final plan

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
GPT's critique isn't necessarily right — assume it might be wrong in places so you don't just agree with it. Give me one final plan and one todo list. Resolve the contradictions and add anything both rounds missed — especially step idempotency, the AI call in its own step, and the frontend subscribing to state instead of polling.

### Stage 2 — Scaffolding

#### 2026-04-13 — Project init

**Model**  
GPT-5.4 Codex

**Prompt**  
Kick off the project from the final plan. TypeScript only. Workers + Agents SDK + DO (SQLite) + Workflows + Workers AI. Agent-thin, Workflow-thick, frontend subscribes to state. Drop the `cloudflare/agents-starter` scaffold at the repo root and get it ready for install + binding wiring.

#### 2026-04-13 — Repo cleanup and remote

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Tidy up the repo — project at the root, remove duplicate scaffolds, and make sure `node_modules`, `.wrangler`, `.dev.vars`, and local IDE files aren't tracked. Then initial commit, hook up the GitHub remote, push `main`.

### Stage 3 — Implementation

#### 2026-04-13 — Starter → project skeleton

**Model**  
GPT-5.4 Codex

**Prompt**  
Turn the generic starter into the real project skeleton per the plan. Keep it on the locked-in architecture — don't let scanning logic leak into the Agent.

#### 2026-04-13 — Check in on progress

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Look at what's done so far vs. the plan. What's drifted, what's missing, what's risky? Give me a tightened todo for the next pass, run it, then run `/simplify` on whatever changed.

### Stage 4 — Validation and deployment

#### 2026-04-13 — Local check

**Model**  
GPT-5.4 Codex

**Prompt**  
Install deps, regenerate `env.d.ts`, run lint and tsc, and see if local dev actually comes up. If it doesn't, figure out what's blocking it and update the docs to match reality.

#### 2026-04-13 — Deploy

**Model**  
GPT-5.4 Codex

**Prompt**  
Keep going with the todo. `wrangler login`, get local dev running, find any binding issues, deploy the Worker, check the live URL, and update README/PROMPTS so they reflect what's actually deployed.

#### 2026-04-13 — Are we ready to submit?

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Scan the git state, the local code, and the live deploy. Is this actually submittable? What's the biggest gap still — uncommitted work, missing end-to-end browser test, status taxonomy coverage, README polish? Give me a prioritized next-step list.

### Stage 5 — Hardening and cleanup

#### 2026-04-13 — First simplify pass

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Run `/simplify` on the recent changes. Only land the clearly safe fixes — skip anything risky this close to submission.

#### 2026-04-13 — Fix the audit entry path

**Model**  
GPT-5.4 Codex

**Prompt**  
The chat entry is flaky because it depends on the model choosing to call a tool. Make `Analyze <url>` start the workflow deterministically — do intent detection in the Agent itself. Also make sure the workflow reports completion explicitly so results land in SQLite. Then extend the live validation script to cover success, redirect, and `invalid_url`, and update the README with the tested flows.

#### 2026-04-13 — Second simplify pass

**Model**  
Claude Opus 4.6 (Claude Code)

**Prompt**  
Run `/simplify` again on what's new since last time. Only take the small obvious wins — hoist hot-path regexes, leave readable if/else alone. Also backfill PROMPTS.md so every dev stage is represented and it lines up with the commit history.

## Suggested future entries

Things still worth logging as they come up:

- summary prompt tuning
- workflow step design and error paths
- follow-up prompt templates
- README wording and deploy gotchas

## Guidance for future updates

- Log prompts as you use them. Don't reconstruct at the end.
- Keep prompts focused on what you wanted done, not on tone or formatting.
- Separate unrelated prompts into separate entries, even on the same day.
- Dev-time models (Claude Opus 4.6, GPT-5.4) are not the same as the runtime LLM (Workers AI) — don't mix them.
