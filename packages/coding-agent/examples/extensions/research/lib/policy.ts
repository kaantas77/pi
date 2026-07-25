import { rankBoostForQuery } from "./plan-scope.ts";

export type SourcePolicyName = "general" | "official" | "docs" | "news" | "academic";

export type SourceType = "primary" | "secondary" | "unknown";

export interface SourcePolicy {
	name: SourcePolicyName;
	description: string;
	preferPrimary: boolean;
	allowSecondaryForDiscoveryOnly: boolean;
	requireCitation: boolean;
	minSourcesPerClaim: number;
	domainBoost: string[];
	domainDeny: string[];
	secondaryHints: string[];
}

const POLICIES: Record<SourcePolicyName, SourcePolicy> = {
	general: {
		name: "general",
		description: "Balanced web research. Prefer primary/official sources; allow secondary for discovery.",
		preferPrimary: true,
		allowSecondaryForDiscoveryOnly: true,
		requireCitation: true,
		minSourcesPerClaim: 1,
		domainBoost: [],
		domainDeny: [],
		secondaryHints: [
			"wikipedia.org",
			"medium.com",
			"reddit.com",
			"quora.com",
			"blogspot.",
			"kartavantaj.com",
			"teklifimgelsin.com",
			"kredikartlari.net",
			"patronrehberi.com",
			"sikayetvar.com",
			"getkampania.com",
			"kampania.com",
			"enuygunfinans.com",
			"enuygun.com",
			"hangikredi.com",
			"hesapkurdu.com",
			"instagram.com",
			"facebook.com",
			"twitter.com",
			"x.com",
			"tiktok.com",
			"youtube.com",
		],
	},
	official: {
		name: "official",
		description: "Primary/official sources only for confirmed findings. Aggregators and blogs are discovery-only.",
		preferPrimary: true,
		allowSecondaryForDiscoveryOnly: true,
		requireCitation: true,
		minSourcesPerClaim: 1,
		domainBoost: [".gov", ".gov.tr", ".edu", "docs.", "developer.", "help.", "support."],
		domainDeny: [],
		secondaryHints: [
			"wikipedia.org",
			"medium.com",
			"reddit.com",
			"quora.com",
			"blogspot.",
			"tumblr.com",
			"pinterest.com",
			"kartavantaj.com",
			"teklifimgelsin.com",
			"kredikartlari.net",
			"patronrehberi.com",
			"sikayetvar.com",
			"getkampania.com",
			"kampania.com",
			"enuygunfinans.com",
			"enuygun.com",
			"hangikredi.com",
			"hesapkurdu.com",
			"instagram.com",
			"facebook.com",
			"twitter.com",
			"x.com",
			"tiktok.com",
			"youtube.com",
		],
	},
	docs: {
		name: "docs",
		description: "Prefer official documentation, changelogs, and API references.",
		preferPrimary: true,
		allowSecondaryForDiscoveryOnly: true,
		requireCitation: true,
		minSourcesPerClaim: 1,
		domainBoost: ["docs.", "developer.", "api.", "github.com", "readthedocs."],
		domainDeny: [],
		secondaryHints: ["medium.com", "dev.to", "stackoverflow.com", "reddit.com"],
	},
	news: {
		name: "news",
		description: "Prefer reputable news outlets; require recency awareness and citations.",
		preferPrimary: true,
		allowSecondaryForDiscoveryOnly: false,
		requireCitation: true,
		minSourcesPerClaim: 1,
		domainBoost: ["reuters.com", "apnews.com", "bbc.com", "nytimes.com", "ft.com"],
		domainDeny: [],
		secondaryHints: ["blogspot.", "medium.com", "substack.com"],
	},
	academic: {
		name: "academic",
		description: "Prefer papers, DOIs, and academic publishers.",
		preferPrimary: true,
		allowSecondaryForDiscoveryOnly: true,
		requireCitation: true,
		minSourcesPerClaim: 1,
		domainBoost: ["arxiv.org", "doi.org", "acm.org", "ieee.org", "nature.com", "science.org", ".edu"],
		domainDeny: [],
		secondaryHints: ["medium.com", "reddit.com", "wikipedia.org"],
	},
};

export function getSourcePolicy(name: SourcePolicyName | undefined): SourcePolicy {
	return POLICIES[name ?? "general"] ?? POLICIES.general;
}

