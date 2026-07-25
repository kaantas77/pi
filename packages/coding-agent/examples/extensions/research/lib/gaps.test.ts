import { describe, expect, it } from "vitest";
import type { FindingRecord, ResearchBundle, ResearchPlan, SourceRecord } from "./artifacts.ts";
import { analyzeGaps, gapPassProgress, suggestGapQueries } from "./gaps.ts";

function plan(overrides: Partial<ResearchPlan> = {}): ResearchPlan {
	return {
		id: "run1",
		question: "Compare Alpha vs Beta fees",
		policy: "official",
		entities: ["Alpha", "Beta"],
		dimensions: ["annual_fee"],
		requiredDimensions: ["annual_fee"],
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
		field: "annual_fee",
		value: "100",
		evidence: "fee is 100",
		sourceUrl: "https://docs.example.com/a",
		confidence: "high",
		status: "observed",
		recordedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function bundle(overrides: Partial<ResearchBundle> = {}): ResearchBundle {
	const p = overrides.plan ?? plan();
	const sources: SourceRecord[] = overrides.sources ?? [
		{ id: "s1", url: "https://docs.example.com/a", type: "primary", fetchedAt: "2026-01-01T00:00:00.000Z" },
	];
	return {
		plan: p,
		sources,
		findings: overrides.findings ?? [finding({})],
		openQuestions: overrides.openQuestions ?? [],
		discovered: overrides.discovered ?? [],
	};
}

describe("analyzeGaps", () => {
	it("flags missing entities and suggests queries for one recovery pass", () => {
		const analysis = analyzeGaps(
			bundle({
				findings: [finding({})],
			}),
		);
		expect(analysis.gaps.some((g) => g.kind === "missing_cell" && g.entity === "Beta")).toBe(true);
		expect(analysis.shouldRunGapPass).toBe(true);
		expect(analysis.suggestedQueries.length).toBeGreaterThan(0);
		expect(analysis.suggestedQueries.some((q) => q.includes("Beta"))).toBe(true);
	});

	it("includes not_found cells as fillable gaps", () => {
		const analysis = analyzeGaps(
			bundle({
				plan: plan({ entities: ["Alpha"], dimensions: ["annual_fee"] }),
				findings: [
					finding({
						entity: "Alpha",
						field: "annual_fee",
						status: "not_found",
						value: "not found",
						evidence: "",
						sourceUrl: "",
					}),
				],
				sources: [],
			}),
		);
		expect(analysis.gaps.some((g) => g.kind === "not_found_cell")).toBe(true);
		expect(analysis.shouldRunGapPass).toBe(true);
	});

	it("stops recommending another pass after gapPass is done", () => {
		const analysis = analyzeGaps(
			bundle({
				plan: plan({
					gapPass: { status: "done", queries: ["Beta annual fee"], completedAt: "2026-01-02T00:00:00.000Z" },
				}),
				findings: [finding({})],
			}),
		);
		expect(analysis.shouldRunGapPass).toBe(false);
		expect(analysis.gapPassExhausted).toBe(true);
	});

	it("has no gap pass when coverage is complete", () => {
		const analysis = analyzeGaps(
			bundle({
				findings: [
					finding({}),
					finding({
						id: "f2",
						entity: "Beta",
						field: "annual_fee",
						value: "200",
						sourceUrl: "https://docs.example.com/b",
					}),
				],
				sources: [
					{ id: "s1", url: "https://docs.example.com/a", type: "primary", fetchedAt: "2026-01-01T00:00:00.000Z" },
					{ id: "s2", url: "https://docs.example.com/b", type: "primary", fetchedAt: "2026-01-01T00:00:00.000Z" },
				],
			}),
		);
		expect(analysis.gaps.filter((g) => g.kind === "missing_entity" || g.kind === "missing_dimension")).toHaveLength(
			0,
		);
		expect(analysis.shouldRunGapPass).toBe(false);
		expect(analysis.gapPassExhausted).toBe(false);
	});
});

describe("suggestGapQueries", () => {
	it("caps query count", () => {
		const queries = suggestGapQueries({
			question: "fees",
			maxQueries: 2,
			gaps: [
				{ kind: "missing_entity", entity: "A", detail: "A" },
				{ kind: "missing_entity", entity: "B", detail: "B" },
				{ kind: "missing_entity", entity: "C", detail: "C" },
			],
		});
		expect(queries).toHaveLength(2);
	});
});

describe("gapPassProgress", () => {
	it("requires new findings or fetches after start", () => {
		expect(
			gapPassProgress({
				startedAt: "2026-01-02T00:00:00.000Z",
				findings: [{ recordedAt: "2026-01-01T00:00:00.000Z" }],
				sources: [{ fetchedAt: "2026-01-01T12:00:00.000Z" }],
				discovered: [],
			}).ok,
		).toBe(false);
		expect(
			gapPassProgress({
				startedAt: "2026-01-02T00:00:00.000Z",
				findings: [{ recordedAt: "2026-01-02T01:00:00.000Z" }],
				sources: [],
				discovered: [],
			}).ok,
		).toBe(true);
	});
});
