import { describe, expect, it } from "vitest";
import type { FindingRecord, ResearchPlan } from "./artifacts.ts";
import { buildCellLedger, inferValidToFromValue, valuesConflict } from "./cells.ts";
import { buildPublishBrief } from "./publish-brief.ts";
import { verifyResearch } from "./verify.ts";

function plan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
	return {
		id: "run1",
		question: "Compare cards",
		policy: "general",
		entities: ["Wings Elite", "Crystal Metal"],
		dimensions: ["lounge", "aktif kampanyalar"],
		requiredDimensions: ["lounge", "aktif kampanyalar"],
		optionalDimensions: [],
		queries: [],
		outputFormat: "brief",
		gapPass: { status: "done", queries: [] },
		asOfDate: "2026-07-25",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		dir: "/tmp/run1",
		...overrides,
	};
}

function finding(overrides: Partial<FindingRecord>): FindingRecord {
	return {
		id: "f1",
		entity: "Wings Elite",
		field: "lounge",
		value: "8 per year",
		evidence: "8 times",
		sourceUrl: "https://docs.example.com/a",
		confidence: "high",
		status: "observed",
		recordedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("cell ledger", () => {
	it("marks conflicting values for the same cell as not publishable", () => {
		expect(valuesConflict("8 per year", "unlimited")).toBe(true);
		const ledger = buildCellLedger({
			plan: plan({ dimensions: ["lounge"], requiredDimensions: ["lounge"], entities: ["Wings Elite"] }),
			findings: [finding({ value: "8 per year" }), finding({ id: "f2", value: "unlimited / sınırsız" })],
			asOf: "2026-07-25",
		});
		const cell = ledger.cells[0];
		expect(cell.status).toBe("conflict");
		expect(cell.publishable).toBe(false);
	});

	it("excludes expired campaigns from publishable cells", () => {
		const ledger = buildCellLedger({
			plan: plan({
				entities: ["Crystal Metal"],
				dimensions: ["aktif kampanyalar"],
				requiredDimensions: ["aktif kampanyalar"],
			}),
			findings: [
				finding({
					entity: "Crystal Metal",
					field: "aktif kampanyalar",
					value: "3000 TL yurt dışı indirim 20 Haziran - 19 Temmuz 2026",
					validTo: "2026-07-19",
				}),
			],
			asOf: "2026-07-25",
		});
		expect(ledger.expired).toHaveLength(1);
		expect(ledger.publishable).toHaveLength(0);
		expect(inferValidToFromValue("20 Haziran - 19 Temmuz 2026")).toBe("2026-07-19");
	});

	it("builds summary and details from the same publishable values", () => {
		const p = plan({
			entities: ["Wings Elite"],
			dimensions: ["lounge"],
			requiredDimensions: ["lounge"],
		});
		const findings = [finding({ value: "8 per year (+1 guest)" })];
		const ledger = buildCellLedger({ plan: p, findings, asOf: "2026-07-25" });
		const report = verifyResearch({
			plan: p,
			sources: [
				{
					id: "s1",
					url: "https://docs.example.com/a",
					type: "primary",
					fetchedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			findings,
			openQuestions: [],
			discovered: [
				{
					url: "https://docs.example.com/a",
					sourceType: "primary",
					rankScore: 1,
					mustFetch: true,
					status: "fetched",
					discoveredAt: "2026-01-01T00:00:00.000Z",
					fetchedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		const brief = buildPublishBrief({ plan: p, ledger, report });
		expect(brief).toContain("8 per year (+1 guest)");
		expect(brief).not.toContain("sınırsız");
		expect(brief).not.toContain("VERIFY FAIL");
		expect(brief).not.toContain("Unfetched must-fetch");
		expect(brief).toContain("Wings Elite");
		expect(brief).toContain("## 1.");
		expect((brief.match(/8 per year \(\+1 guest\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
	});

	it("does not publish campaign cells without a resolvable end date as active", () => {
		const ledger = buildCellLedger({
			plan: plan({
				entities: ["Crystal Metal"],
				dimensions: ["aktif kampanyalar"],
				requiredDimensions: ["aktif kampanyalar"],
			}),
			findings: [
				finding({
					entity: "Crystal Metal",
					field: "aktif kampanyalar",
					value: "Yurt dışı harcama indirimi",
				}),
			],
			asOf: "2026-07-25",
		});
		expect(ledger.publishable).toHaveLength(0);
		expect(ledger.cells[0]?.freshness).toBe("unknown");
	});

	it("marks partial packages clearly incomplete in the published brief", () => {
		const p = plan({
			entities: ["Wings Elite", "Crystal Metal"],
			dimensions: ["lounge"],
			requiredDimensions: ["lounge"],
		});
		const findings = [finding({ value: "8 per year (+1 guest)" })];
		const ledger = buildCellLedger({ plan: p, findings, asOf: "2026-07-25" });
		const report = verifyResearch({
			plan: p,
			sources: [
				{
					id: "s1",
					url: "https://docs.example.com/a",
					type: "primary",
					fetchedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			findings,
			openQuestions: [],
			discovered: [
				{
					url: "https://docs.example.com/a",
					sourceType: "primary",
					rankScore: 1,
					mustFetch: true,
					status: "fetched",
					discoveredAt: "2026-01-01T00:00:00.000Z",
					fetchedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		expect(report.ok).toBe(false);
		const brief = buildPublishBrief({ plan: p, ledger, report });
		expect(brief).toContain("Incomplete research package");
		expect(brief).toContain("8 per year (+1 guest)");
		expect(brief).not.toContain("Unfetched must-fetch");
	});

	it("does not treat as-of fee dates as expired end dates", () => {
		expect(inferValidToFromValue("4.800 TL (Asıl Kart) - 1 Ocak 2026 itibarıyla")).toBeUndefined();
		expect(inferValidToFromValue("20 Haziran - 19 Temmuz 2026")).toBe("2026-07-19");
		expect(inferValidToFromValue("Hoşgeldin: 750.000 MilPuan. Son: 30 Haziran 2026.")).toBe("2026-06-30");
		expect(inferValidToFromValue("Offer valid until 2026-06-30")).toBe("2026-06-30");
		const feeLedger = buildCellLedger({
			plan: plan({
				entities: ["Product Fee"],
				dimensions: ["yıllık ücret"],
				requiredDimensions: ["yıllık ücret"],
			}),
			findings: [
				finding({
					entity: "Product Fee",
					field: "yıllık ücret",
					value: "30.700 TL (Asıl Kart) - 1 Ocak 2026 itibarıyla",
				}),
			],
			asOf: "2026-07-25",
		});
		expect(feeLedger.publishable).toHaveLength(1);
		expect(feeLedger.expired).toHaveLength(0);

		const offerLedger = buildCellLedger({
			plan: plan({
				entities: ["Product A"],
				dimensions: ["current_campaigns"],
				requiredDimensions: ["current_campaigns"],
			}),
			findings: [
				finding({
					entity: "Product A",
					field: "current_campaigns",
					value: "Welcome bonus 75.000 spend → 750.000 points. Son: 30 Haziran 2026.",
				}),
			],
			asOf: "2026-07-25",
		});
		expect(offerLedger.expired).toHaveLength(1);
		expect(offerLedger.publishable).toHaveLength(0);
	});

	it("treats different TL amounts as fee conflicts", () => {
		expect(valuesConflict("1.112 TL (2026)", "850 TL (Amex, 2025)")).toBe(true);
		expect(valuesConflict("1.112 TL (2026)", "1112 TL yıllık ücret 2026")).toBe(false);
	});

	it("picks a current fee page over a stale membership-contract PDF when values agree", () => {
		const contractUrl =
			"https://issuer.example/content/dam/pdf/sozlesmeler/tr/2025/kredi-karti-uyelik-sozlesmesi.pdf";
		const feeUrl = "https://issuer.example/destek/faiz-ve-ucretler/yillik-uyelik-bedeli";
		const ledger = buildCellLedger({
			plan: plan({
				entities: ["Amex Gold"],
				dimensions: ["yıllık ücret"],
				requiredDimensions: ["yıllık ücret"],
			}),
			findings: [
				finding({
					id: "f-contract",
					entity: "Amex Gold",
					field: "yıllık ücret",
					value: "Asıl Kart 6.795 TL",
					sourceUrl: contractUrl,
					evidence: "üyelik sözleşmesi 2025",
				}),
				finding({
					id: "f-fee",
					entity: "Amex Gold",
					field: "yıllık ücret",
					value: "Asıl Kart 6.795 TL — 13 Şubat 2026 itibarıyla",
					sourceUrl: feeUrl,
					evidence: "yıllık üyelik bedeli 2026",
				}),
			],
			asOf: "2026-07-25",
			sources: [
				{ id: "s1", url: contractUrl, type: "primary", title: "Üyelik Sözleşmesi 2025" },
				{ id: "s2", url: feeUrl, type: "primary", title: "Yıllık üyelik bedeli 2026" },
			],
		});
		expect(ledger.conflicts).toHaveLength(0);
		expect(ledger.publishable).toHaveLength(1);
		expect(ledger.cells[0]?.sourceUrl).toBe(feeUrl);
		expect(ledger.cells[0]?.value).toContain("6.795");
	});

	it("does not publish a low-scoring stale contract alone as a fee cell when below threshold", () => {
		const contractUrl = "https://issuer.example/content/dam/pdf/sozlesmeler/tr/2024/uyelik-sozlesmesi.pdf";
		const ledger = buildCellLedger({
			plan: plan({
				entities: ["Product X"],
				dimensions: ["yıllık ücret"],
				requiredDimensions: ["yıllık ücret"],
			}),
			findings: [
				finding({
					entity: "Product X",
					field: "yıllık ücret",
					value: "1.000 TL",
					sourceUrl: contractUrl,
					evidence: "sözleşme",
				}),
			],
			asOf: "2026-07-25",
			sources: [{ id: "s1", url: contractUrl, type: "primary", title: "Üyelik Sözleşmesi 2024" }],
		});
		expect(ledger.publishable).toHaveLength(0);
		expect(ledger.cells[0]?.status).toBe("inferred");
		expect(ledger.cells[0]?.evidenceScore?.pathIntent ?? 0).toBeLessThan(0);
	});
});
