import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FindingRecord, ResearchPlan, SourceRecord } from "./artifacts.ts";
import { buildCellLedger, cellKey } from "./cells.ts";
import type { DiscoveredUrl } from "./discovered.ts";
import { findAggregateEntities, isOverstuffedValue } from "./entity-quality.ts";
import { fieldsMatch, findCoveringLabel } from "./normalize.ts";
import { missingPlanFacets } from "./plan-facets.ts";
import { isScheduleLikeField, isTimeBoundOfferField, matrixDimensions } from "./plan-scope.ts";
import { getSourcePolicy, type SourcePolicy, sourceTypeConfidence } from "./policy.ts";
import { isSoftPlaceholderValue } from "./soft.ts";

export type VerifyIssueSeverity = "hard" | "quality";

export interface VerifyIssue {
	code:
		| "missing_entity_coverage"
		| "missing_dimension_coverage"
		| "missing_cell_coverage"
		| "cell_conflict"
		| "campaign_missing_end_date"
		| "uncited_observed"
		| "secondary_as_confirmed"
		| "empty_evidence"
		| "soft_observed"
		| "unfetched_citation"
		| "unfetched_discovered"
		| "open_questions_remain"
		| "no_findings"
		| "ungrounded_brief"
		| "aggregate_entity"
		| "overstuffed_cell"
		| "schedule_non_primary"
		| "expired_offer_unreplaced"
		| "thin_plan_facets"
		| "draft_ungrounded"
		| "low_evidence_winner"
		| "stale_document_winner";
	severity: VerifyIssueSeverity;
	message: string;
	entity?: string;
	field?: string;
	findingId?: string;
	url?: string;
}

/** Codes that block publish-ready (ok=false). Quality notes warn but do not alone fail verify. */
const HARD_ISSUE_CODES = new Set<VerifyIssue["code"]>([
	"missing_entity_coverage",
	"missing_dimension_coverage",
	"missing_cell_coverage",
	"cell_conflict",
	"campaign_missing_end_date",
	"uncited_observed",
	"empty_evidence",
	"soft_observed",
	"unfetched_citation",
	"unfetched_discovered",
	"open_questions_remain",
	"no_findings",
	"ungrounded_brief",
	"aggregate_entity",
	"expired_offer_unreplaced",
	"draft_ungrounded",
]);

export function issueSeverity(code: VerifyIssue["code"]): VerifyIssueSeverity {
	return HARD_ISSUE_CODES.has(code) ? "hard" : "quality";
}

export interface VerifyReport {
	ok: boolean;
	runId: string;
	policy: string;
	stats: {
		entities: number;
		dimensions: number;
		cells: number;
		cellsCovered: number;
		sources: number;
		findings: number;
		observed: number;
		notFound: number;
		conflicts: number;
		openQuestions: number;
		primarySources: number;
		secondarySources: number;
		discovered: number;
		unfetchedMustFetch: number;
		softObserved: number;
		hardIssues: number;
		qualityIssues: number;
	};
	coverage: {
		entitiesCovered: string[];
		entitiesMissing: string[];
		dimensionsCovered: string[];
		dimensionsMissing: string[];
		cellsMissing: Array<{ entity: string; field: string }>;
		entityMatches: Array<{ planned: string; matchedAs: string }>;
		dimensionMatches: Array<{ planned: string; matchedAs: string }>;
	};
	unfetchedMustFetch: Array<{ url: string; title?: string; query?: string; sourceType: string }>;
	issues: VerifyIssue[];
	qualityNotes: VerifyIssue[];
	cellLedger?: {
		asOf: string;
		publishable: number;
		conflicts: number;
		expired: number;
		missing: number;
	};
}

function buildFetchedUrlSet(sources: SourceRecord[], discovered: DiscoveredUrl[]): Set<string> {
	const set = new Set<string>();
	for (const s of sources) {
		if (s.fetchedAt) set.add(s.url);
	}
	for (const d of discovered) {
		if (d.status === "fetched") set.add(d.url);
	}
	return set;
}

function pushIssue(
	issues: VerifyIssue[],
	issue: Omit<VerifyIssue, "severity"> & { severity?: VerifyIssueSeverity },
): void {
	issues.push({
		...issue,
		severity: issue.severity ?? issueSeverity(issue.code),
	});
}

