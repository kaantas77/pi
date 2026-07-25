import type { FindingRecord, ResearchPlan, SourceRecord } from "./artifacts.ts";
import { inferValidToFromValue, parseIsoDate } from "./dates.ts";
import { type EvidenceScoreParts, meetsSchedulePublishThreshold, scoreEvidence } from "./evidence-score.ts";
import { fieldsMatch, labelsMatch, normalizeLabel } from "./normalize.ts";
import { isScheduleLikeField, isTimeBoundOfferField, matrixDimensions } from "./plan-scope.ts";
import type { SourceType } from "./policy.ts";

export type CellFreshness = "current" | "expired" | "unknown";
export type CellPublishStatus = "publishable" | "conflict" | "expired" | "not_found" | "missing" | "inferred";

export interface LedgerCell {
	entity: string;
	field: string;
	/** Winning display value when publishable */
	value?: string;
	sourceUrl?: string;
	findingIds: string[];
	values: string[];
	status: CellPublishStatus;
	freshness: CellFreshness;
	validFrom?: string;
	validTo?: string;
	publishable: boolean;
	/** Evidence ranking for the winning candidate (diagnostic / quality notes) */
	evidenceScore?: EvidenceScoreParts;
}

export interface CellLedger {
	asOf: string;
	cells: LedgerCell[];
	byKey: Map<string, LedgerCell>;
	conflicts: LedgerCell[];
	expired: LedgerCell[];
	missing: LedgerCell[];
	publishable: LedgerCell[];
}

export function cellKey(entity: string, field: string): string {
	return `${normalizeLabel(entity)}::${normalizeLabel(field)}`;
}

export { isTimeBoundOfferField };
export { inferValidToFromValue } from "./dates.ts";
export { isCampaignLikeField } from "./plan-scope.ts";

export function valuesConflict(a: string, b: string): boolean {
	const na = normalizeLabel(a);
	const nb = normalizeLabel(b);
	if (!na || !nb) return false;
	if (na === nb) return false;
	// One contains the other → elaboration, not conflict
	if (na.includes(nb) || nb.includes(na)) return false;

	const feesA = extractMoneyAmounts(a);
	const feesB = extractMoneyAmounts(b);
	if (feesA.length > 0 && feesB.length > 0) {
		// Same fee field with different primary amounts → conflict
		if (feesA[0] !== feesB[0]) return true;
		return false;
	}

	// Long multi-claim blobs: only conflict if token overlap is low (likely different entities mixed)
	if (na.length > 100 && nb.length > 100) {
		const ta = new Set(na.split(" ").filter((t) => t.length > 3));
		const tb = new Set(nb.split(" ").filter((t) => t.length > 3));
		if (ta.size === 0 || tb.size === 0) return true;
		let inter = 0;
		for (const t of ta) if (tb.has(t)) inter++;
		const jaccard = inter / (ta.size + tb.size - inter);
		return jaccard < 0.35;
	}

	return true;
}

