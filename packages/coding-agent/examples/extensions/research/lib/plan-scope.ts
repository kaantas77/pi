import { normalizeLabel } from "./normalize.ts";

/** Soft cap: above this, research_init warns and finalize rejects sparse force. */
export const MAX_REQUIRED_CELLS = 48;
export const MIN_FORCE_COVERAGE_RATIO = 0.5;

/** Fields that usually need a dedicated schedule/fee page, not a marketing landing page. */
const SCHEDULE_FIELD_HINTS = /\b(ucret|ücret|fee|price|pricing|cost|faiz|annual|yillik|yıllık|membership)\b/i;

const PAGE_ABSENCE_NOT_FOUND =
	/\b(belirtilmemi[sş]|yer\s+alm[ıi]yor|bulunmamaktad[ıi]r|sayfas[ıi]nda\s+(yok|belirtil|yer\s+alm)|not\s+(listed|specified|shown|available)\s+on\b|ürün\s+sayfas[ıi]|product\s+page)\b/i;

export interface MatrixPlan {
	entities: string[];
	dimensions: string[];
	requiredDimensions?: string[];
}

/**
 * Matrix gate uses requiredDimensions when set; otherwise all dimensions.
 * optionalDimensions are nice-to-have and never block verify.
 */
export function matrixDimensions(plan: MatrixPlan): string[] {
	const required = plan.requiredDimensions?.length ? plan.requiredDimensions : plan.dimensions;
	return required;
}

export function pickDefaultRequiredDimensions(dimensions: string[]): string[] {
	if (dimensions.length <= 5) return [...dimensions];
	const scored = dimensions.map((d, i) => {
		const n = normalizeLabel(d);
		let score = 0;
		if (SCHEDULE_FIELD_HINTS.test(n)) score += 5;
		if (/\b(kampanya|campaign|promo|avantaj|benefit|lounge|mil|point|puan)\b/i.test(n)) score += 3;
		if (/\b(fast\s*track|varlik|varlık|hos\s*geldin|welcome)\b/i.test(n)) score += 1;
		return { d, score, i };
	});
	scored.sort((a, b) => b.score - a.score || a.i - b.i);
	const picked = new Set(scored.slice(0, 5).map((x) => x.d));
	return dimensions.filter((d) => picked.has(d));
}

/** If the question mentions lounge/fee/campaign, pull matching dims into required. */
export function promoteQuestionDimensions(question: string, required: string[], allDims: string[]): string[] {
	const q = normalizeLabel(question);
	const out = [...required];
	const push = (dim: string) => {
		if (!out.some((d) => normalizeLabel(d) === normalizeLabel(dim))) out.push(dim);
	};
	for (const dim of allDims) {
		const n = normalizeLabel(dim);
		if (/\blounge\b/.test(q) && /\blounge\b/.test(n)) push(dim);
		if (/\b(ucret|ücret|fee|aidat)\b/.test(q) && SCHEDULE_FIELD_HINTS.test(n)) push(dim);
		if (/\b(kampanya|campaign)\b/.test(q) && /\b(kampanya|campaign|promo)\b/.test(n)) push(dim);
	}
	return out.slice(0, 6);
}

export function planCellCount(plan: MatrixPlan): number {
	return plan.entities.length * matrixDimensions(plan).length;
}

export function isPlanOversized(plan: MatrixPlan): boolean {
	return planCellCount(plan) > MAX_REQUIRED_CELLS;
}

export function isScheduleLikeField(field: string): boolean {
	return SCHEDULE_FIELD_HINTS.test(normalizeLabel(field));
}

/**
 * Time-bound offers (need validTo). Ongoing product benefits (lounge, features) are NOT this.
 * Matches plural/snake forms: current_campaigns, campaigns, offers, promos.
 */
export function isTimeBoundOfferField(field: string): boolean {
	const n = normalizeLabel(field);
	return /\b(kampanya|kampanyalar|campaigns?|promos?|promotions?|offers?|indirim\s*kamp|hos\s*geldin|welcome|aktif\s+kamp|current\s+campaigns?)\b/i.test(
		n,
	);
}

/** @deprecated use isTimeBoundOfferField — kept for call-site compatibility */
export function isCampaignLikeField(field: string): boolean {
	return isTimeBoundOfferField(field);
}

/** Continuous product attributes (benefits, lounge, earn rates) — no end-date required. */
export function isOngoingBenefitField(field: string): boolean {
	const n = normalizeLabel(field);
	if (isTimeBoundOfferField(field)) return false;
	return /\b(avantaj|benefit|lounge|ozellik|özellik|feature|puan|point|mil|reward|kazanim|kazanım)\b/i.test(n);
}

/** "Not on the marketing page" is not a valid global not_found for fee/price fields. */
export function isPageAbsenceNotFound(value: string): boolean {
	return PAGE_ABSENCE_NOT_FOUND.test(value.trim());
}

export function urlLooksLikeSchedule(url: string): boolean {
	const u = url.toLowerCase();
	return /ucret|ücret|fee|faiz|pricing|price|tarif|rate|schedule|uyelik|üyelik/.test(u);
}

export function rankBoostForQuery(url: string, query?: string): number {
	let boost = 0;
	const path = url.toLowerCase();
	if (urlLooksLikeSchedule(path)) boost += 1.5;
	if (/kampanya|campaign|promo|avantaj/.test(path)) boost += 0.75;
	if (!query) return boost;
	const q = normalizeLabel(query);
	for (const token of q.split(" ").filter((t) => t.length >= 4)) {
		if (path.includes(token)) boost += 0.25;
	}
	return boost;
}

export function coverageRatio(cellsCovered: number, cells: number): number {
	if (cells <= 0) return 1;
	return cellsCovered / cells;
}

/** Clamp research as-of date to near "today" so agents cannot freeze the ledger in the wrong year. */
export function resolveAsOfDate(input?: string, now = new Date()): string {
	const today = now.toISOString().slice(0, 10);
	const raw = input?.trim();
	if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return today;
	const maxPastMs = 3 * 24 * 60 * 60 * 1000;
	const maxFutureMs = 24 * 60 * 60 * 1000;
	const t = Date.parse(`${raw}T00:00:00.000Z`);
	const n = Date.parse(`${today}T00:00:00.000Z`);
	if (!Number.isFinite(t)) return today;
	if (n - t > maxPastMs) return today;
	if (t - n > maxFutureMs) return today;
	return raw;
}