export interface EntityAliasMap {
	/** planned entity name → aliases */
	byName: Map<string, string[]>;
}

export function loadEntityAliases(runDir: string): EntityAliasMap {
	const byName = new Map<string, string[]>();
	const path = join(runDir, "entities.json");
	if (!existsSync(path)) return { byName };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			entities?: Array<{ name?: string; aliases?: string[] }>;
		};
		for (const e of raw.entities ?? []) {
			if (!e.name) continue;
			byName.set(
				e.name,
				(e.aliases ?? []).map((a) => String(a)),
			);
		}
	} catch {
		// ignore
	}
	return { byName };
}

export function loadEntityDisplayNames(runDir: string): Map<string, string> {
	const byName = new Map<string, string>();
	const path = join(runDir, "entities.json");
	if (!existsSync(path)) return byName;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as {
			entities?: Array<{ name?: string; displayName?: string }>;
		};
		for (const e of raw.entities ?? []) {
			if (!e.name) continue;
			if (e.displayName?.trim()) byName.set(e.name, e.displayName.trim());
		}
	} catch {
		// ignore
	}
	return byName;
}

export function verifyResearch(input: {
	plan: ResearchPlan;
	sources: SourceRecord[];
	findings: FindingRecord[];
	openQuestions: string[];
	discovered?: DiscoveredUrl[];
	policy?: SourcePolicy;
	entityAliases?: EntityAliasMap;
}): VerifyReport {
	const policy = input.policy ?? getSourcePolicy(input.plan.policy);
	const discovered = input.discovered ?? [];
	const aliases = input.entityAliases ?? (input.plan.dir ? loadEntityAliases(input.plan.dir) : { byName: new Map() });
	const issues: VerifyIssue[] = [];
	const sourceByUrl = new Map(input.sources.map((s) => [s.url, s]));
	const fetchedUrls = buildFetchedUrlSet(input.sources, discovered);

	if (input.findings.length === 0) {
		pushIssue(issues, {
			code: "no_findings",
			message: "No findings recorded. Extract structured findings before finalizing.",
		});
	}

	const dims = matrixDimensions(input.plan);
	const recordedEntities = new Set(input.findings.map((f) => f.entity));
	const recordedFields = new Set(input.findings.map((f) => f.field));
	let softObserved = 0;

	for (const finding of input.findings) {
		if (finding.status !== "observed") continue;

		if (!finding.sourceUrl) {
			pushIssue(issues, {
				code: "uncited_observed",
				message: `Observed finding ${finding.id} has no sourceUrl`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
			});
		}
		if (!finding.evidence.trim()) {
			pushIssue(issues, {
				code: "empty_evidence",
				message: `Observed finding ${finding.id} has empty evidence`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
			});
		}
		if (isSoftPlaceholderValue(finding.value)) {
			softObserved++;
			pushIssue(issues, {
				code: "soft_observed",
				message: `Observed finding ${finding.id} has a soft/placeholder value. Fetch the concrete page or use status=not_found.`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
			});
		}
		if (finding.sourceUrl && !fetchedUrls.has(finding.sourceUrl)) {
			pushIssue(issues, {
				code: "unfetched_citation",
				message: `Observed finding ${finding.id} cites ${finding.sourceUrl} but that URL was never web_fetch'd.`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
				url: finding.sourceUrl,
			});
		}

		const source = finding.sourceUrl ? sourceByUrl.get(finding.sourceUrl) : undefined;
		if (policy.preferPrimary && source?.type === "secondary") {
			pushIssue(issues, {
				code: "secondary_as_confirmed",
				message: `Finding ${finding.id} cites a secondary source (${finding.sourceUrl}). Prefer a primary page; secondary ranks lower and may not publish on fee fields.`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
			});
		}
		if (isScheduleLikeField(finding.field) && source && source.type !== "primary") {
			pushIssue(issues, {
				code: "schedule_non_primary",
				message: `Fee/price finding ${finding.id} cites a non-primary source (${source.type}: ${finding.sourceUrl}). Evidence ranking prefers official fee/pricing paths.`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
				url: finding.sourceUrl,
			});
		}
		if (isOverstuffedValue(finding.value)) {
			pushIssue(issues, {
				code: "overstuffed_cell",
				message: `Finding ${finding.id} packs many priced items into one cell (${finding.entity}/${finding.field}). Prefer splitting the plan into atomic entities (quality note — does not alone fail verify).`,
				entity: finding.entity,
				field: finding.field,
				findingId: finding.id,
			});
		}
	}

	for (const entity of findAggregateEntities(input.plan.entities)) {
		pushIssue(issues, {
			code: "aggregate_entity",
			message: `Planned entity "${entity}" looks like a category/catalog bag, not an atomic comparison unit. Split into concrete units (one product/plan/SKU/version per entity).`,
			entity,
		});
	}

	const entityMatches: Array<{ planned: string; matchedAs: string }> = [];
	const entitiesMissing: string[] = [];
	for (const entity of input.plan.entities) {
		const matchedAs = findCoveringLabel(entity, recordedEntities, aliases.byName.get(entity) ?? []);
		if (matchedAs) entityMatches.push({ planned: entity, matchedAs });
		else {
			entitiesMissing.push(entity);
			pushIssue(issues, {
				code: "missing_entity_coverage",
				message: `No findings for planned entity "${entity}". Record findings or an explicit not_found row.`,
				entity,
			});
		}
	}

	const dimensionMatches: Array<{ planned: string; matchedAs: string }> = [];
	const dimensionsMissing: string[] = [];
	for (const field of dims) {
		const matchedField = [...recordedFields].find((r) => fieldsMatch(field, r));
		if (matchedField) dimensionMatches.push({ planned: field, matchedAs: matchedField });
		else {
			dimensionsMissing.push(field);
			pushIssue(issues, {
				code: "missing_dimension_coverage",
				message: `No findings for required dimension/field "${field}".`,
				field,
			});
		}
	}

	// Cell matrix: coverage from the ledger (source of truth), not mere finding presence
	const sourceConfidenceByUrl = new Map(input.sources.map((s) => [s.url, sourceTypeConfidence(s.type)] as const));
	const ledger = buildCellLedger({
		plan: input.plan,
		findings: input.findings,
		asOf: input.plan.asOfDate,
		entityAliases: aliases.byName,
		sources: input.sources,
		sourceConfidenceByUrl,
	});

	const cellsMissing: Array<{ entity: string; field: string }> = [];
	let cellsActivelyCovered = 0;
	for (const entity of input.plan.entities) {
		for (const field of dims) {
			const cell = ledger.byKey.get(cellKey(entity, field));
			if (!cell || cell.status === "missing") {
				cellsMissing.push({ entity, field });
				pushIssue(issues, {
					code: "missing_cell_coverage",
					message: `Missing required cell: entity "${entity}" × field "${field}". Record observed or not_found.`,
					entity,
					field,
				});
				continue;
			}
			if (cell.status === "conflict") {
				continue;
			}
			if (cell.status === "expired" && isTimeBoundOfferField(field)) {
				pushIssue(issues, {
					code: "expired_offer_unreplaced",
					message: `Time-bound offer for "${entity}" × "${field}" is expired (until ${cell.validTo ?? "?"}). Find a current offer or record not_found for no active offer — expired ≠ covered.`,
					entity,
					field,
				});
				continue;
			}
			if (
				isScheduleLikeField(field) &&
				cell.evidenceScore &&
				!cell.publishable &&
				cell.status === "inferred" &&
				cell.value
			) {
				pushIssue(issues, {
					code: "low_evidence_winner",
					message: `Fee/price cell "${entity}" × "${field}" winner scored ${cell.evidenceScore.total.toFixed(2)} (pathIntent=${cell.evidenceScore.pathIntent.toFixed(2)}, freshness=${cell.evidenceScore.freshness.toFixed(2)}) — below publish threshold. Prefer a fresher fee/pricing page over contracts/aggregators.`,
					entity,
					field,
					url: cell.sourceUrl,
				});
			} else if (cell.evidenceScore && cell.evidenceScore.freshness <= -1 && cell.publishable) {
				pushIssue(issues, {
					code: "stale_document_winner",
					message: `Cell "${entity}" × "${field}" published from a dated/stale-looking document (freshness=${cell.evidenceScore.freshness}). Prefer a newer schedule page if available.`,
					entity,
					field,
					url: cell.sourceUrl,
				});
			}
			cellsActivelyCovered++;
		}
	}

	const thinFacets = missingPlanFacets(input.plan.question, dims);
	if (thinFacets.length > 0) {
		pushIssue(issues, {
			code: "thin_plan_facets",
			message: `Question implies facets [${thinFacets.join(", ")}] that are missing from requiredDimensions. Consider adding matching dimensions (quality note — does not alone fail verify).`,
		});
	}

	if (input.openQuestions.length > 0) {
		pushIssue(issues, {
			code: "open_questions_remain",
			message: `${input.openQuestions.length} open question(s) remain. Resolve or document as not_found before finalize.`,
		});
	}

	const unfetchedMustFetch = discovered
		.filter((d) => d.mustFetch && d.status === "discovered")
		.sort((a, b) => b.rankScore - a.rankScore);

	for (const d of unfetchedMustFetch) {
		pushIssue(issues, {
			code: "unfetched_discovered",
			message: `Search discovered must-fetch URL but it was not web_fetch'd (or skipped): ${d.url}${d.title ? ` (${d.title})` : ""}. Fetch it, or research_skip_discovered with a reason.`,
			url: d.url,
		});
	}

	for (const c of ledger.conflicts) {
		pushIssue(issues, {
			code: "cell_conflict",
			message: `Conflicting values for ${c.entity} × ${c.field}: ${c.values.join(" ≠ ")}. Do not auto-average — higher evidence score wins only among non-conflicting values; resolve or mark status=conflict.`,
			entity: c.entity,
			field: c.field,
		});
	}
	for (const f of input.findings) {
		if (f.status !== "observed") continue;
		if (isTimeBoundOfferField(f.field) && !f.validTo?.trim()) {
			pushIssue(issues, {
				code: "campaign_missing_end_date",
				message: `Observed time-bound offer ${f.id} (${f.entity}/${f.field}) has no validTo. Set an end date, or move standing benefits to a separate non-offer dimension.`,
				entity: f.entity,
				field: f.field,
				findingId: f.id,
			});
		}
	}

	const cellTotal = input.plan.entities.length * dims.length;
	const hardIssues = issues.filter((i) => i.severity === "hard");
	const qualityNotes = issues.filter((i) => i.severity === "quality");

	return {
		ok: hardIssues.length === 0,
		runId: input.plan.id,
		policy: policy.name,
		stats: {
			entities: input.plan.entities.length,
			dimensions: dims.length,
			cells: cellTotal,
			cellsCovered: cellsActivelyCovered,
			sources: input.sources.length,
			findings: input.findings.length,
			observed: input.findings.filter((f) => f.status === "observed").length,
			notFound: input.findings.filter((f) => f.status === "not_found").length,
			conflicts: ledger.conflicts.length,
			openQuestions: input.openQuestions.length,
			primarySources: input.sources.filter((s) => s.type === "primary").length,
			secondarySources: input.sources.filter((s) => s.type === "secondary").length,
			discovered: discovered.length,
			unfetchedMustFetch: unfetchedMustFetch.length,
			softObserved,
			hardIssues: hardIssues.length,
			qualityIssues: qualityNotes.length,
		},
		coverage: {
			entitiesCovered: entityMatches.map((m) => m.planned),
			entitiesMissing,
			dimensionsCovered: dimensionMatches.map((m) => m.planned),
			dimensionsMissing,
			cellsMissing,
			entityMatches,
			dimensionMatches,
		},
		unfetchedMustFetch: unfetchedMustFetch.map((d) => ({
			url: d.url,
			title: d.title,
			query: d.query,
			sourceType: d.sourceType,
		})),
		issues,
		qualityNotes,
		cellLedger: {
			asOf: ledger.asOf,
			publishable: ledger.publishable.length,
			conflicts: ledger.conflicts.length,
			expired: ledger.expired.length,
			missing: ledger.missing.length,
		},
	};
}

