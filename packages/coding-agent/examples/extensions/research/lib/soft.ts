/**
 * Language-agnostic soft/placeholder detection for research findings.
 * Soft values must not be recorded as status=observed.
 */

const SOFT_VALUE_PATTERNS: RegExp[] = [
	/\bnot\s+specified\b/i,
	/\bnot\s+found\b/i,
	/\bunknown\b/i,
	/\bn\/?a\b/i,
	/\bsee\s+(the\s+)?(page|site|link|document)\b/i,
	/\bavailable\s+on\b/i,
	/\blisted\s+on\b/i,
	/\bnet\s+de[gğ]il\b/i,
	/\bbelirtilmemi[sş]\b/i,
	/\bbulunamad[ıi]\b/i,
	/\bsayfas[ıi]nda\s+yer\s+al[ıi]r\b/i,
	/\b[uü]r[uü]n\s+ve\s+hizmet\s+[uü]cret/i,
	/\bdetay(lar[ıi])?\s+(icin|için)\s+.+\s+bak/i,
	/\bjs\s+korumal/i,
	/\bcould\s+not\s+be\s+(determined|verified|found)\b/i,
	/\bunable\s+to\s+(determine|verify|find)\b/i,
	/\bfee\s+page\b/i,
	/\bpricing\s+page\b/i,
	/^~\s*[\d.,]+\s*(tl|try|usd|eur)?\.?$/i,
	/^(premium|standart|standard|varl[ıi]k\s+bazl[ıi]|program\s+bazl[ıi])\.?$/i,
	/^premium\s*\([^)]*\)\.?$/i,
];

export function isSoftPlaceholderValue(value: string): boolean {
	const v = value.trim();
	if (!v) return true;
	return SOFT_VALUE_PATTERNS.some((re) => re.test(v));
}

export function softPlaceholderReason(value: string): string | undefined {
	if (!isSoftPlaceholderValue(value)) return undefined;
	return `Value looks like a soft placeholder (not a concrete observed fact): "${value.trim().slice(0, 160)}"`;
}
