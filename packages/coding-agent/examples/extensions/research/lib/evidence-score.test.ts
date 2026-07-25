import { describe, expect, it } from "vitest";
import { scoreEvidence } from "./evidence-score.ts";

describe("evidence-score", () => {
	it("prefers current fee/schedule pages over stale membership contracts", () => {
		const asOf = "2026-07-25";
		const field = "yıllık ücret";
		const entity = "Amex Gold";

		const contract = scoreEvidence({
			url: "https://issuer.example/content/dam/pdf/sozlesmeler/tr/2025/kredi-karti-uyelik-sozlesmesi.pdf",
			field,
			entity,
			value: "Asıl Kart 5.195 TL",
			sourceType: "primary",
			asOf,
			titleOrSnippet: "Üyelik Sözleşmesi 2025",
		});
		const feePage = scoreEvidence({
			url: "https://issuer.example/destek/faiz-ve-ucretler/yillik-uyelik-bedeli",
			field,
			entity,
			value: "Asıl Kart 6.795 TL — 13 Şubat 2026",
			sourceType: "primary",
			asOf,
			titleOrSnippet: "Yıllık üyelik bedeli 2026",
		});

		expect(feePage.total).toBeGreaterThan(contract.total);
		expect(feePage.pathIntent).toBeGreaterThan(contract.pathIntent);
		expect(contract.pathIntent).toBeLessThan(0);
		expect(feePage.pathIntent).toBeGreaterThan(0);
	});

	it("penalizes secondary aggregators relative to unknown official-looking fee paths", () => {
		const asOf = "2026-07-25";
		const field = "annual fee";
		const secondary = scoreEvidence({
			url: "https://compare.example/best-fees",
			field,
			entity: "Product A",
			value: "1.000 TL",
			sourceType: "secondary",
			asOf,
		});
		const unknownFee = scoreEvidence({
			url: "https://brand.example/pricing/annual-fee",
			field,
			entity: "Product A",
			value: "1.000 TL",
			sourceType: "unknown",
			asOf,
		});
		expect(unknownFee.total).toBeGreaterThan(secondary.total);
	});

	it("penalizes soft and overstuffed fee values", () => {
		const soft = scoreEvidence({
			url: "https://brand.example/fees",
			field: "fee",
			entity: "A",
			value: "Premium",
			sourceType: "primary",
			asOf: "2026-07-25",
		});
		const concrete = scoreEvidence({
			url: "https://brand.example/fees",
			field: "fee",
			entity: "A",
			value: "1.200 TL",
			sourceType: "primary",
			asOf: "2026-07-25",
		});
		expect(concrete.total).toBeGreaterThan(soft.total);
	});
});