export function formatVerifyReport(report: VerifyReport): string {
	const lines: string[] = [];
	lines.push(`Research verify: ${report.ok ? "PASS" : "FAIL"} (run ${report.runId}, policy=${report.policy})`);
	lines.push(
		`Stats: sources=${report.stats.sources} (primary=${report.stats.primarySources}, secondary=${report.stats.secondarySources}), findings=${report.stats.findings} (observed=${report.stats.observed}, not_found=${report.stats.notFound}, conflict=${report.stats.conflicts}), open_questions=${report.stats.openQuestions}`,
	);
	lines.push(
		`Discovery: discovered=${report.stats.discovered}, unfetched_must_fetch=${report.stats.unfetchedMustFetch}, soft_observed=${report.stats.softObserved}`,
	);
	lines.push(
		`Coverage: entities ${report.coverage.entitiesCovered.length}/${report.stats.entities}, dimensions ${report.coverage.dimensionsCovered.length}/${report.stats.dimensions}, cells ${report.stats.cellsCovered}/${report.stats.cells}`,
	);
	lines.push(
		`Issues: hard=${report.stats.hardIssues}, quality=${report.stats.qualityIssues} (ok = hard blockers only)`,
	);
	if (report.cellLedger) {
		lines.push(
			`Ledger: asOf=${report.cellLedger.asOf} publishable=${report.cellLedger.publishable} conflicts=${report.cellLedger.conflicts} expired=${report.cellLedger.expired} missing=${report.cellLedger.missing}`,
		);
	}

	if (report.coverage.entityMatches.some((m) => m.planned !== m.matchedAs)) {
		lines.push("Entity matches (planned → recorded):");
		for (const m of report.coverage.entityMatches) {
			if (m.planned !== m.matchedAs) lines.push(`- ${m.planned} → ${m.matchedAs}`);
		}
	}

	if (report.coverage.entitiesMissing.length > 0) {
		lines.push(`Missing entities: ${report.coverage.entitiesMissing.join(", ")}`);
	}
	if (report.coverage.dimensionsMissing.length > 0) {
		lines.push(`Missing dimensions: ${report.coverage.dimensionsMissing.join(", ")}`);
	}
	if (report.coverage.cellsMissing.length > 0) {
		lines.push("");
		lines.push(`Missing cells (${report.coverage.cellsMissing.length}):`);
		for (const cell of report.coverage.cellsMissing.slice(0, 30)) {
			lines.push(`- ${cell.entity} × ${cell.field}`);
		}
		if (report.coverage.cellsMissing.length > 30) {
			lines.push(`- ... +${report.coverage.cellsMissing.length - 30} more`);
		}
	}
	if (report.unfetchedMustFetch.length > 0) {
		lines.push("");
		lines.push("Unfetched must-fetch URLs (web_fetch or research_skip_discovered):");
		for (const u of report.unfetchedMustFetch.slice(0, 20)) {
			lines.push(`- [${u.sourceType}] ${u.url}${u.title ? ` — ${u.title}` : ""}`);
		}
		if (report.unfetchedMustFetch.length > 20) {
			lines.push(`- ... +${report.unfetchedMustFetch.length - 20} more`);
		}
	}

	const hard = report.issues.filter((i) => i.severity === "hard");
	const quality = report.qualityNotes;
	if (hard.length > 0) {
		lines.push("");
		lines.push("Hard blockers:");
		for (const issue of hard) {
			lines.push(`- [${issue.code}] ${issue.message}`);
		}
	}
	if (quality.length > 0) {
		lines.push("");
		lines.push("Quality notes (do not alone fail verify):");
		for (const issue of quality) {
			lines.push(`- [${issue.code}] ${issue.message}`);
		}
	}

	return lines.join("\n");
}

