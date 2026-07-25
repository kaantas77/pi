import { normalizeLabel } from "./normalize.ts";

/**
 * Detects "bag" entities that are catalogs/categories rather than atomic comparison units.
 * Domain-agnostic: plural catalog endings, "all X", "X products/cards/plans" style labels.
 */
export function looksLikeAggregateEntity(name: string): boolean {
	const n = normalizeLabel(name);
	if (!n) return false;

	// Explicit catalog / plural product-class endings (EN + common TR morphology)
	if (
		/\b(cards|kartlar[iı]?|products|urunler[iı]?|ürünler[iı]?|plans|planlar[iı]?|services|hizmetler[iı]?|offerings|packages|paketler[iı]?|catalog|katalog|portfolio|portfoy|portföy)\b/i.test(
			n,
		)
	) {
		return true;
	}

	// "Company credit cards" / "vendor products" style: org + product-class plural/collective
	if (/\b(kredi\s+kart|credit\s+cards?)\b/i.test(n)) {
		const tokens = n.split(" ").filter(Boolean);
		if (tokens.length >= 2) return true;
	}

	return false;
}

export function findAggregateEntities(entities: string[]): string[] {
	return entities.filter(looksLikeAggregateEntity);
}

/**
 * One ledger cell jammed with many distinct fee/list prices → plan should split entities.
 * Ignores unit rates like "1 TL'ye 1 mil" and tiny amounts that are not catalog prices.
 */
export function isOverstuffedValue(value: string): boolean {
	const amounts = extractCatalogMoneyAmounts(value);
	if (amounts.length >= 4) return true;

	const segments = value
		.split(/[;\n]|(?<=\.)\s+(?=[A-ZÇĞİÖŞÜÁÉÍÓÚ])/u)
		.map((s) => s.trim())
		.filter((s) => s.length > 24);
	if (segments.length >= 5 && amounts.length >= 3) return true;

	return false;
}

/** Money amounts that look like list/catalog prices (not "1 TL = 1 point" unit rates). */
export function extractCatalogMoneyAmounts(value: string): number[] {
	const out: number[] = [];
	// Skip unit-rate patterns: "1 TL'ye", "1TL=", "100TL'de", "per 100 TL"
	const unitRate = /\b\d{1,3}(?:[.,]\d+)?\s*(?:tl|try|usd|eur)\s*['’]?(?:ye|ya|de|da|e|=|\/)/gi;
	const cleaned = value.replace(unitRate, " ");

	const re = /(\d{1,3}(?:[.\s]\d{3})+|\d+)(?:[.,]\d+)?\s*(?:tl|try|usd|eur|£|\$|€)/gi;
	for (const m of cleaned.matchAll(re)) {
		const n = Number(m[1].replace(/[.\s]/g, "").replace(",", "."));
		if (!Number.isFinite(n)) continue;
		// Tiny amounts are almost always rates/thresholds, not jammed product fees
		if (n < 100) continue;
		out.push(n);
	}
	return out;
}
