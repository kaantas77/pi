/**
 * Label normalization for research coverage matching.
 * Avoids false missing_entity / missing_dimension when names differ only by
 * punctuation, parentheticals, spacing, or minor token extras.
 */

export function normalizeLabel(input: string): string {
	return input
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "") // strip diacritics
		.replace(/&/g, " and ")
		.replace(/[_/|]+/g, " ")
		.replace(/\([^)]*\)/g, " ") // drop parentheticals: Metal (The Platinum) → Metal
		.replace(/[^a-z0-9ğüşıöçâîû\s]+/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function labelTokens(input: string): string[] {
	const n = normalizeLabel(input);
	if (!n) return [];
	return n.split(" ").filter((t) => t.length > 0);
}

/**
 * True when `recorded` should count as covering `planned` (entity coverage).
 * Same specificity only: "Akbank Wings" must NOT cover or be covered by "Akbank Wings Elite".
 * Parenthetical elaborations still match after normalize: Metal (The Platinum) ≡ Metal.
 */
export function labelsMatch(planned: string, recorded: string, aliases: string[] = []): boolean {
	const candidates = [planned, ...aliases];
	for (const candidate of candidates) {
		if (labelsEqualPair(candidate, recorded)) return true;
	}
	return false;
}

/** @deprecated alias — same as labelsMatch. */
export function labelsCover(planned: string, recorded: string, aliases: string[] = []): boolean {
	return labelsMatch(planned, recorded, aliases);
}

function labelsEqualPair(planned: string, recorded: string): boolean {
	const na = normalizeLabel(planned);
	const nb = normalizeLabel(recorded);
	if (!na || !nb) return false;
	if (na === nb) return true;

	const ta = new Set(labelTokens(planned));
	const tb = new Set(labelTokens(recorded));
	if (ta.size === 0 || tb.size === 0) return false;

	// Typo tolerance only when token counts match (Pirivia ↔ Privia; never Wings ⊂ Wings Elite)
	if (ta.size === tb.size && tokensNearlyEqual(ta, tb)) return true;

	const inter = [...ta].filter((t) => tb.has(t)).length;
	const union = new Set([...ta, ...tb]).size;
	if (union > 0 && inter / union >= 0.9 && inter >= 3 && ta.size === tb.size) return true;

	return false;
}

/** Looser match for dimension/field labels only (punctuation / short elaborations). */
export function fieldsMatch(planned: string, recorded: string): boolean {
	const na = normalizeLabel(planned);
	const nb = normalizeLabel(recorded);
	if (!na || !nb) return false;
	if (na === nb) return true;
	if (na.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
	const ta = new Set(labelTokens(planned));
	const tb = new Set(labelTokens(recorded));
	if (ta.size === 0 || tb.size === 0) return false;
	if ([...ta].every((t) => tb.has(t)) || [...tb].every((t) => ta.has(t))) return true;
	return tokensNearlyEqual(ta, tb);
}

function tokensNearlyEqual(ta: Set<string>, tb: Set<string>): boolean {
	const a = [...ta];
	const b = [...tb];
	if (a.length === 0 || b.length === 0) return false;
	if (Math.abs(a.length - b.length) > 1) return false;

	// Single-token labels: only allow typo tolerance on reasonably long tokens
	if (a.length === 1 && b.length === 1) {
		const maxLen = Math.max(a[0].length, b[0].length);
		return maxLen >= 5 && levenshtein(a[0], b[0]) <= 2;
	}

	// Multi-token: require exact matches for all but at most one fuzzy long token
	const used = new Set<number>();
	let fuzzy = 0;
	for (const tokenA of a) {
		const exact = b.findIndex((t, i) => !used.has(i) && t === tokenA);
		if (exact >= 0) {
			used.add(exact);
			continue;
		}
		let best = -1;
		let bestDist = Infinity;
		for (let i = 0; i < b.length; i++) {
			if (used.has(i)) continue;
			const d = levenshtein(tokenA, b[i]);
			if (d < bestDist) {
				bestDist = d;
				best = i;
			}
		}
		if (best < 0) return false;
		const maxLen = Math.max(tokenA.length, b[best].length);
		if (maxLen >= 5 && bestDist <= 2 && fuzzy < 1) {
			fuzzy++;
			used.add(best);
			continue;
		}
		return false;
	}
	return used.size === a.length;
}

function levenshtein(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	const row = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let prev = i - 1;
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cur = row[j];
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
			prev = cur;
		}
	}
	return row[b.length];
}

export function findCoveringLabel(
	planned: string,
	recordedLabels: Iterable<string>,
	aliases: string[] = [],
): string | undefined {
	for (const recorded of recordedLabels) {
		if (labelsMatch(planned, recorded, aliases)) return recorded;
	}
	return undefined;
}
