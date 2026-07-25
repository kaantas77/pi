import { listSourcePolicies } from "./policy.ts";

export function buildResearchModePrompt(activeRunId?: string): string {
	const policies = listSourcePolicies()
		.map((p) => `- ${p.name}: ${p.description}`)
		.join("\n");

	const runLine = activeRunId
		? `Active research run id: ${activeRunId}`
		: "No active run yet. Call research_init before recording findings.";

	return `[RESEARCH MODE ACTIVE]
You are running an artifact-first research workflow. Do not answer from search snippets alone.

${runLine}

Core loop (ranking, not veto stacking):
1. web_search → discover candidates
2. web_fetch the best candidates (must-fetch backlog)
3. research_record_finding with concrete evidence from fetched pages
4. Trust the cell ledger winner (highest evidence score: source class + path intent + freshness + specificity + concreteness)
5. research_verify → research_finalize → copy USER-FACING BRIEF to the user

Hard integrity (still enforced):
- Search snippets are discovery only — never treat them as evidence.
- Observed findings need a web_fetch'd sourceUrl + evidence quote. Soft placeholders cannot be observed.
- Conflicting values for the same cell are not auto-averaged / not publishable.
- Time-bound offers past validTo are expired (not active coverage).
- brief.md is produced only from the ledger. Do not invent a second prettier report or pass ungrounded briefMarkdown.
- Atomic entities (not catalog bags). Same-specificity label match (sibling variants do not cover each other).

Ranking preferences (score wins — do not game gates):
- Prefer fee/pricing/support paths over membership-contract / terms PDFs for fee fields.
- Prefer fresher dated pages over undated or multi-year-old docs.
- Secondary/aggregators may be recorded for discovery; they rank lower and often will not publish on fee cells.
- Overstuffed multi-product fee blobs rank down — split entities instead of packing a catalog into one cell.

Workflow tools:
1. research_init — atomic entities + requiredDimensions (fee / ongoing benefits / active offers) + policy + queries
2. web_search → web_fetch
3. research_record_source / research_record_finding
4. research_gaps → one recovery pass if needed → research_complete_gap_pass
5. research_verify (hard blockers vs quality notes) → research_finalize

Source policies:
${policies}

CRITICAL — ledger is the only source of truth:
- Summary table, detail sections, and chat must come from the same publishable cells (brief.md).
- After research_finalize, copy the USER-FACING BRIEF block. Do NOT invent rankings or soft fees in chat.
- Incomplete packages: short gap note, then grounded rows only.
- Match the user's language. Prefer: title → date → summary table → grouped details → sources → honesty note.`;
}
