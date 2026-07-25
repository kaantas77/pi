---
description: Run artifact-first web research with citations and coverage gates
argument-hint: "<research question>"
---
Enable research mode discipline for this request (use research tools; do not answer from snippets).

Research question:
${@:-(see conversation)}

Required workflow:
1. Call `research_init` with:
   - question
   - concrete `entities` (prefer ≤8)
   - `requiredDimensions` (≤5 core fields) + optional `optionalDimensions`
   - `policy`: choose `official`, `docs`, `news`, `academic`, or `general`
   - seed `queries` (multiple specific queries, not one vague query)
2. `web_search` fan-out (prefer primary/official domains when relevant; fetch fee/schedule URLs for ücret fields)
3. `web_fetch` primary URLs before treating anything as evidence
4. `research_record_source` + `research_record_finding` into the ledger
   - observed findings MUST include sourceUrl + evidence quote
   - marketing page omitting a fee ≠ not_found — fetch ücret/fee pages first
5. `research_set_open_questions` for remaining gaps
6. `research_gaps` — if missing cells remain, run **one** targeted recovery search/fetch/record, then `research_complete_gap_pass` (no endless deepening)
7. `research_verify` until PASS (or explicitly report FAIL + missing coverage after the gap pass)
8. `research_finalize` with a user-facing `briefMarkdown`, then reply to the user with that answer (not tool status)

Rules:
- Search snippets are discovery only, never evidence
- Prefer primary sources; secondary sources are for discovery
- Never invent numbers, dates, fees, or names
- Partial answers must list missing entities/fields in plain language
- Exactly one gap-fill pass for leftovers — then honest not_found / finalize
- Every entity × required dimension cell needs a ledger row; do not invent brief sections for entities with no findings
- Do not force-finalize under ~50% required coverage — narrow the plan instead

User-facing answer (this is an AI assistant, not a search UI):
- Write the final reply as a clear, cited answer to the human — prose first, tables only when useful
- No run ids, verify dumps, must-fetch lists, or "I used web_search…" narration in the user reply
- Known vs unknown in everyday wording; cite URLs; match the user's language
