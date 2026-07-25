import { describe, expect, it } from "vitest";
import { displayFieldLabel, humanizeLabel } from "./display.ts";
import { isOverstuffedValue, looksLikeAggregateEntity } from "./entity-quality.ts";
import { missingPlanFacets } from "./plan-facets.ts";
import { isOngoingBenefitField, isTimeBoundOfferField, promoteQuestionDimensions } from "./plan-scope.ts";
import { classifySourceType, getSourcePolicy } from "./policy.ts";
import { groupEntitiesByPrefix } from "./publish-brief.ts";

describe("display labels", () => {
	it("humanizes slug and snake_case fields", () => {
		expect(humanizeLabel("garanti-amex-gold")).toBe("Garanti Amex Gold");
		expect(humanizeLabel("kampanya_adi")).toBe("Kampanya Adi");
		expect(humanizeLabel("puan_kazanma_orani")).toBe("Puan Kazanma Orani");
	});

	it("maps annual fee field ids", () => {
		expect(displayFieldLabel("yıllık-ücret")).toBe("Yıllık ücret");
		expect(displayFieldLabel("yıllık ücret")).toBe("Yıllık ücret");
	});
});

describe("promoteQuestionDimensions", () => {
	it("pulls lounge into required when question mentions lounge", () => {
		const required = promoteQuestionDimensions(
			"kartların yıllık ücretleri ve lounge avantajları nelerdir?",
			["yıllık-ücret"],
			["yıllık-ücret", "lounge-avantajı", "puan"],
		);
		expect(required.some((d) => /lounge/i.test(d))).toBe(true);
	});
});

describe("entity quality", () => {
	it("flags category/catalog bags", () => {
		expect(looksLikeAggregateEntity("Garanti BBVA Kredi Kartları")).toBe(true);
		expect(looksLikeAggregateEntity("Acme Cloud Products")).toBe(true);
		expect(looksLikeAggregateEntity("Acme Pro Plan")).toBe(false);
		expect(looksLikeAggregateEntity("Wings Elite")).toBe(false);
	});

	it("flags overstuffed multi-price cells but ignores unit rates", () => {
		expect(isOverstuffedValue("A 1.000 TL, B 2.000 TL, C 3.000 TL, D 4.000 TL, E 5.000 TL")).toBe(true);
		expect(isOverstuffedValue("19.600 TL yıllık")).toBe(false);
		expect(
			isOverstuffedValue("Havayolu 1 TL'ye 1 mil; yurt içi 1 TL'ye 0,75 mil; LoungeKey yılda 8; indirim %5-10"),
		).toBe(false);
		expect(
			isOverstuffedValue(
				"Mil Puan (20-100 MP/100TL); restoran %15; otel %10; Style %20; sağlıkta 1.000 TL'ye varan",
			),
		).toBe(false);
	});
});

describe("source classification", () => {
	const policy = getSourcePolicy("general");

	it("promotes official fee/support documents to primary", () => {
		expect(
			classifySourceType("https://www.americanexpress.com.tr/destek/faiz-ve-ucretler/yillik-uyelik-bedeli", policy),
		).toBe("primary");
		expect(classifySourceType("https://gorsel.isbank.com.tr/kredikarti/KKR-SOBF.pdf", policy)).toBe("primary");
	});

	it("marks comparison listicles as secondary", () => {
		expect(classifySourceType("https://devlethan.net/tum-bankalarin-kredi-karti-aidatlari.html/", policy)).toBe(
			"secondary",
		);
	});
});

describe("time-bound vs ongoing fields", () => {
	it("requires end dates only for offer fields, not standing benefits", () => {
		expect(isTimeBoundOfferField("aktif kampanyalar")).toBe(true);
		expect(isTimeBoundOfferField("current_campaigns")).toBe(true);
		expect(isTimeBoundOfferField("öne çıkan kampanyalar / avantajlar")).toBe(true);
		expect(isTimeBoundOfferField("lounge erişimi")).toBe(false);
		expect(isTimeBoundOfferField("puan kazanma oranı")).toBe(false);
		expect(isOngoingBenefitField("lounge erişimi")).toBe(true);
		expect(isOngoingBenefitField("aktif kampanyalar")).toBe(false);
	});
});

describe("groupEntitiesByPrefix", () => {
	it("groups siblings by shared leading tokens without hard-coded brands", () => {
		const groups = groupEntitiesByPrefix([
			"Garanti Amex Gold",
			"Garanti Amex Platinum",
			"Akbank Wings",
			"Akbank Wings Elite",
			"Solo Product",
		]);
		expect(groups.some((g) => g.title === "Garanti Amex" && g.entities.length === 2)).toBe(true);
		expect(groups.some((g) => g.title === "Akbank Wings" && g.entities.length === 2)).toBe(true);
		expect(groups.some((g) => g.entities.length === 1 && g.entities[0] === "Solo Product")).toBe(true);
	});
});

describe("plan facets", () => {
	it("detects thin plans that omit question facets", () => {
		expect(missingPlanFacets("compare annual fees and lounge access and active campaigns", ["annual fee"])).toEqual(
			expect.arrayContaining(["access", "offer"]),
		);
		expect(missingPlanFacets("what is the annual fee only?", ["yıllık ücret"])).toEqual([]);
	});
});
