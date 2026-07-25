import type { FindingRecord, GapPassState, GapPassStatus, ResearchBundle, ResearchPlan } from "./artifacts.ts";
import type { VerifyReport } from "./verify.ts";
import { verifyResearch } from "./verify.ts";

export type { GapPassState } from "./artifacts.ts";

export interface ResearchGap {
	kind:
		| "missing_entity"
		| "missing_dimension"
		| "missing_cell"
		| "not_found_cell"
		| "open_question"
		| "soft_observed"
		| "expired_offer"
		| "cell_conflict";
	entity?: string;
	field?: string;
	detail: string;
}

export interface GapAnalysis {
	gaps: ResearchGap[];
	suggestedQueries: string[];
	gapPass: GapPassState;
	/** True when gaps exist and the single recovery pass has not been completed yet */
	shouldRunGapPass: boolean;
	/** True when recovery already used and gaps remain — finalize with honest not_found */
	gapPassExhausted: boolean;
}

export function defaultGapPass(): GapPassState {
	return { status: "not_started", queries: [] };
}

export function readGapPass(plan: ResearchPlan): GapPassState {
	const raw = plan.gapPass;
	if (!raw || typeof raw !== "object") return defaultGapPass();
	const status = raw.status as GapPassStatus;
	if (status !== "not_started" && status !== "in_progress" && status !== "done") {
		return defaultGapPass();
	}
	return {
		status,
		startedAt: typeof raw.startedAt === "string" ? raw.startedAt : undefined,
		completedAt: typeof raw.completedAt === "string" ? raw.completedAt : undefined,
		queries: Array.isArray(raw.queries) ? raw.queries.map(String).filter(Boolean) : [],
	};
}

export function collectResearchGaps(input: {
	plan: ResearchPlan;
	findings: FindingRecord[];
	openQuestions: string[];
	sources?: ResearchBundle["sources"];
	discovered?: ResearchBundle["discovered"];
	report?: VerifyReport;
}): ResearchGap[] {
	const report =
		input.report ??
		verifyResearch({
			plan: input.plan,
			findings: input.findings,
			openQuestions: input.openQuestions,
			sources: input.sources ?? [],
			discovered: input.discovered ?? [],
		});
	const gaps: ResearchGap[] = [];

	// Prefer cell-level gaps (entity × dimension). Skip aggregate entity/dimension duplicates.
	for (const cell of report.coverage.cellsMissing) {
		gaps.push({
			kind: "missing_cell",
			entity: cell.entity,
			field: cell.field,
			detail: `Missing cell: ${cell.entity} × ${cell.field}`,
		});
	}
	if (report.coverage.cellsMissing.length === 0) {
		for (const entity of report.coverage.entitiesMissing) {
			gaps.push({
				kind: "missing_entity",
				entity,
				detail: `No findings for entity "${entity}"`,
			});
		}
		for (const field of report.coverage.dimensionsMissing) {
			gaps.push({
				kind: "missing_dimension",
				field,
				detail: `No findings for dimension "${field}"`,
			});
		}
	}
	for (const f of input.findings) {
		if (f.status === "not_found") {
			gaps.push({
				kind: "not_found_cell",
				entity: f.entity,
				field: f.field,
				detail: `Previously not_found: ${f.entity} / ${f.field}`,
			});
		}
	}
	for (const issue of report.issues) {
		if (issue.code === "soft_observed") {
			gaps.push({
				kind: "soft_observed",
				entity: issue.entity,
				field: issue.field,
				detail: issue.message,
			});
		}
		if (issue.code === "expired_offer_unreplaced") {
			gaps.push({
				kind: "expired_offer",
				entity: issue.entity,
				field: issue.field,
				detail: issue.message,
			});
		}
		if (issue.code === "cell_conflict") {
			gaps.push({
				kind: "cell_conflict",
				entity: issue.entity,
				field: issue.field,
				detail: issue.message,
			});
		}
	}
	for (const q of input.openQuestions) {
		gaps.push({
			kind: "open_question",
			detail: q,
		});
	}
	return gaps;
}