/** Build a mandatory VERIFY FAIL banner for partial packages. */
export function buildVerifyFailBanner(report: VerifyReport): string {
	const lines = [
		"> **VERIFY FAIL — partial research package**",
		">",
		`> Run \`${report.runId}\` did not pass research_verify. Treat the brief as incomplete.`,
		">",
	];
	if (report.coverage.entitiesMissing.length > 0) {
		lines.push(`> Missing entities: ${report.coverage.entitiesMissing.join("; ")}`);
	}
	if (report.coverage.dimensionsMissing.length > 0) {
		lines.push(`> Missing dimensions: ${report.coverage.dimensionsMissing.join("; ")}`);
	}
	if (report.coverage.cellsMissing.length > 0) {
		const preview = report.coverage.cellsMissing
			.slice(0, 12)
			.map((c) => `${c.entity} × ${c.field}`)
			.join("; ");
		const more =
			report.coverage.cellsMissing.length > 12 ? ` (+${report.coverage.cellsMissing.length - 12} more)` : "";
		lines.push(`> Missing cells: ${preview}${more}`);
	}
	if (report.stats.openQuestions > 0) {
		lines.push(`> Open questions: ${report.stats.openQuestions}`);
	}
	if (report.stats.unfetchedMustFetch > 0) {
		lines.push(`> Unfetched must-fetch URLs: ${report.stats.unfetchedMustFetch}`);
	}
	if (report.stats.softObserved > 0) {
		lines.push(`> Soft observed findings: ${report.stats.softObserved}`);
	}
	const topIssues = report.issues
		.filter((i) => i.severity === "hard")
		.slice(0, 8)
		.map((i) => `> - [${i.code}] ${i.message}`);
	if (topIssues.length > 0) {
		lines.push(">");
		lines.push(...topIssues);
	}
	lines.push("");
	return lines.join("\n");
}

