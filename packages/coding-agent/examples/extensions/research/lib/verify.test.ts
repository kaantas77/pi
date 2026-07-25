import { describe, expect, it } from "vitest";
import type { FindingRecord, ResearchPlan, SourceRecord } from "./artifacts.ts";
import type { DiscoveredUrl } from "./discovered.ts";
import { labelsMatch } from "./normalize.ts";
import { isSoftPlaceholderValue } from "./soft.ts";
import { auditResearch, ensurePartialBriefBanner, verifyResearch } from "./verify.ts";

function plan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
	return {
		id: "run1",
		question: "test",
		policy: "official",
		entities: ["Alpha", "Beta"],
		dimensions: ["price", "date"],
		requiredDimensions: ["price", "date"],
		optionalDimensions: [],
		queries: [],
		outputFormat: "brief",
		gapPass: { status: "not_started", queries: [] },
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		dir: "/tmp/run1",
		...overrides,
	};
}

function finding(overrides: Partial<FindingRecord>): FindingRecord {
	return {
		id: "f1",
		entity: "Alpha",
		field: "price",
		value: "10",
		evidence: "price is 10",
		sourceUrl: "https://docs.example.com/a",
		confidence: "high",
		status: "observed",
		recordedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function fetchedPrimary(url: string): SourceRecord {
	return { id: url, url, type: "primary", fetchedAt: "2026-01-01T00:00:00.000Z" };
}

function fetchedDisc(url: string): DiscoveredUrl {
	return {
		url,
		sourceType: "primary",
		rankScore: 1,
		mustFetch: true,
		status: "fetched",
		discoveredAt: "2026-01-01T00:00:00.000Z",
		fetchedAt: "2026-01-01T00:00:00.000Z",
	};
}

describe("labelsMatch", () => {
	it("matches parenthetical elaborations and light typos", () => {
		expect(labelsMatch("Garanti Amex Metal", "Garanti Amex Metal (The Platinum)")).toBe(true);
		expect(labelsMatch("İş Bankası Pirivia Black", "İş Bankası Privia Black")).toBe(true);
		expect(labelsMatch("yıllık ücret", "yıllık_ücret")).toBe(true);
		expect(labelsMatch("Alpha", "Completely Different")).toBe(false);
	});

	it("does not collapse sibling product tiers (Elite ≠ Wings)", () => {
		expect(labelsMatch("Akbank Wings Elite", "Akbank Wings")).toBe(false);
		expect(labelsMatch("Akbank Wings", "Akbank Wings Elite")).toBe(false);
	});
});

describe("isSoftPlaceholderValue", () => {
	it("detects soft placeholders across languages", () => {
		expect(isSoftPlaceholderValue("Ürün ve Hizmet Ücretleri sayfasında yer alır")).toBe(true);
		expect(isSoftPlaceholderValue("not specified on the official page")).toBe(true);
		expect(isSoftPlaceholderValue("see the fee page")).toBe(true);
		expect(isSoftPlaceholderValue("19.600 TL")).toBe(false);
	});
});

describe("verifyResearch", () => {
	it("fails when coverage and citations are missing", () => {
		const report = verifyResearch({
			plan: plan(),
			sources: [],
			findings: [],
			openQuestions: ["still missing Beta"],
		});
		expect(report.ok).toBe(false);
		expect(report.issues.some((i) => i.code === "no_findings")).toBe(true);
		expect(report.issues.some((i) => i.code === "missing_entity_coverage")).toBe(true);
		expect(report.issues.some((i) => i.code === "open_questions_remain")).toBe(true);
	});

	it("requires entity × dimension cell matrix coverage", () => {
		const sources = [fetchedPrimary("https://docs.example.com/a"), fetchedPrimary("https://docs.example.com/b")];
		// Alpha has both fields; Beta only price — date cell missing
		const findings = [
			finding({ entity: "Alpha", field: "price" }),
			finding({ id: "f2", entity: "Alpha", field: "date", value: "2026-01-01" }),
			finding({ id: "f3", entity: "Beta", field: "price", value: "20", sourceUrl: "https://docs.example.com/b" }),
		];
		const report = verifyResearch({
			plan: plan(),
			sources,
			findings,
			openQuestions: [],
			discovered: [fetchedDisc("https://docs.example.com/a"), fetchedDisc("https://docs.example.com/b")],
		});
		expect(report.ok).toBe(false);
		expect(report.coverage.cellsMissing).toEqual([{ entity: "Beta", field: "date" }]);
		expect(report.issues.some((i) => i.code === "missing_cell_coverage")).toBe(true);
		expect(report.stats.cellsCovered).toBe(3);
		expect(report.stats.cells).toBe(4);
	});

	it("covers planned entities via normalized recorded names", () => {
		const sources = [fetchedPrimary("https://docs.example.com/a"), fetchedPrimary("https://docs.example.com/b")];
		const findings = [
			finding({ entity: "Alpha Card (Premium)", field: "price" }),
			finding({ id: "f2", entity: "Alpha Card (Premium)", field: "date", value: "2026-01-01" }),
			finding({ id: "f3", entity: "Beta", field: "price", value: "20", sourceUrl: "https://docs.example.com/b" }),
			finding({
				id: "f4",
				entity: "Beta",
				field: "date",
				value: "2026-02-01",
				sourceUrl: "https://docs.example.com/b",
			}),
		];
		const report = verifyResearch({
			plan: plan({ entities: ["Alpha Card", "Beta"] }),
			sources,
			findings,
			openQuestions: [],
			discovered: [fetchedDisc("https://docs.example.com/a"), fetchedDisc("https://docs.example.com/b")],
		});
		expect(report.coverage.entitiesMissing).toEqual([]);
		expect(report.issues.some((i) => i.code === "missing_entity_coverage")).toBe(false);
	});

	it("records secondary sources as quality notes without alone failing verify", () => {
		const sources: SourceRecord[] = [
			{
				id: "s1",
				url: "https://medium.com/post",
				type: "secondary",
				fetchedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const findings = [
			finding({
				id: "f1",
				entity: "Alpha",
				field: "price",
				sourceUrl: "https://medium.com/post",
			}),
			finding({
				id: "f2",
				entity: "Alpha",
				field: "date",
				sourceUrl: "https://medium.com/post",
			}),
			finding({
				id: "f3",
				entity: "Beta",
				field: "price",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
			finding({
				id: "f4",
				entity: "Beta",
				field: "date",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
		];

		const report = verifyResearch({
			plan: plan(),
			sources,
			findings,
			openQuestions: [],
			discovered: [
				{
					url: "https://medium.com/post",
					sourceType: "secondary",
					rankScore: 1,
					mustFetch: false,
					status: "fetched",
					discoveredAt: "2026-01-01T00:00:00.000Z",
					fetchedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		expect(report.ok).toBe(true);
		expect(report.issues.some((i) => i.code === "secondary_as_confirmed" && i.severity === "quality")).toBe(true);
		expect(report.qualityNotes.some((i) => i.code === "secondary_as_confirmed")).toBe(true);
	});

	it("fails soft observed placeholders", () => {
		const sources: SourceRecord[] = [fetchedPrimary("https://docs.example.com/a")];
		const findings = [
			finding({
				value: "Fee is listed on the product and services fees page",
				evidence: "see fees page",
			}),
			finding({ id: "f2", entity: "Alpha", field: "date", value: "2026-01-01" }),
			finding({
				id: "f3",
				entity: "Beta",
				field: "price",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
			finding({
				id: "f4",
				entity: "Beta",
				field: "date",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
		];
		const report = verifyResearch({
			plan: plan(),
			sources,
			findings,
			openQuestions: [],
			discovered: [fetchedDisc("https://docs.example.com/a")],
		});
		expect(report.ok).toBe(false);
		expect(report.issues.some((i) => i.code === "soft_observed")).toBe(true);
	});

	it("fails when must-fetch discovered URLs remain unread", () => {
		const sources: SourceRecord[] = [fetchedPrimary("https://docs.example.com/a")];
		const discovered: DiscoveredUrl[] = [
			fetchedDisc("https://docs.example.com/a"),
			{
				url: "https://example.com/fees",
				title: "Official fee schedule",
				sourceType: "primary",
				rankScore: 1.5,
				mustFetch: true,
				status: "discovered",
				discoveredAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const findings = [
			finding({}),
			finding({ id: "f2", field: "date", value: "2026-01-01" }),
			finding({
				id: "f3",
				entity: "Beta",
				field: "price",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
			finding({
				id: "f4",
				entity: "Beta",
				field: "date",
				status: "not_found",
				sourceUrl: "",
				evidence: "",
				value: "not found",
			}),
		];
		const report = verifyResearch({
			plan: plan(),
			sources,
			findings,
			openQuestions: [],
			discovered,
		});
		expect(report.ok).toBe(false);
		expect(report.issues.some((i) => i.code === "unfetched_discovered")).toBe(true);
		expect(report.stats.unfetchedMustFetch).toBe(1);
	});

	it("passes when entities/dimensions are covered with fetched primary citations", () => {
		const sources: SourceRecord[] = [
			fetchedPrimary("https://docs.example.com/a"),
			fetchedPrimary("https://docs.example.com/b"),
		];
		const findings = [
			finding({
				id: "f1",
				entity: "Alpha",
				field: "price",
				sourceUrl: "https://docs.example.com/a",
			}),
			finding({
				id: "f2",
				entity: "Alpha",
				field: "date",
				sourceUrl: "https://docs.example.com/a",
				value: "2026-01-01",
			}),
			finding({
				id: "f3",
				entity: "Beta",
				field: "price",
				sourceUrl: "https://docs.example.com/b",
				value: "20",
			}),
			finding({
				id: "f4",
				entity: "Beta",
				field: "date",
				sourceUrl: "https://docs.example.com/b",
				value: "2026-02-01",
			}),
		];

		const report = verifyResearch({
			plan: plan(),
			sources,
			findings,
			openQuestions: [],
			discovered: [fetchedDisc("https://docs.example.com/a"), fetchedDisc("https://docs.example.com/b")],
		});
		expect(report.ok).toBe(true);
		expect(report.issues).toEqual([]);
	});

	it("audit classifies fetch_skip when soft observed + unread must-fetch", () => {
		const audit = auditResearch({
			plan: plan(),
			sources: [],
			findings: [
				finding({
					value: "see the page for details",
					evidence: "n/a",
				}),
			],
			discovered: [
				{
					url: "https://example.com/fees",
					sourceType: "primary",
					rankScore: 1,
					mustFetch: true,
					status: "discovered",
					discoveredAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		expect(audit.failureMode).toBe("fetch_skip");
		expect(audit.softObservedCount).toBe(1);
		expect(audit.unfetchedMustFetchCount).toBe(1);
	});

	it("injects a short user-facing gap note into partial briefs", () => {
		const report = verifyResearch({
			plan: plan(),
			sources: [],
			findings: [],
			openQuestions: [],
		});
		const brief = ensurePartialBriefBanner("# Nice looking report\n\nAll good.", report);
		expect(brief.startsWith("> **Incomplete research package:")).toBe(true);
		expect(brief).not.toContain("Unfetched must-fetch");
		expect(brief).toContain("Nice looking report");
	});
});

describe("soft placeholders extras", () => {
	it("treats approximate-only and vague premium labels as soft", () => {
		expect(isSoftPlaceholderValue("~3.760 TL")).toBe(true);
		expect(isSoftPlaceholderValue("Premium (M&S programı)")).toBe(true);
		expect(isSoftPlaceholderValue("Varlık bazlı")).toBe(true);
		expect(isSoftPlaceholderValue("3.760 TL")).toBe(false);
	});
});