/** Build a short list of targeted recovery queries (capped — one pass, not a crawl). */
export function suggestGapQueries(input: {
	question: string;
	gaps: ResearchGap[];
	policyHint?: string;
	maxQueries?: number;
}): string[] {
	const max = input.maxQueries ?? 6;
	const seen = new Set<string>();
	const out: string[] = [];

	const push = (q: string) => {
		const key = q.toLowerCase().trim();
		if (!key || seen.has(key)) return;
		seen.add(key);
		out.push(q.trim());
	};

	for (const g of input.gaps) {
		if (out.length >= max) break;
		if (g.kind === "missing_cell" && g.entity && g.field) {
			const schedule = /\b(ucret|ücret|fee|price|faiz|yillik|yıllık)\b/i.test(g.field);
			push(
				schedule
					? `${g.entity} ${g.field} resmi ücret tarifesi OR fee schedule`.slice(0, 160)
					: `${g.entity} ${g.field}`.slice(0, 160),
			);
			continue;
		}
		if (g.kind === "missing_entity" && g.entity) {
			push(`${g.entity} ${input.policyHint ?? "official"} ${input.question}`.slice(0, 160));
			continue;
		}
		if (g.kind === "missing_dimension" && g.field) {
			push(`${g.field} ${input.question}`.slice(0, 160));
			continue;
		}
		if (g.kind === "not_found_cell" && g.entity && g.field) {
			push(`${g.entity} ${g.field}`.slice(0, 160));
			continue;
		}
		if (g.kind === "soft_observed" && g.entity && g.field) {
			push(`${g.entity} ${g.field} primary source`.slice(0, 160));
			continue;
		}
		if (g.kind === "open_question") {
			push(g.detail.slice(0, 160));
		}
	}
	return out;
}

export function analyzeGaps(bundle: ResearchBundle, report?: VerifyReport): GapAnalysis {
	const resolved = report ?? verifyResearch(bundle);
	const gaps = collectResearchGaps({
		plan: bundle.plan,
		findings: bundle.findings,
		openQuestions: bundle.openQuestions,
		sources: bundle.sources,
		discovered: bundle.discovered,
		report: resolved,
	});
	gaps.sort((a, b) => {
		const as = a.field && /\b(ucret|ücret|fee|price|faiz)\b/i.test(a.field) ? 0 : 1;
		const bs = b.field && /\b(ucret|ücret|fee|price|faiz)\b/i.test(b.field) ? 0 : 1;
		return as - bs;
	});
	const gapPass = readGapPass(bundle.plan);
	const suggestedQueries = suggestGapQueries({
		question: bundle.plan.question,
		gaps,
		policyHint: bundle.plan.policy === "official" ? "official site" : bundle.plan.policy,
	});
	const fillable = gaps.filter((g) => {
		// Retry not_found only during the single gap-fill pass; after that they stay honest gaps
		if (g.kind === "not_found_cell") return gapPass.status !== "done";
		return true;
	});
	const hasActionable = fillable.length > 0;
	return {
		gaps,
		suggestedQueries,
		gapPass,
		shouldRunGapPass: hasActionable && gapPass.status !== "done",
		gapPassExhausted: hasActionable && gapPass.status === "done",
	};
}

export function gapPassProgress(input: {
	startedAt?: string;
	findings: Array<{ recordedAt: string }>;
	sources: Array<{ fetchedAt?: string }>;
	discovered: Array<{ status: string; fetchedAt?: string }>;
}): { newFindings: number; newFetches: number; ok: boolean } {
	const started = input.startedAt;
	const after = (iso?: string) => Boolean(iso && (!started || iso >= started));
	const newFindings = input.findings.filter((f) => after(f.recordedAt)).length;
	const sourceFetches = input.sources.filter((s) => after(s.fetchedAt)).length;
	const discoveredFetches = input.discovered.filter((d) => d.status === "fetched" && after(d.fetchedAt)).length;
	const newFetches = sourceFetches + discoveredFetches;
	return { newFindings, newFetches, ok: newFindings + newFetches > 0 };
}

export function formatGapAnalysis(analysis: GapAnalysis): string {
	const lines: string[] = [`Gap pass: ${analysis.gapPass.status}`, `Gaps: ${analysis.gaps.length}`];

	if (analysis.gaps.length === 0) {
		lines.push("No fillable gaps — proceed to research_verify / research_finalize.");
		return lines.join("\n");
	}

	lines.push("");
	lines.push("Gaps:");
	for (const g of analysis.gaps.slice(0, 20)) {
		const loc = [g.entity, g.field].filter(Boolean).join(" / ");
		lines.push(`- [${g.kind}]${loc ? ` ${loc}` : ""} — ${g.detail}`);
	}
	if (analysis.gaps.length > 20) {
		lines.push(`- … ${analysis.gaps.length - 20} more`);
	}

	if (analysis.shouldRunGapPass) {
		lines.push("");
		lines.push("ONE gap-fill pass required (not endless deepening):");
		lines.push("1. web_search the suggested queries below (or tighter variants)");
		lines.push("2. web_fetch promising primary hits");
		lines.push("3. research_record_finding for what you found (or keep not_found)");
		lines.push("4. research_complete_gap_pass");
		lines.push("5. research_verify → research_finalize");
		lines.push("");
		lines.push("Suggested queries:");
		for (const q of analysis.suggestedQueries) {
			lines.push(`- ${q}`);
		}
	} else if (analysis.gapPassExhausted) {
		lines.push("");
		lines.push(
			"Gap pass already used. Do not start another deep crawl. Mark remaining cells not_found if still missing, then finalize with honest gaps in the user answer.",
		);
	}

	return lines.join("\n");
}
