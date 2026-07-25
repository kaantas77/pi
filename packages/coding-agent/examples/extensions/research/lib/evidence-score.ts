import { isOverstuffedValue } from "./entity-quality.ts";
import { labelTokens, normalizeLabel } from "./normalize.ts";
import { isScheduleLikeField, isTimeBoundOfferField } from "./plan-scope.ts";
import type { SourceType } from "./policy.ts";
import { isSoftPlaceholderValue } from "./soft.ts";

export interface EvidenceScoreParts {
	sourceClass: number;
	pathIntent: number;
	freshness: number;
	specificity: number;
	concreteness: number;
	total: number;
}

export interface ScoreEvidenceInput {
	url: string;
	field: string;
	entity: string;
	value: string;
	sourceType: SourceType;
	asOf: string;
	/** Optional page title or snippet for date/title cues */
	titleOrSnippet?: string;
}

const FEE_PATH_BOOST =
	/fee|fees|pricing|price-list|ucret|ücret|faiz|tarif|rate-?schedule|uyelik-?bedeli|üyelik-?bedeli|aidat|annual/i;
const LEGAL_PATH_PENALTY =
	/sozlesme|sözleşme|contract|terms|conditions|membership-agreement|uyelik-sozlesmesi|üyelik-sözleşmesi|legal\/terms/i;
const OFFER_PATH = /kampanya|campaign|promo|promotion|offer|indirim|welcome|hos-?geldin/i;
const ACCESS_PATH = /lounge|fast-?track|airport|havaliman/i;
const EARN_PATH = /puan|point|mil|mile|reward|cashback|kazan/i;

/**
 * Rank evidence for a cell candidate. Higher wins.
 * Domain-agnostic path cues — prefers intent-matching docs over merely "official" stale contracts.
 */
export function scoreEvidence(input: ScoreEvidenceInput): EvidenceScoreParts {
	const sourceClass = scoreSourceClass(input.sourceType);
	const pathIntent = scorePathIntent(input.url, input.field, input.titleOrSnippet);
	const freshness = scoreFreshness(input.url, input.value, input.titleOrSnippet, input.asOf);
	const specificity = scoreSpecificity(input.entity, input.value, input.url, input.titleOrSnippet);
	const concreteness = scoreConcreteness(input.value, input.field);

	const total = sourceClass + pathIntent + freshness + specificity + concreteness;
	return { sourceClass, pathIntent, freshness, specificity, concreteness, total };
}

export function scoreSourceClass(type: SourceType): number {
	if (type === "primary") return 3;
	if (type === "unknown") return 1.5;
	if (type === "secondary") return 0.4;
	return 1;
}

export function scorePathIntent(url: string, field: string, titleOrSnippet?: string): number {
	const hay = `${url} ${titleOrSnippet ?? ""}`.toLowerCase();
	let score = 0;

	if (isScheduleLikeField(field)) {
		const feeHit = FEE_PATH_BOOST.test(hay);
		const legalHit = LEGAL_PATH_PENALTY.test(hay);
		if (feeHit) score += 4;
		if (legalHit) score -= 3.5;
		if (!feeHit && !legalHit) score -= 0.5;
	} else if (isTimeBoundOfferField(field)) {
		if (OFFER_PATH.test(hay)) score += 3;
		if (LEGAL_PATH_PENALTY.test(hay)) score -= 1;
	} else if (/\b(lounge|access|erisim|erişim|havaliman)\b/i.test(normalizeLabel(field))) {
		if (ACCESS_PATH.test(hay)) score += 2.5;
	} else if (/\b(puan|point|mil|earn|kazan|reward)\b/i.test(normalizeLabel(field))) {
		if (EARN_PATH.test(hay)) score += 2;
	}

	return score;
}

export function scoreFreshness(url: string, value: string, titleOrSnippet: string | undefined, asOf: string): number {
	const asOfDay = asOf.slice(0, 10);
	const dates = collectCandidateDates(`${url} ${value} ${titleOrSnippet ?? ""}`);
	if (dates.length === 0) return -0.75; // undated docs lose to dated ones

	const latest = dates.sort().at(-1)!;
	const ageDays = daysBetween(latest, asOfDay);
	if (ageDays < 0) return 0.5; // slight future noise
	if (ageDays <= 90) return 2.5;
	if (ageDays <= 180) return 1.5;
	if (ageDays <= 365) return 0.5;
	if (ageDays <= 730) return -1;
	return -2.5; // older than ~2 years
}

export function scoreSpecificity(entity: string, value: string, url: string, titleOrSnippet?: string): number {
	const entityTokens = labelTokens(entity).filter((t) => t.length >= 3);
	if (entityTokens.length === 0) return 0;
	const hay = normalizeLabel(`${value} ${url} ${titleOrSnippet ?? ""}`);
	let hits = 0;
	for (const t of entityTokens) {
		if (hay.includes(t)) hits++;
	}
	return (hits / entityTokens.length) * 2;
}

export function scoreConcreteness(value: string, field: string): number {
	if (isSoftPlaceholderValue(value)) return -5;
	let score = 0;
	if (/\d/.test(value)) score += 1;
	if (/(?:tl|try|usd|eur|%|\bmil\b|\bpoint\b)/i.test(value)) score += 0.75;
	if (isScheduleLikeField(field) && isOverstuffedValue(value)) score -= 2;
	if (isTimeBoundOfferField(field) && /\b(20\d{2}|son\s*:|until|biti[sş])/i.test(value)) score += 0.5;
	return score;
}

/** Minimum total score for a fee/schedule cell to be publishable when source is not primary with good path intent. */
export const MIN_SCHEDULE_PUBLISH_SCORE = 2.5;

export function meetsSchedulePublishThreshold(parts: EvidenceScoreParts, sourceType: SourceType): boolean {
	if (sourceType === "primary") return parts.total >= 1.5;
	return parts.total >= MIN_SCHEDULE_PUBLISH_SCORE;
}

function collectCandidateDates(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
		out.push(`${m[1]}-${m[2]}-${m[3]}`);
	}
	// Path segments like /2025/ or _2026_
	for (const m of text.matchAll(/(?:^|[^\d])(20\d{2})(?:[^\d]|$)/g)) {
		const y = m[1];
		// Only treat bare year as mid-year anchor when in path-ish context
		if (/\/20\d{2}\/|_20\d{2}_|-20\d{2}-/.test(text)) {
			out.push(`${y}-06-30`);
		}
	}
	const tr = text.matchAll(
		/(\d{1,2})\s*(Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s*(20\d{2})/gi,
	);
	const months: Record<string, string> = {
		ocak: "01",
		şubat: "02",
		subat: "02",
		mart: "03",
		nisan: "04",
		mayıs: "05",
		mayis: "05",
		haziran: "06",
		temmuz: "07",
		ağustos: "08",
		agustos: "08",
		eylül: "09",
		eylul: "09",
		ekim: "10",
		kasım: "11",
		kasim: "11",
		aralık: "12",
		aralik: "12",
	};
	for (const m of tr) {
		const mon = months[m[2].toLowerCase()];
		if (mon) out.push(`${m[3]}-${mon}-${m[1].padStart(2, "0")}`);
	}
	return out;
}

function daysBetween(earlier: string, later: string): number {
	const a = Date.parse(`${earlier}T00:00:00.000Z`);
	const b = Date.parse(`${later}T00:00:00.000Z`);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return 9999;
	return Math.round((b - a) / (24 * 60 * 60 * 1000));
}