function extractMoneyAmounts(value: string): number[] {
	const out: number[] = [];
	const re = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:tl|try)/gi;
	for (const m of value.matchAll(re)) {
		const n = Number(m[1].replace(/[.\s]/g, "").replace(",", "."));
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

export function resolveFreshness(input: {
	asOf: string;
	validTo?: string;
	value: string;
	field: string;
}): CellFreshness {
	// Standing attributes (fees, lounge, earn rates) do not expire via dates in prose.
	if (!isTimeBoundOfferField(input.field)) return "current";

	const end = parseIsoDate(input.validTo) ?? inferValidToFromValue(input.value);
	if (!end) return "unknown";
	return end < input.asOf.slice(0, 10) ? "expired" : "current";
}

function findMatchingFindings(
	entity: string,
	field: string,
	findings: FindingRecord[],
	aliases: string[],
): FindingRecord[] {
	return findings.filter((f) => labelsMatch(entity, f.entity, aliases) && fieldsMatch(field, f.field));
}

export function buildCellLedger(input: {
	plan: ResearchPlan;
	findings: FindingRecord[];
	asOf?: string;
	entityAliases?: Map<string, string[]>;
	/** Optional sources for evidence scoring (type + title). Preferred over raw confidence map. */
	sources?: SourceRecord[];
	/** @deprecated prefer sources — url → legacy confidence fallback */
	sourceConfidenceByUrl?: Map<string, number>;
}): CellLedger {
	const asOf = (input.asOf ?? new Date().toISOString()).slice(0, 10);
	const dims = matrixDimensions(input.plan);
	const cells: LedgerCell[] = [];
	const byKey = new Map<string, LedgerCell>();
	const sourceByUrl = new Map((input.sources ?? []).map((s) => [s.url, s]));

	for (const entity of input.plan.entities) {
		const aliases = input.entityAliases?.get(entity) ?? [];
		for (const field of dims) {
			const rows = findMatchingFindings(entity, field, input.findings, aliases);
			const key = cellKey(entity, field);
			const cell = buildOneCell({
				entity,
				field,
				rows,
				asOf,
				sourceByUrl,
				sourceConfidenceByUrl: input.sourceConfidenceByUrl,
			});
			cells.push(cell);
			byKey.set(key, cell);
		}
	}

	return {
		asOf,
		cells,
		byKey,
		conflicts: cells.filter((c) => c.status === "conflict"),
		expired: cells.filter((c) => c.status === "expired"),
		missing: cells.filter((c) => c.status === "missing"),
		publishable: cells.filter((c) => c.publishable),
	};
}

function buildOneCell(input: {
	entity: string;
	field: string;
	rows: FindingRecord[];
	asOf: string;
	sourceByUrl: Map<string, SourceRecord>;
	sourceConfidenceByUrl?: Map<string, number>;
}): LedgerCell {
	const { entity, field, rows, asOf } = input;
	if (rows.length === 0) {
		return {
			entity,
			field,
			findingIds: [],
			values: [],
			status: "missing",
			freshness: "unknown",
			publishable: false,
		};
	}

	const notFound = rows.filter((r) => r.status === "not_found");
	const conflicts = rows.filter((r) => r.status === "conflict");
	const observed = rows.filter((r) => r.status === "observed");
	const inferred = rows.filter((r) => r.status === "inferred");

	if (conflicts.length > 0 || hasValueConflicts(observed)) {
		const vals = [...new Set([...conflicts, ...observed].map((r) => r.value))];
		return {
			entity,
			field,
			findingIds: rows.map((r) => r.id),
			values: vals,
			status: "conflict",
			freshness: "unknown",
			publishable: false,
		};
	}

	if (observed.length === 0 && notFound.length > 0) {
		return {
			entity,
			field,
			value: notFound[0].value,
			findingIds: rows.map((r) => r.id),
			values: notFound.map((r) => r.value),
			status: "not_found",
			freshness: "unknown",
			publishable: false,
		};
	}

	const picked =
		pickByEvidenceScore(observed, entity, field, asOf, input.sourceByUrl, input.sourceConfidenceByUrl) ??
		pickByEvidenceScore(inferred, entity, field, asOf, input.sourceByUrl, input.sourceConfidenceByUrl);
	if (!picked) {
		return {
			entity,
			field,
			findingIds: rows.map((r) => r.id),
			values: rows.map((r) => r.value),
			status: "missing",
			freshness: "unknown",
			publishable: false,
		};
	}
	const { row: primary, score: evidenceScore, sourceType } = picked;

	const validTo =
		parseIsoDate(primary.validTo) ??
		(isTimeBoundOfferField(field) ? inferValidToFromValue(primary.value) : undefined);
	const validFrom = parseIsoDate(primary.validFrom);
	const freshness = resolveFreshness({
		asOf,
		validTo: primary.validTo ?? validTo,
		value: primary.value,
		field,
	});

	if (freshness === "expired") {
		return {
			entity,
			field,
			value: primary.value,
			sourceUrl: primary.sourceUrl || undefined,
			findingIds: rows.map((r) => r.id),
			values: [primary.value],
			status: "expired",
			freshness: "expired",
			validFrom,
			validTo,
			publishable: false,
			evidenceScore,
		};
	}

	// Time-bound offers without a resolvable end date must not publish as "active"
	if (isTimeBoundOfferField(field) && freshness === "unknown") {
		return {
			entity,
			field,
			value: primary.value,
			sourceUrl: primary.sourceUrl || undefined,
			findingIds: rows.map((r) => r.id),
			values: [primary.value],
			status: "inferred",
			freshness: "unknown",
			validFrom,
			validTo,
			publishable: false,
			evidenceScore,
		};
	}

	// Fee/schedule cells need enough evidence score to publish (secondary/stale contracts lose)
	const scheduleOk = !isScheduleLikeField(field) || meetsSchedulePublishThreshold(evidenceScore, sourceType);
	const publishable = primary.status === "observed" && scheduleOk;
	return {
		entity,
		field,
		value: primary.value,
		sourceUrl: primary.sourceUrl || undefined,
		findingIds: rows.map((r) => r.id),
		values: [primary.value],
		status: publishable ? "publishable" : "inferred",
		freshness,
		validFrom,
		validTo,
		publishable,
		evidenceScore,
	};
}

function hasValueConflicts(observed: FindingRecord[]): boolean {
	for (let i = 0; i < observed.length; i++) {
		for (let j = i + 1; j < observed.length; j++) {
			if (valuesConflict(observed[i].value, observed[j].value)) return true;
		}
	}
	return false;
}

function resolveSourceType(
	url: string,
	sourceByUrl: Map<string, SourceRecord>,
	confidenceByUrl?: Map<string, number>,
): SourceType {
	const recorded = sourceByUrl.get(url);
	if (recorded) return recorded.type;
	const conf = confidenceByUrl?.get(url);
	if (conf === undefined) return "unknown";
	if (conf >= 0.9) return "primary";
	if (conf <= 0.4) return "secondary";
	return "unknown";
}

function pickByEvidenceScore(
	rows: FindingRecord[],
	entity: string,
	field: string,
	asOf: string,
	sourceByUrl: Map<string, SourceRecord>,
	confidenceByUrl?: Map<string, number>,
): { row: FindingRecord; score: EvidenceScoreParts; sourceType: SourceType } | undefined {
	if (rows.length === 0) return undefined;
	let best = rows[0];
	let bestType = resolveSourceType(best.sourceUrl, sourceByUrl, confidenceByUrl);
	const bestSource = sourceByUrl.get(best.sourceUrl);
	let bestScore = scoreEvidence({
		url: best.sourceUrl,
		field,
		entity,
		value: best.value,
		sourceType: bestType,
		asOf,
		titleOrSnippet: bestSource?.title ?? best.evidence,
	});
	// Tie-break with legacy confidence when scores equal
	let bestLegacy = confidenceByUrl?.get(best.sourceUrl) ?? 0;

	for (let i = 1; i < rows.length; i++) {
		const row = rows[i];
		const sourceType = resolveSourceType(row.sourceUrl, sourceByUrl, confidenceByUrl);
		const src = sourceByUrl.get(row.sourceUrl);
		const score = scoreEvidence({
			url: row.sourceUrl,
			field,
			entity,
			value: row.value,
			sourceType,
			asOf,
			titleOrSnippet: src?.title ?? row.evidence,
		});
		const legacy = confidenceByUrl?.get(row.sourceUrl) ?? 0;
		if (score.total > bestScore.total || (score.total === bestScore.total && legacy >= bestLegacy)) {
			best = row;
			bestScore = score;
			bestType = sourceType;
			bestLegacy = legacy;
		}
	}
	return { row: best, score: bestScore, sourceType: bestType };
}

export function formatCellLedgerSummary(ledger: CellLedger): string {
	const lines = [
		`Cell ledger asOf=${ledger.asOf}`,
		`publishable=${ledger.publishable.length}, conflicts=${ledger.conflicts.length}, expired=${ledger.expired.length}, missing=${ledger.missing.length}`,
	];
	if (ledger.conflicts.length > 0) {
		lines.push("Conflicts (not publishable):");
		for (const c of ledger.conflicts.slice(0, 20)) {
			lines.push(`- ${c.entity} × ${c.field}: ${c.values.join(" | ")}`);
		}
	}
	if (ledger.expired.length > 0) {
		lines.push("Expired (not active):");
		for (const c of ledger.expired.slice(0, 20)) {
			lines.push(`- ${c.entity} × ${c.field}: ${c.value ?? ""} (until ${c.validTo ?? "?"})`);
		}
	}
	return lines.join("\n");
}
