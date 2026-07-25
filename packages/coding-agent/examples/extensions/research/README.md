# pi-research

Artifact-first web research package for pi.

```
research_init → web_search → web_fetch → record ledger → research_verify → research_finalize
```

Evidence is **ranked**, not veto-stacked. The cell ledger picks the highest-scoring observed candidate (source class, path intent, freshness, specificity, concreteness). A few hard integrity gates remain; most soft “must be primary / not overstuffed / thin facets” signals are quality notes or score penalties.

## Install

```bash
# from this repo
pi install /absolute/path/to/packages/coding-agent/examples/extensions/research

# or one-off
pi -e ./packages/coding-agent/examples/extensions/research
```

Requires an Exa API key:

```bash
export EXA_API_KEY=...
# or ~/.pi/agent/auth.json → { "exa": { "key": "..." } }
```

If you previously installed a standalone `exa-search.ts` extension that also registers `web_search` / `web_scrape`, remove it to avoid duplicate tool names. This package provides `web_search` + `web_fetch`.

## Usage

```text
/research-mode
/research Compare X vs Y on dimensions A, B, C using official sources
```

Or start with:

```bash
pi --research -e ./packages/coding-agent/examples/extensions/research
```

## Tools

| Tool | Role |
|------|------|
| `web_search` | Discovery (Exa); top hits tracked as must-fetch in `discovered.jsonl` |
| `web_fetch` | Deep-read page text; marks discovered URLs fetched |
| `research_init` | Create `.pi-research/<run>/` plan + ledgers |
| `research_record_source` | Append/update sources.jsonl |
| `research_record_finding` | Append findings.jsonl (rejects soft placeholders / unfetched citations) |
| `research_skip_discovered` | Skip a must-fetch URL with a reason |
| `research_set_open_questions` | Track unresolved gaps |
| `research_status` | Ledger summary + unfetched backlog + gap-pass state |
| `research_gaps` | List missing cells + suggest one recovery search pass |
| `research_complete_gap_pass` | Mark the single gap-fill pass done (no endless deepen) |
| `research_audit` | Diagnose soft_observed / fetch_skip failure modes |
| `research_verify` | Hard blockers (coverage, soft, unfetched, conflicts) + quality notes |
| `research_finalize` | Write brief.md from the ledger; chat reply should be that brief |

## Ranking model

For each entity × field cell, candidates are scored and the highest wins:

- **sourceClass** — primary > unknown > secondary
- **pathIntent** — fee/pricing paths boost fee fields; contract/terms paths are penalized
- **freshness** — dated pages near `asOf` beat undated or stale docs
- **specificity** — entity token overlap with value/URL/title
- **concreteness** — real amounts/dates beat soft placeholders; overstuffed blobs are penalized

Hard integrity (still block publish-ready):

- unfetched citation / soft placeholder → cannot be observed
- conflicting values → not publishable
- time-bound offer past end → expired (not active coverage)
- brief only from ledger (draft cannot bypass)

Quality notes (warn; do not alone fail verify): secondary citations, non-primary fee URLs, overstuffed cells, thin plan facets, low-evidence fee winners.

## Failure mode this package blocks

`discovered in search → never fetched → soft "observed" → verify PASS`

Must-fetch URLs block verify until `web_fetch` or `research_skip_discovered`; soft placeholders cannot be `observed`.

After the first collect round, missing coverage / not_found cells trigger **one** gap-fill pass. Completing the pass with zero new fetches/findings is blocked.

Coverage is an **entity × required-dimension cell matrix**. Conflicting values are not publishable. Time-bound offer fields need an end date; expired cells are excluded from active claims.

**Published brief.md** is user-facing. Technical verify output goes to `verify-report.md` — do not paste it into chat.

### Debugging regressions (for maintainers / agents)

When a run looks wrong on one domain, **do not patch that domain**. Trace the general mechanism:

1. Evidence score (did a stale contract outrank a fee page? pathIntent/freshness)
2. Field classification (`isTimeBoundOfferField` / schedule / ongoing)
3. Date inference (`inferValidToFromValue`) — end marker vs as-of marker?
4. Ledger publishability + coverage (expired ≠ covered)
5. Chat/draft bypass of `brief.md`

Fix the shared ranking or hard gate; add a domain-agnostic regression test.

## Artifacts

```text
.pi-research/<run-id>/
  plan.json
  entities.json
  sources.jsonl
  findings.jsonl
  discovered.jsonl
  open_questions.json
  findings.csv
  brief.md
  summary.json
```

## Source policies

- `general` — balanced
- `official` — prefer primary for confirmed claims
- `docs` — documentation / API references
- `news` — news outlets + recency
- `academic` — papers / DOI-ish sources

Secondary/aggregator hits are fine for discovery; evidence ranking prefers primary fee/schedule pages for publishable fee cells.
