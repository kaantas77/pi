import { describe, expect, it } from "vitest";
import type { FindingRecord, ResearchPlan } from "./artifacts.ts";
import { findUngroundedEntityMentions } from "./brief-grounding.ts";

function plan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
	return {
		id: "run1",
		question: "compare",
		policy: "general",
		entities: ["Alpha Card", "Beta Card"],
		dimensions: ["price"],
		requiredDimensions: ["price"],
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

describe("findUngroundedEntityMentions", () => {
	it("flags planned entities described in brief without ledger findings", () => {
		const findings: FindingRecord[] = [
			{
				id: "f1",
				entity: "Alpha Card",
				field: "price",
				value: "10",
				evidence: "10",
				sourceUrl: "https://docs.example.com/a",
				confidence: "high",
				status: "observed",
				recordedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const ungrounded = findUngroundedEntityMentions({
			briefMarkdown: "# Report\n\n## Alpha Card\n10 TL\n\n## Beta Card\nLooks premium with lounge.\n",
			plan: plan(),
			findings,
		});
		expect(ungrounded).toEqual(["Beta Card"]);
	});

	it("allows entities that have findings", () => {
		const findings: FindingRecord[] = [
			{
				id: "f1",
				entity: "Alpha Card",
				field: "price",
				value: "10",
				evidence: "10",
				sourceUrl: "https://docs.example.com/a",
				confidence: "high",
				status: "observed",
				recordedAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "f2",
				entity: "Beta Card",
				field: "price",
				value: "not found",
				evidence: "",
				sourceUrl: "",
				confidence: "low",
				status: "not_found",
				recordedAt: "2026-01-01T00:00:00.000Z",
			},
		];
		const ungrounded = findUngroundedEntityMentions({
			briefMarkdown: "Alpha Card is 10. Beta Card could not be verified.",
			plan: plan(),
			findings,
		});
		expect(ungrounded).toEqual([]);
	});
});