/** Short user-facing incompleteness note (no run ids / URL dumps). */
export function ensurePartialBriefBanner(briefMarkdown: string, report: VerifyReport): string {
	if (report.ok) return briefMarkdown;
	const note =
		"> **Incomplete research package:** Some cells were not verified or conflicted. Only publishable rows appear below.\n\n";
	const stripped = briefMarkdown
		.replace(/^>\s*\*\*VERIFY FAIL[\s\S]*?(?:\n\n|$)/, "")
		.replace(/^>\s*\*\*Incomplete research package:[\s\S]*?(?:\n\n|$)/, "")
		.replace(/^>\s*\*\*Eksik \/ kısmi cevap:[\s\S]*?(?:\n\n|$)/, "")
		.replace(/^>\s*\*\*Partial[\s\S]*?(?:\n\n|$)/, "");
	if (/^\s*>\s*\*\*(Incomplete|Eksik)/.test(briefMarkdown)) return briefMarkdown;
	return `${note}${stripped.trimStart()}`;
}

/** Offline audit metrics for a completed/partial run (diagnostic, not a gate by itself). */
export function auditResearch(input: {
	plan: ResearchPlan;
	sources: SourceRecord[];
	findings: FindingRecord[];
	discovered: DiscoveredUrl[];
}): {
	softObservedCount: number;
	unfetchedCitationCount: number;
	unfetchedMustFetchCount: number;
	observedWithoutEvidence: number;
	failureMode: "search_miss" | "fetch_skip" | "soft_record" | "ok_or_other";
} {
	const fetched = buildFetchedUrlSet(input.sources, input.discovered);
	let softObservedCount = 0;
	let unfetchedCitationCount = 0;
	let observedWithoutEvidence = 0;
	for (const f of input.findings) {
		if (f.status !== "observed") continue;
		if (isSoftPlaceholderValue(f.value)) softObservedCount++;
		if (!f.evidence.trim()) observedWithoutEvidence++;
		if (f.sourceUrl && !fetched.has(f.sourceUrl)) unfetchedCitationCount++;
	}
	const unfetchedMustFetchCount = input.discovered.filter((d) => d.mustFetch && d.status === "discovered").length;

	let failureMode: "search_miss" | "fetch_skip" | "soft_record" | "ok_or_other" = "ok_or_other";
	if (unfetchedMustFetchCount > 0 && softObservedCount > 0) failureMode = "fetch_skip";
	else if (softObservedCount > 0) failureMode = "soft_record";
	else if (unfetchedMustFetchCount > 0) failureMode = "fetch_skip";
	else if (input.discovered.length === 0 && input.findings.some((f) => f.status === "not_found")) {
		failureMode = "search_miss";
	}

	return {
		softObservedCount,
		unfetchedCitationCount,
		unfetchedMustFetchCount,
		observedWithoutEvidence,
		failureMode,
	};
}
