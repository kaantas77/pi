import { describe, expect, it } from "vitest";
import {
	isPageAbsenceNotFound,
	isPlanOversized,
	isScheduleLikeField,
	pickDefaultRequiredDimensions,
	rankBoostForQuery,
	resolveAsOfDate,
	urlLooksLikeSchedule,
} from "./plan-scope.ts";

describe("plan-scope", () => {
	it("picks fee/campaign fields as required when too many dimensions", () => {
		const dims = ["renk", "yıllık ücret", "aktif kampanyalar", "lounge erişimi", "fast track", "notlar", "tasarım"];
		const required = pickDefaultRequiredDimensions(dims);
		expect(required.length).toBe(5);
		expect(required).toContain("yıllık ücret");
		expect(required).toContain("aktif kampanyalar");
	});

	it("flags oversized plans", () => {
		expect(
			isPlanOversized({
				entities: Array.from({ length: 20 }, (_, i) => `E${i}`),
				dimensions: ["a", "b", "c"],
				requiredDimensions: ["a", "b", "c"],
			}),
		).toBe(true);
	});

	it("detects page-absence not_found and schedule URLs", () => {
		expect(isScheduleLikeField("yıllık ücret")).toBe(true);
		expect(isPageAbsenceNotFound("Yıllık ücretler American Express sayfasında belirtilmemiştir")).toBe(true);
		expect(
			urlLooksLikeSchedule("https://www.americanexpress.com.tr/destek/faiz-ve-ucretler/yillik-uyelik-bedeli"),
		).toBe(true);
		expect(
			rankBoostForQuery(
				"https://www.americanexpress.com.tr/destek/faiz-ve-ucretler/yillik-uyelik-bedeli",
				"Amex yıllık ücret",
			),
		).toBeGreaterThan(1);
	});

	it("clamps stale asOf dates to today", () => {
		expect(resolveAsOfDate("2025-07-14", new Date("2026-07-25T12:00:00.000Z"))).toBe("2026-07-25");
		expect(resolveAsOfDate("2026-07-24", new Date("2026-07-25T12:00:00.000Z"))).toBe("2026-07-24");
		expect(resolveAsOfDate(undefined, new Date("2026-07-25T12:00:00.000Z"))).toBe("2026-07-25");
	});
});
