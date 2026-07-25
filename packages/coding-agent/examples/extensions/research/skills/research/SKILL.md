---
name: research
description: Artifact-first web research with Exa search/fetch, structured ledgers, citation gates, and finalize artifacts. Use for web research, comparisons, benchmarks, fact-finding, literature scans, or any question that needs cited sources.
---

# Research skill

Use the registered research tools (not bash scrapers):

1. `research_init` — plan entities + dimensions + policy
2. `web_search` — discovery; top hits become must-fetch
3. `web_fetch` — evidence from those URLs (or `research_skip_discovered`)
4. `research_record_source` / `research_record_finding`
5. `research_gaps` → one targeted recovery search if cells are missing → `research_complete_gap_pass`
6. `research_audit` / `research_verify` — coverage + soft + unfetched gates
7. `research_finalize` — write `.pi-research/<run>/` artifacts + user-facing brief
8. Reply to the user with the brief content (assistant answer), not a pipeline report

Toggle strict workflow prompting with `/research-mode`, or start a task with `/research <question>`.

Source policies: `general`, `official`, `docs`, `news`, `academic`.

Hard rules:
- Snippets ≠ evidence
- Discovered must-fetch URLs must be fetched or explicitly skipped
- Observed findings need fetched `sourceUrl` + evidence span
- Soft placeholders cannot be `observed`
- Prefer primary sources
- Use `not_found` instead of inventing
- One gap-fill pass only (must include real new fetch/record) — then finalize honestly
- Entity × dimension cell matrix coverage; no ungrounded brief prose

Final reply style:
- End-user AI answer: clear prose, concrete facts, natural citations
- Not a search console: no verify PASS/FAIL walls, run ids, or tool narration in chat
- Gaps in plain language when incomplete
