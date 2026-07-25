import { normalizeLabel } from "./normalize.ts";

/** Cross-domain facets a research question may require. */
export type ResearchFacet = "fee" | "offer" | "benefit" | "earn" | "access";

const FACET_QUESTION: Array<{ facet: ResearchFacet; re: RegExp }> = [
	{ facet: "fee", re: /\b(ucret|ücret|fee|price|pricing|cost|aidat|subscription|tarif)\b/i },
	{
		facet: "offer",
		re: /\b(kampanya|kampanyalar|campaigns?|promo|promotion|offers?|indirim\s*kamp|hos\s*geldin|welcome)\b/i,
	},
	{ facet: "benefit", re: /\b(avantaj|benefit|perk|ozellik|özellik|feature)\b/i },
	{ facet: "earn", re: /\b(puan|point|mil|mile|reward|cashback|kazan[iı]m|earn\s*rate)\b/i },
	{ facet: "access", re: /\b(lounge|fast\s*track|access|erisim|erişim)\b/i },
];

const FACET_DIM: Array<{ facet: ResearchFacet; re: RegExp }> = [
	{ facet: "fee", re: /\b(ucret|ücret|fee|price|pricing|cost|aidat|annual|yillik|yıllık)\b/i },
	{ facet: "offer", re: /\b(kampanya|kampanyalar|campaigns?|promo|offer|hos\s*geldin|welcome|aktif\s+kamp)\b/i },
	{ facet: "benefit", re: /\b(avantaj|benefit|perk|ozellik|özellik)\b/i },
	{ facet: "earn", re: /\b(puan|point|mil|mile|reward|cashback|kazan|earn)\b/i },
	{ facet: "access", re: /\b(lounge|fast\s*track|access|erisim|erişim)\b/i },
];

/** Facets implied by the user question (general, not domain-specific products). */
export function detectQuestionFacets(question: string): ResearchFacet[] {
	const q = normalizeLabel(question);
	const out: ResearchFacet[] = [];
	for (const { facet, re } of FACET_QUESTION) {
		if (re.test(q) && !out.includes(facet)) out.push(facet);
	}
	return out;
}

export function facetsCoveredByDimensions(dimensions: string[]): Set<ResearchFacet> {
	const covered = new Set<ResearchFacet>();
	for (const dim of dimensions) {
		const n = normalizeLabel(dim);
		for (const { facet, re } of FACET_DIM) {
			if (re.test(n)) covered.add(facet);
		}
	}
	return covered;
}

/** Question facets that have no matching required dimension — thin plans that fake 100% coverage. */
export function missingPlanFacets(question: string, requiredDimensions: string[]): ResearchFacet[] {
	const needed = detectQuestionFacets(question);
	if (needed.length === 0) return [];
	const covered = facetsCoveredByDimensions(requiredDimensions);
	return needed.filter((f) => !covered.has(f));
}