export function listSourcePolicies(): SourcePolicy[] {
	return Object.values(POLICIES);
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** Comparison blogs, listicles, UGC — never primary for schedule/fee claims. */
export function looksLikeAggregatorOrUgcUrl(url: string): boolean {
	const host = hostnameOf(url);
	const path = (() => {
		try {
			return new URL(url).pathname.toLowerCase();
		} catch {
			return url.toLowerCase();
		}
	})();
	const hay = `${host}${path}`;
	if (!host) return false;
	if (/blog|medium|substack|wordpress|blogspot|tumblr|quora|reddit/.test(host)) return true;
	if (
		/(compare|karsilastir|karşılaştır|tum-|tüm-|all-|best-|en-iyi|enucuz|en-ucuz|ranking|vs-|versus|listicle|cheat-?sheet)/i.test(
			hay,
		)
	) {
		return true;
	}
	return false;
}

/** Institutional fee/support/legal document paths (language-agnostic path cues). */
export function looksLikeOfficialDocumentUrl(url: string): boolean {
	if (looksLikeAggregatorOrUgcUrl(url)) return false;
	const u = url.toLowerCase();
	if (/\.pdf(\?|$)/.test(u)) return true;
	return /\/(destek|support|help|faq|fees?|pricing|price-list|faiz|ucret|ücret|legal|terms|conditions|sozlesme|sözleşme|uyelik|üyelik|membership|rate-?schedule|tarif)\b/.test(
		u,
	);
}

export function classifySourceType(url: string, policy: SourcePolicy): SourceType {
	const host = hostnameOf(url);
	if (!host) return "unknown";

	if (policy.domainDeny.some((d) => host.includes(d.toLowerCase()))) {
		return "secondary";
	}

	if (policy.secondaryHints.some((d) => host.includes(d.toLowerCase()))) {
		return "secondary";
	}

	if (looksLikeAggregatorOrUgcUrl(url)) {
		return "secondary";
	}

	if (policy.domainBoost.some((d) => host.includes(d.toLowerCase()) || host.endsWith(d.toLowerCase()))) {
		return "primary";
	}

	// Heuristic: official product/company pages and docs-ish hosts
	if (
		host.startsWith("docs.") ||
		host.startsWith("developer.") ||
		host.startsWith("api.") ||
		host.includes(".gov") ||
		host.endsWith(".edu")
	) {
		return "primary";
	}

	// Fee/support/legal document paths on otherwise unknown corporate hosts → primary
	if (looksLikeOfficialDocumentUrl(url)) {
		return "primary";
	}

	return "unknown";
}

/** Relative trust for ledger winner selection (conflicts still win over auto-pick). */
export function sourceTypeConfidence(type: SourceType): number {
	if (type === "primary") return 1;
	if (type === "unknown") return 0.55;
	if (type === "secondary") return 0.35;
	return 0.4;
}

export function rankSearchResults<T extends { url: string; title?: string; score?: number }>(
	results: T[],
	policy: SourcePolicy,
	query?: string,
): Array<T & { sourceType: SourceType; rankScore: number }> {
	return results
		.map((r) => {
			const sourceType = classifySourceType(r.url, policy);
			let boost = 0;
			if (sourceType === "primary") boost += 2;
			if (sourceType === "secondary") boost -= 1;
			boost += rankBoostForQuery(r.url, query);
			const hay = `${r.url} ${r.title ?? ""}`.toLowerCase();
			// Path intent / freshness cues (keep in sync with evidence-score path heuristics)
			if (/fee|fees|pricing|ucret|ücret|faiz|tarif|uyelik-?bedeli|aidat|annual/i.test(hay)) boost += 1.25;
			if (/sozlesme|sözleşme|contract|terms|membership-agreement|uyelik-sozlesmesi/i.test(hay)) boost -= 1;
			if (/\/20\d{2}\/|_20\d{2}_/.test(hay)) {
				const y = hay.match(/20\d{2}/)?.[0];
				const asOfY = new Date().getUTCFullYear();
				if (y && asOfY - Number(y) >= 2) boost -= 0.75;
				else if (y && asOfY - Number(y) <= 0) boost += 0.5;
			}
			const base = typeof r.score === "number" ? r.score : 0;
			return { ...r, sourceType, rankScore: base + boost };
		})
		.sort((a, b) => b.rankScore - a.rankScore);
}
