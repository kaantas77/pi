import { normalizeLabel } from "./normalize.ts";

/** Turn slug-like entity/field ids into readable labels for user-facing briefs. */
export function humanizeLabel(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return raw;

	// snake_case / kebab-case → Title Case words
	if (/^[a-z0-9]+(?:[_-][a-z0-9]+)+$/i.test(trimmed)) {
		return trimmed
			.split(/[_-]/)
			.filter(Boolean)
			.map((part) => titleToken(part))
			.join(" ");
	}

	// Already has spaces — keep as authored (may be a proper name)
	if (/[ ]/.test(trimmed)) return trimmed;

	return trimmed;
}

function titleToken(part: string): string {
	const lower = part.toLowerCase();
	const acronyms = new Set(["api", "url", "id", "sku", "pdf", "usd", "eur", "gbp", "tl", "try", "vip"]);
	if (acronyms.has(lower)) return lower.toUpperCase();
	return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function displayFieldLabel(field: string): string {
	const human = humanizeLabel(field);
	const n = normalizeLabel(field);
	if (/^(yillik|yıllık)\s*(ucret|ücret)$/i.test(n) || n === "annual fee" || n === "yearly fee") {
		return "Yıllık ücret";
	}
	return human;
}
