/**
 * Research Extension
 *
 * Artifact-first web research: typed search/fetch tools + research ledger + verify gate.
 *
 * Flow: research_init → web_search → web_fetch → research_record_* → research_gaps (one fill) → research_verify → research_finalize
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	createResearchRun,
	type FindingConfidence,
	type FindingStatus,
	listResearchRuns,
	loadBundle,
	type ResearchOutputFormat,
	recordFinding,
	recordSource,
	resolveRunDir,
	setOpenQuestions,
	touchPlan,
	tryResolveRunDir,
	writeBrief,
	writeTableCsv,
} from "./lib/artifacts.ts";
import { getExaApiKey } from "./lib/auth.ts";
import { auditDraftAgainstLedger } from "./lib/brief-grounding.ts";
import { buildCellLedger, formatCellLedgerSummary } from "./lib/cells.ts";
import {
	fetchedUrlSet,
	listUnfetchedMustFetch,
	markDiscoveredFetched,
	recordDiscoveredUrls,
	skipDiscoveredUrl,
} from "./lib/discovered.ts";
import { findAggregateEntities } from "./lib/entity-quality.ts";
import { exaContents, exaSearch } from "./lib/exa.ts";
import { analyzeGaps, formatGapAnalysis, gapPassProgress, readGapPass } from "./lib/gaps.ts";
import { coverageRatio, MIN_FORCE_COVERAGE_RATIO } from "./lib/plan-scope.ts";
import {
	classifySourceType,
	getSourcePolicy,
	listSourcePolicies,
	rankSearchResults,
	type SourcePolicyName,
} from "./lib/policy.ts";
import { buildPublishBrief } from "./lib/publish-brief.ts";
import { buildResearchModePrompt } from "./lib/research-prompt.ts";
import { auditResearch, formatVerifyReport, loadEntityDisplayNames, verifyResearch } from "./lib/verify.ts";

interface ResearchModeState {
	enabled: boolean;
	activeRunId?: string;
}

const SourcePolicySchema = StringEnum(["general", "official", "docs", "news", "academic"] as const);
const OutputFormatSchema = StringEnum(["brief", "table", "json"] as const);
const FindingStatusSchema = StringEnum(["observed", "inferred", "conflict", "not_found"] as const);
const FindingConfidenceSchema = StringEnum(["high", "medium", "low"] as const);

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max)}...`;
}

function toolText(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the web (Exa). Returns ranked results with titles, URLs, dates, and optional text. " +
		"Use for discovery only — fetch primary pages before treating content as evidence.",
	promptSnippet: "Search the web for sources (discovery; not evidence)",
	promptGuidelines: [
		"Use web_search for discovery, then web_fetch must-fetch URLs before recording observed findings.",
		"Top search hits are tracked as must-fetch. Do not conclude unknown/soft until they are fetched or explicitly skipped.",
		"Fan out multiple specific queries instead of one vague query.",
		"Prefer includeDomains when hunting official/docs sources.",
	],
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		numResults: Type.Optional(Type.Number({ description: "Results to return (default 10, max 50)" })),
		includeText: Type.Optional(Type.Boolean({ description: "Include truncated page text in results" })),
		type: Type.Optional(
			StringEnum(["keyword", "neural", "auto"] as const, {
				description: "Search mode (default auto)",
			}),
		),
		policy: Type.Optional(SourcePolicySchema),
		includeDomains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains" })),
		excludeDomains: Type.Optional(Type.Array(Type.String(), { description: "Exclude these domains" })),
		startPublishedDate: Type.Optional(Type.String({ description: "ISO date lower bound" })),
		endPublishedDate: Type.Optional(Type.String({ description: "ISO date upper bound" })),
		runId: Type.Optional(Type.String({ description: "Research run to attach discovered URLs to" })),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const policy = getSourcePolicy(params.policy as SourcePolicyName | undefined);
		const response = await exaSearch(params.query, {
			numResults: params.numResults ?? 10,
			type: (params.type as "keyword" | "neural" | "auto" | undefined) ?? "auto",
			includeText: params.includeText ?? false,
			includeDomains: params.includeDomains,
			excludeDomains: params.excludeDomains,
			startPublishedDate: params.startPublishedDate,
			endPublishedDate: params.endPublishedDate,
			signal,
		});

		const ranked = rankSearchResults(response.results, policy, params.query);
		const runDir = tryResolveRunDir(ctx.cwd, params.runId);
		let discoveryNote = "";
		if (runDir) {
			const tracked = recordDiscoveredUrls(runDir, {
				query: params.query,
				results: ranked.map((r) => ({
					url: r.url,
					title: r.title,
					sourceType: r.sourceType,
					rankScore: r.rankScore,
				})),
				mustFetchTopN: 5,
			});
			const pending = listUnfetchedMustFetch(runDir);
			const mustMarked = ranked.filter((r, i) => i < 5 && r.sourceType !== "secondary").length;
			discoveryNote = `\nTracked ${tracked.added} new URL(s). Must-fetch candidates this page: ${mustMarked} (secondary excluded). Unfetched must-fetch backlog: ${pending.length}. web_fetch them before soft/not_found conclusions.`;
		}

		const lines: string[] = [];
		lines.push(`Search: "${params.query}" (policy=${policy.name})`);
		if (response.autopromptString) lines.push(`Optimized query: "${response.autopromptString}"`);
		lines.push(`Results: ${ranked.length}\n`);

		for (let i = 0; i < ranked.length; i++) {
			const r = ranked[i];
			const must = i < 5 && r.sourceType !== "secondary" ? " must-fetch" : "";
			lines.push(`${i + 1}. [${r.sourceType}${must}] ${r.title ?? "(no title)"}`);
			lines.push(`   URL: ${r.url}`);
			if (r.publishedDate) lines.push(`   Date: ${r.publishedDate}`);
			if (r.author) lines.push(`   Author: ${r.author}`);
			if (r.score !== undefined) lines.push(`   Score: ${(r.score * 100).toFixed(1)}%`);
			if (r.text) lines.push(`   Snippet: ${truncate(r.text, 1200)}`);
			lines.push("");
		}
		if (discoveryNote) lines.push(discoveryNote);

		return {
			...toolText(lines.join("\n")),
			details: {
				query: params.query,
				policy: policy.name,
				resultCount: ranked.length,
				runDir,
				results: ranked.map((r) => ({
					title: r.title,
					url: r.url,
					publishedDate: r.publishedDate,
					score: r.score,
					sourceType: r.sourceType,
					rankScore: r.rankScore,
				})),
			},
		};
	},
	renderCall(args, theme) {
		return new Text(
			theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("accent", truncate(args.query ?? "", 70)),
			0,
			0,
		);
	},
});

const webFetchTool = defineTool({
	name: "web_fetch",
	label: "Web Fetch",
	description:
		"Fetch full page text for one or more URLs (Exa contents). Use after web_search to obtain evidence from primary sources.",
	promptSnippet: "Fetch full page text from URLs for evidence",
	promptGuidelines: [
		"Always web_fetch must-fetch / cited URLs before recording status=observed findings.",
		"Batch related URLs in one call when possible.",
		"If search discovered a URL, fetch it (or research_skip_discovered) before concluding unknown.",
	],
	parameters: Type.Object({
		urls: Type.Array(Type.String(), { description: "URLs to fetch" }),
		maxCharacters: Type.Optional(Type.Number({ description: "Max characters per page (default 12000)" })),
		policy: Type.Optional(SourcePolicySchema),
		runId: Type.Optional(
			Type.String({ description: "Research run to record sources into (defaults to latest run)" }),
		),
	}),
	async execute(_toolCallId, params, signal, _onUpdate, ctx) {
		const policy = getSourcePolicy(params.policy as SourcePolicyName | undefined);
		const response = await exaContents(params.urls, {
			maxCharacters: params.maxCharacters ?? 12000,
			signal,
		});

		const lines: string[] = [];
		const recorded: Array<{ url: string; type: string }> = [];
		const runDir = tryResolveRunDir(ctx.cwd, params.runId);

		for (const r of response.results) {
			const sourceType = classifySourceType(r.url, policy);
			lines.push(`=== [${sourceType}] ${r.title ?? r.url} ===`);
			lines.push(`URL: ${r.url}`);
			if (r.publishedDate) lines.push(`Date: ${r.publishedDate}`);
			lines.push("");
			lines.push(r.text?.trim() ? r.text : "(no content extracted)");
			lines.push("");
			lines.push("─".repeat(60));
			lines.push("");

			if (runDir) {
				recordSource(runDir, {
					url: r.url,
					title: r.title,
					type: sourceType,
					fetchedAt: new Date().toISOString(),
				});
				recorded.push({ url: r.url, type: sourceType });
			}
		}

		if (runDir) {
			markDiscoveredFetched(
				runDir,
				response.results.map((r) => r.url),
			);
			const pending = listUnfetchedMustFetch(runDir);
			lines.push(
				`Marked ${response.results.length} URL(s) fetched in run ledger. Unfetched must-fetch backlog: ${pending.length}.`,
			);
		}

		return {
			...toolText(lines.join("\n")),
			details: {
				fetched: response.results.length,
				recorded,
				runDir,
				urls: response.results.map((r) => ({
					url: r.url,
					title: r.title,
					sourceType: classifySourceType(r.url, policy),
				})),
			},
		};
	},
	renderCall(args, theme) {
		const n = args.urls?.length ?? 0;
		return new Text(theme.fg("toolTitle", theme.bold("web_fetch ")) + theme.fg("accent", `${n} url(s)`), 0, 0);
	},
});

const researchInitTool = defineTool({
	name: "research_init",
	label: "Research Init",
	description:
		"Create a research run under .pi-research/<id>/ with plan, empty sources/findings ledgers, and open questions. Call this before recording findings.",
	promptSnippet: "Start a structured research run with entities and dimensions",
	promptGuidelines: [
		"Call research_init before synthesizing research answers.",
		"Entities must be atomic comparison units (one product/plan/SKU/version each) — not category bags like 'X cards' or 'Y products'.",
		"Keep required scope small: prefer ≤8 entities and ≤5 requiredDimensions. Put nice-to-haves in optionalDimensions.",
		"List concrete entities and required dimensions you must cover.",
	],
	parameters: Type.Object({
		question: Type.String({ description: "Research question / goal" }),
		entities: Type.Array(Type.String(), {
			description: "Atomic entities to cover (not catalog/category bags)",
		}),
		dimensions: Type.Array(Type.String(), {
			description: "All fields of interest (required + optional). Prefer ≤5 required via requiredDimensions.",
		}),
		requiredDimensions: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Fields that MUST be filled per entity (matrix gate). Keep small. Defaults to auto-picked top fields.",
			}),
		),
		optionalDimensions: Type.Optional(
			Type.Array(Type.String(), {
				description: "Nice-to-have fields — record if found; never block verify",
			}),
		),
		policy: Type.Optional(SourcePolicySchema),
		queries: Type.Optional(Type.Array(Type.String(), { description: "Seed search queries" })),
		outputFormat: Type.Optional(OutputFormatSchema),
		asOfDate: Type.Optional(
			Type.String({ description: "Research as-of date YYYY-MM-DD for freshness (default: today)" }),
		),
		runId: Type.Optional(Type.String({ description: "Optional custom run id" })),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const plan = createResearchRun(ctx.cwd, {
			question: params.question,
			policy: (params.policy as SourcePolicyName | undefined) ?? "general",
			entities: params.entities,
			dimensions: params.dimensions,
			requiredDimensions: params.requiredDimensions,
			optionalDimensions: params.optionalDimensions,
			queries: params.queries,
			outputFormat: params.outputFormat as ResearchOutputFormat | undefined,
			asOfDate: params.asOfDate,
			runId: params.runId,
		});

		const cellCount = plan.entities.length * plan.requiredDimensions.length;
		const aggregate = findAggregateEntities(plan.entities);
		const lines = [
			`Research run created: ${plan.id}`,
			`Dir: ${plan.dir}`,
			`Policy: ${plan.policy}`,
			`Output: ${plan.outputFormat}`,
			`Entities (${plan.entities.length}): ${plan.entities.join("; ") || "(none)"}`,
			`Required dimensions (${plan.requiredDimensions.length}): ${plan.requiredDimensions.join("; ") || "(none)"}`,
			`Optional dimensions (${plan.optionalDimensions.length}): ${plan.optionalDimensions.join("; ") || "(none)"}`,
			`Required cells: ${cellCount}${plan.oversized ? ` — OVERSIZED (>48). Narrow entities/requiredDimensions or expect sparse/partial.` : ""}`,
			aggregate.length > 0
				? `WARNING: aggregate/category entities (will fail verify): ${aggregate.join("; ")}. Split into atomic units.`
				: "",
			plan.queries.length > 0 ? `Seed queries: ${plan.queries.join(" | ")}` : "Seed queries: (none)",
			"",
			"Next: web_search fan-out → web_fetch primary/schedule URLs → research_record_finding → research_gaps (one fill if missing) → research_verify.",
			"Fee/price fields: require primary official fee/pricing/support documents — not comparison blogs.",
		].filter(Boolean);

		return {
			...toolText(lines.join("\n")),
			details: {
				runId: plan.id,
				dir: plan.dir,
				policy: plan.policy,
				requiredDimensions: plan.requiredDimensions,
				optionalDimensions: plan.optionalDimensions,
				oversized: plan.oversized,
				requiredCells: cellCount,
			},
		};
	},
});

const researchRecordSourceTool = defineTool({
	name: "research_record_source",
	label: "Research Record Source",
	description: "Append or update a source in the research ledger (sources.jsonl).",
	promptSnippet: "Record a source URL into the research ledger",
	parameters: Type.Object({
		url: Type.String(),
		title: Type.Optional(Type.String()),
		type: Type.Optional(StringEnum(["primary", "secondary", "unknown"] as const)),
		notes: Type.Optional(Type.String()),
		fetched: Type.Optional(Type.Boolean({ description: "Mark as fetched now (default true)" })),
		runId: Type.Optional(Type.String()),
		policy: Type.Optional(SourcePolicySchema),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveRunDir(ctx.cwd, params.runId);
		const policy = getSourcePolicy(params.policy as SourcePolicyName | undefined);
		const type = params.type ?? classifySourceType(params.url, policy);
		const record = recordSource(runDir, {
			url: params.url,
			title: params.title,
			type,
			fetchedAt: params.fetched === false ? undefined : new Date().toISOString(),
			notes: params.notes,
		});
		touchPlan(loadBundle(ctx.cwd, params.runId).plan);
		return {
			...toolText(`Recorded source ${record.id} [${record.type}] ${record.url}`),
			details: record,
		};
	},
});

const researchRecordFindingTool = defineTool({
	name: "research_record_finding",
	label: "Research Record Finding",
	description:
		"Append a structured finding to findings.jsonl. Observed findings require a web_fetch'd sourceUrl + evidence quote. Soft placeholders (e.g. 'see fee page') are rejected — use not_found or fetch first.",
	promptSnippet: "Record a cited finding into the research ledger",
	promptGuidelines: [
		"Never record status=observed without sourceUrl + evidence from a fetched page.",
		"Never record soft placeholders as observed (e.g. 'listed on fee page', 'not specified').",
		"Use not_found for planned entities/fields you could not verify after fetching must-fetch URLs.",
		"Campaign-like fields require validTo (YYYY-MM-DD). Do not record conflicting values for the same entity×field.",
	],
	parameters: Type.Object({
		entity: Type.String(),
		field: Type.String(),
		value: Type.String(),
		status: FindingStatusSchema,
		confidence: Type.Optional(FindingConfidenceSchema),
		sourceUrl: Type.Optional(Type.String()),
		evidence: Type.Optional(Type.String()),
		validFrom: Type.Optional(Type.String({ description: "Claim start date YYYY-MM-DD" })),
		validTo: Type.Optional(
			Type.String({ description: "Claim end date YYYY-MM-DD (required for campaign-like fields)" }),
		),
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveRunDir(ctx.cwd, params.runId);
		const fetched = fetchedUrlSet(runDir);
		// Also treat sources.jsonl fetchedAt as fetched
		for (const s of loadBundle(ctx.cwd, params.runId).sources) {
			if (s.fetchedAt) fetched.add(s.url);
		}
		try {
			const record = recordFinding(runDir, {
				entity: params.entity,
				field: params.field,
				value: params.value,
				status: params.status as FindingStatus,
				confidence: (params.confidence as FindingConfidence | undefined) ?? "medium",
				sourceUrl: params.sourceUrl ?? "",
				evidence: params.evidence ?? "",
				validFrom: params.validFrom,
				validTo: params.validTo,
				fetchedUrls: fetched,
			});
			touchPlan(loadBundle(ctx.cwd, params.runId).plan);
			return {
				...toolText(
					`Recorded finding ${record.id}: ${record.entity}.${record.field} = ${truncate(record.value, 120)} (${record.status})`,
				),
				details: record,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				...toolText(`Rejected finding: ${message}`),
				details: { error: message },
				isError: true,
			};
		}
	},
});

const researchSkipDiscoveredTool = defineTool({
	name: "research_skip_discovered",
	label: "Research Skip Discovered",
	description:
		"Mark a search-discovered must-fetch URL as skipped with a reason (junk, duplicate, paywall, wrong entity). Prefer web_fetch when the URL may contain the missing fact.",
	promptSnippet: "Skip a discovered URL that should not be fetched",
	parameters: Type.Object({
		url: Type.String(),
		reason: Type.String({ description: "Why this URL will not be fetched" }),
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveRunDir(ctx.cwd, params.runId);
		const row = skipDiscoveredUrl(runDir, params.url, params.reason);
		touchPlan(loadBundle(ctx.cwd, params.runId).plan);
		const pending = listUnfetchedMustFetch(runDir);
		return {
			...toolText(`Skipped ${row.url} (${row.skipReason}). Unfetched must-fetch backlog: ${pending.length}.`),
			details: { skipped: row, pending: pending.length },
		};
	},
});

const researchAuditTool = defineTool({
	name: "research_audit",
	label: "Research Audit",
	description:
		"Diagnose research failure modes: soft observed values, unfetched must-fetch URLs, observed citations that were never fetched.",
	promptSnippet: "Audit research ledger failure modes",
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const bundle = loadBundle(ctx.cwd, params.runId);
		const audit = auditResearch(bundle);
		const pending = listUnfetchedMustFetch(bundle.plan.dir);
		const lines = [
			`Research audit (run ${bundle.plan.id})`,
			`failure_mode: ${audit.failureMode}`,
			`soft_observed: ${audit.softObservedCount}`,
			`observed_without_evidence: ${audit.observedWithoutEvidence}`,
			`unfetched_citations: ${audit.unfetchedCitationCount}`,
			`unfetched_must_fetch: ${audit.unfetchedMustFetchCount}`,
			"",
			pending.length === 0
				? "No unfetched must-fetch URLs."
				: `Unfetched must-fetch:\n${pending
						.slice(0, 20)
						.map((u) => `- ${u.url}`)
						.join("\n")}`,
		];
		return {
			...toolText(lines.join("\n")),
			details: { audit, pending },
		};
	},
});

const researchSetOpenQuestionsTool = defineTool({
	name: "research_set_open_questions",
	label: "Research Open Questions",
	description: "Replace the open_questions.json list for the active research run.",
	promptSnippet: "Update unresolved research questions",
	parameters: Type.Object({
		questions: Type.Array(Type.String()),
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runDir = resolveRunDir(ctx.cwd, params.runId);
		const questions = setOpenQuestions(runDir, params.questions);
		touchPlan(loadBundle(ctx.cwd, params.runId).plan);
		return {
			...toolText(
				questions.length === 0
					? "Open questions cleared."
					: `Open questions (${questions.length}):\n${questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`,
			),
			details: { questions },
		};
	},
});

const researchStatusTool = defineTool({
	name: "research_status",
	label: "Research Status",
	description: "Show research run ledger summary (plan, source/finding counts, open questions).",
	promptSnippet: "Inspect the current research run status",
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const runs = listResearchRuns(ctx.cwd);
		if (runs.length === 0) {
			return toolText("No research runs under .pi-research/");
		}

		const bundle = loadBundle(ctx.cwd, params.runId);
		const pending = listUnfetchedMustFetch(bundle.plan.dir);
		const gapPass = readGapPass(bundle.plan);
		const analysis = analyzeGaps(bundle);
		const lines = [
			`Run: ${bundle.plan.id}`,
			`Question: ${bundle.plan.question}`,
			`Policy: ${bundle.plan.policy}`,
			`Dir: ${bundle.plan.dir}`,
			`Entities: ${bundle.plan.entities.join("; ") || "(none)"}`,
			`Dimensions: ${bundle.plan.dimensions.join("; ") || "(none)"}`,
			`Sources: ${bundle.sources.length}`,
			`Findings: ${bundle.findings.length}`,
			`Discovered: ${bundle.discovered.length} (unfetched must-fetch: ${pending.length})`,
			`Open questions: ${bundle.openQuestions.length}`,
			`Gap pass: ${gapPass.status} (fillable gaps: ${analysis.gaps.length})`,
			`All runs: ${runs.join(", ")}`,
		];
		return {
			...toolText(lines.join("\n")),
			details: {
				runId: bundle.plan.id,
				sources: bundle.sources.length,
				findings: bundle.findings.length,
				discovered: bundle.discovered.length,
				unfetchedMustFetch: pending.length,
				openQuestions: bundle.openQuestions,
				gapPass: gapPass.status,
				gaps: analysis.gaps.length,
			},
		};
	},
});

const researchGapsTool = defineTool({
	name: "research_gaps",
	label: "Research Gaps",
	description:
		"List missing coverage / not_found cells and suggest one targeted recovery search pass. Call after the first collect round, before finalize.",
	promptSnippet: "Inspect gaps and get one recovery search pass plan",
	promptGuidelines: [
		"After the first search/fetch/record round, call research_gaps.",
		"If shouldRunGapPass, run ONE targeted web_search/web_fetch round for the suggested queries, then research_complete_gap_pass.",
		"Do not start a second deep crawl after gap pass is done.",
	],
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
		startPass: Type.Optional(
			Type.Boolean({
				description:
					"Mark gap pass in_progress and store suggested queries on the plan (default true when gaps exist)",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const bundle = loadBundle(ctx.cwd, params.runId);
		const analysis = analyzeGaps(bundle);
		const start =
			params.startPass !== false && analysis.shouldRunGapPass && analysis.gapPass.status === "not_started";

		if (start) {
			const now = new Date().toISOString();
			touchPlan(bundle.plan, {
				gapPass: {
					status: "in_progress",
					startedAt: now,
					queries: analysis.suggestedQueries,
				},
			});
			analysis.gapPass = {
				status: "in_progress",
				startedAt: now,
				queries: analysis.suggestedQueries,
			};
		}

		const header = start ? "Gap pass marked in_progress. Run the one recovery search round now.\n\n" : "";
		return {
			...toolText(`${header}${formatGapAnalysis(analysis)}`),
			details: analysis,
		};
	},
});

const researchCompleteGapPassTool = defineTool({
	name: "research_complete_gap_pass",
	label: "Research Complete Gap Pass",
	description:
		"Mark the single gap-fill recovery pass as done after targeted re-search/fetch/record. Prevents endless deepening.",
	promptSnippet: "Finish the one gap-fill pass, then verify",
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
		queriesUsed: Type.Optional(
			Type.Array(Type.String(), { description: "Queries actually used in the recovery pass" }),
		),
		notes: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const bundle = loadBundle(ctx.cwd, params.runId);
		const prev = readGapPass(bundle.plan);
		if (prev.status === "not_started") {
			return {
				...toolText(
					"Gap pass not started. Call research_gaps first (starts the one recovery pass), then search/fetch/record, then research_complete_gap_pass.",
				),
				details: { blocked: true, reason: "gap_pass_not_started" },
				isError: true,
			};
		}
		if (prev.status === "done") {
			return {
				...toolText("Gap pass already marked done. Do not start another deep crawl."),
				details: { blocked: true, reason: "gap_pass_already_done", gapPass: prev },
				isError: true,
			};
		}

		const progress = gapPassProgress({
			startedAt: prev.startedAt,
			findings: bundle.findings,
			sources: bundle.sources,
			discovered: bundle.discovered,
		});
		if (!progress.ok) {
			return {
				...toolText(
					`Gap pass has no progress since it started (${prev.startedAt ?? "unknown"}).\n` +
						`Need at least one new web_fetch or research_record_finding during the recovery pass before completing.\n` +
						`Progress: newFindings=${progress.newFindings}, newFetches=${progress.newFetches}.`,
				),
				details: { blocked: true, reason: "gap_pass_no_progress", progress },
				isError: true,
			};
		}

		const now = new Date().toISOString();
		const queries = params.queriesUsed?.length ? params.queriesUsed : prev.queries;
		const next = touchPlan(bundle.plan, {
			gapPass: {
				status: "done",
				startedAt: prev.startedAt ?? now,
				completedAt: now,
				queries,
			},
		});
		const analysis = analyzeGaps({ ...bundle, plan: next });
		const note = params.notes?.trim() ? `\nNotes: ${params.notes.trim()}` : "";
		return {
			...toolText(
				`Gap pass marked done (newFindings=${progress.newFindings}, newFetches=${progress.newFetches}).${note}\n\n${formatGapAnalysis(analysis)}\n\nNext: research_verify, then research_finalize.`,
			),
			details: { gapPass: next.gapPass, analysis, progress },
		};
	},
});

const researchVerifyTool = defineTool({
	name: "research_verify",
	label: "Research Verify",
	description:
		"Run coverage, citation, soft-placeholder, and unfetched must-fetch gates on the research ledger. Must PASS before finalize.",
	promptSnippet: "Verify research coverage, citations, and fetch backlog",
	promptGuidelines: [
		"Call research_verify before research_finalize.",
		"If FAIL on unfetched_discovered, web_fetch those URLs (or research_skip_discovered) then verify again.",
		"If FAIL on soft_observed, replace placeholders with concrete fetched values or not_found.",
		"If FAIL on missing coverage and gap pass not done, call research_gaps and run ONE recovery search pass.",
	],
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const bundle = loadBundle(ctx.cwd, params.runId);
		const report = verifyResearch(bundle);
		const analysis = analyzeGaps(bundle, report);
		let text = formatVerifyReport(report);
		if (!report.ok && analysis.shouldRunGapPass) {
			text += `\n\n---\nGap-fill available (one pass only):\n${formatGapAnalysis(analysis)}`;
		} else if (!report.ok && analysis.gapPassExhausted) {
			text +=
				"\n\n---\nGap pass already used. Mark remaining cells not_found if needed, then finalize with honest gaps in the user answer.";
		}
		return {
			...toolText(text),
			details: { ...report, gapAnalysis: analysis },
		};
	},
});

const researchFinalizeTool = defineTool({
	name: "research_finalize",
	label: "Research Finalize",
	description:
		"Write ledger-generated brief.md (summary+details from the same publishable cells), findings.csv, summary.json. Agent briefMarkdown is saved as agent-draft.md only — not the published answer.",
	promptSnippet: "Finalize from cell ledger; reply with brief.md",
	parameters: Type.Object({
		runId: Type.Optional(Type.String()),
		briefMarkdown: Type.Optional(
			Type.String({
				description:
					"Optional draft notes saved as agent-draft.md. Published brief.md is always generated from the cell ledger.",
			}),
		),
		force: Type.Optional(
			Type.Boolean({
				description: "Allow finalize even when verify fails (still writes FAIL/partial ledger brief)",
			}),
		),
	}),
	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const bundle = loadBundle(ctx.cwd, params.runId);
		const report = verifyResearch(bundle);
		const analysis = analyzeGaps(bundle, report);

		if (analysis.shouldRunGapPass && !params.force) {
			return {
				...toolText(
					`Finalize blocked — fillable gaps remain and the one gap-fill pass has not been completed.\n\n${formatGapAnalysis(analysis)}\n\nRun research_gaps → one targeted search/fetch/record → research_complete_gap_pass, or pass force=true to skip.`,
				),
				details: { blocked: true, reason: "gap_pass_pending", report, analysis },
				isError: true,
			};
		}

		const ratio = coverageRatio(report.stats.cellsCovered, report.stats.cells);
		if (!report.ok && params.force && ratio < MIN_FORCE_COVERAGE_RATIO) {
			return {
				...toolText(
					`Finalize blocked — coverage too sparse to force (${report.stats.cellsCovered}/${report.stats.cells} required cells = ${Math.round(ratio * 100)}%, need ≥${Math.round(MIN_FORCE_COVERAGE_RATIO * 100)}%).\n\n` +
						`Narrow the plan (fewer entities / requiredDimensions) or fill more cells (including fee/schedule pages for ücret fields).\n\n` +
						`${formatVerifyReport(report)}`,
				),
				details: { blocked: true, reason: "sparse_coverage", report, analysis, coverageRatio: ratio },
				isError: true,
			};
		}

		if (!report.ok && !params.force) {
			return {
				...toolText(
					`Finalize blocked — verify FAIL.\n\n${formatVerifyReport(report)}\n\nFix issues or pass force=true to write a partial package.`,
				),
				details: { blocked: true, report, analysis },
				isError: true,
			};
		}

		if (report.issues.some((i) => i.code === "cell_conflict") && !params.force) {
			return {
				...toolText(
					`Finalize blocked — cell conflicts remain (same entity×field has disagreeing values).\n\n${formatVerifyReport(report)}\n\nResolve conflicts in the ledger (one value, or status=conflict) before publishing.`,
				),
				details: { blocked: true, reason: "cell_conflict", report, analysis },
				isError: true,
			};
		}

		const ledger = buildCellLedger({
			plan: bundle.plan,
			findings: bundle.findings,
			asOf: bundle.plan.asOfDate,
			sources: bundle.sources,
		});

		if (params.briefMarkdown?.trim()) {
			const draftIssues = auditDraftAgainstLedger({
				draftMarkdown: params.briefMarkdown,
				ledger,
			});
			if (draftIssues.length > 0 && !params.force) {
				return {
					...toolText(
						`Finalize blocked — agent draft is not ledger-grounded (would bypass source of truth).\n\n` +
							draftIssues.map((i) => `- ${i}`).join("\n") +
							`\n\nDo not pass briefMarkdown. Reply to the user with brief.md produced from the ledger.`,
					),
					details: { blocked: true, reason: "draft_ungrounded", draftIssues, report },
					isError: true,
				};
			}
		}

		const paths: string[] = [];
		const csvPath = writeTableCsv(bundle.plan.dir, bundle.findings);
		paths.push(csvPath);

		const summaryPath = join(bundle.plan.dir, "summary.json");
		const summary = {
			plan: bundle.plan,
			verify: report,
			ledger: {
				asOf: ledger.asOf,
				publishable: ledger.publishable,
				conflicts: ledger.conflicts,
				expired: ledger.expired,
				missing: ledger.missing,
			},
			sources: bundle.sources,
			findings: bundle.findings,
			openQuestions: bundle.openQuestions,
			finalizedAt: new Date().toISOString(),
			partial: !report.ok,
		};
		writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
		paths.push(summaryPath);

		// Always publish from ledger — single source of truth for summary + details
		const entityDisplay = { byName: loadEntityDisplayNames(bundle.plan.dir) };
		const brief = buildPublishBrief({ plan: bundle.plan, ledger, report, entityDisplay });
		const briefPath = writeBrief(bundle.plan.dir, brief);
		paths.push(briefPath);

		const verifyPath = join(bundle.plan.dir, "verify-report.md");
		writeFileSync(verifyPath, `${formatVerifyReport(report)}\n`, "utf-8");
		paths.push(verifyPath);

		if (params.briefMarkdown?.trim()) {
			const draftPath = join(bundle.plan.dir, "agent-draft.md");
			writeFileSync(draftPath, `${params.briefMarkdown.trim()}\n`, "utf-8");
			paths.push(draftPath);
		}

		touchPlan(bundle.plan);

		const lines = [
			"=== USER-FACING BRIEF (copy this to the user; do not invent a second report) ===",
			brief,
			"=== END BRIEF ===",
			"",
			`Artifacts written for run ${bundle.plan.id}${report.ok ? "" : " (partial)"}`,
			...paths.map((p) => `- ${p}`),
			"",
			formatCellLedgerSummary(ledger),
			"",
			"Chat rule: paste the USER-FACING BRIEF above (or brief.md). No soft fees, no invented rankings, no verify dumps.",
			"",
			formatVerifyReport(report),
		];

		return {
			...toolText(lines.join("\n")),
			details: { runId: bundle.plan.id, paths, report, partial: !report.ok, ledgerStats: report.cellLedger },
		};
	},
});

export default function (pi: ExtensionAPI) {
	let state: ResearchModeState = { enabled: false };

	pi.registerTool(webSearchTool);
	pi.registerTool(webFetchTool);
	pi.registerTool(researchInitTool);
	pi.registerTool(researchRecordSourceTool);
	pi.registerTool(researchRecordFindingTool);
	pi.registerTool(researchSkipDiscoveredTool);
	pi.registerTool(researchSetOpenQuestionsTool);
	pi.registerTool(researchStatusTool);
	pi.registerTool(researchGapsTool);
	pi.registerTool(researchCompleteGapPassTool);
	pi.registerTool(researchAuditTool);
	pi.registerTool(researchVerifyTool);
	pi.registerTool(researchFinalizeTool);

	function updateStatus(ctx: ExtensionContext): void {
		if (state.enabled) {
			const label = state.activeRunId ? `research:${state.activeRunId}` : "research";
			ctx.ui.setStatus("research-mode", ctx.ui.theme.fg("accent", label));
		} else {
			ctx.ui.setStatus("research-mode", undefined);
		}
	}

	function enableResearchMode(ctx: ExtensionContext, runId?: string): void {
		state = { enabled: true, activeRunId: runId ?? state.activeRunId };
		pi.appendEntry("research-mode", state);
		updateStatus(ctx);
	}

	function disableResearchMode(ctx: ExtensionContext): void {
		state = { enabled: false, activeRunId: undefined };
		pi.appendEntry("research-mode", state);
		updateStatus(ctx);
	}

	pi.registerFlag("research", {
		description: "Start with research mode enabled (artifact-first web research)",
		type: "boolean",
		default: false,
	});

	pi.registerCommand("research-mode", {
		description: "Toggle artifact-first research mode",
		handler: async (_args, ctx) => {
			if (state.enabled) {
				disableResearchMode(ctx);
				ctx.ui.notify("Research mode disabled");
			} else {
				enableResearchMode(ctx);
				ctx.ui.notify("Research mode enabled — artifact-first workflow active");
			}
		},
	});

	function restoreState(ctx: ExtensionContext): void {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "custom" && entry.customType === "research-mode") {
				const data = entry.data as ResearchModeState | undefined;
				if (data) {
					state = { enabled: Boolean(data.enabled), activeRunId: data.activeRunId };
				}
				break;
			}
		}
		if (pi.getFlag("research") === true) {
			state = { ...state, enabled: true };
		}
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			getExaApiKey();
		} catch {
			ctx.ui.notify("Research: Exa API key missing (EXA_API_KEY or auth.json exa key)", "warning");
		}

		restoreState(ctx);
		if (state.enabled && pi.getFlag("research") === true) {
			ctx.ui.notify("Research mode enabled (--research)");
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "research_init" || event.isError) return;
		const details = event.details as { runId?: string } | undefined;
		if (!details?.runId) return;
		state = { enabled: true, activeRunId: details.runId };
		pi.appendEntry("research-mode", state);
	});

	pi.on("context", async (event) => {
		if (state.enabled) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "research-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[RESEARCH MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[RESEARCH MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (!state.enabled) return;
		const policies = listSourcePolicies()
			.map((p) => p.name)
			.join(", ");
		return {
			systemPrompt: `${event.systemPrompt}

# Research tools
You have artifact-first research tools: web_search, web_fetch, research_init, research_record_source, research_record_finding, research_skip_discovered, research_set_open_questions, research_status, research_gaps, research_complete_gap_pass, research_audit, research_verify, research_finalize.
Source policies: ${policies}.
Never answer research questions from snippets alone. Discovered must-fetch URLs must be web_fetch'd (or explicitly skipped) before soft/not_found conclusions.
After the first collect round, call research_gaps and run exactly one targeted recovery search for missing cells — then research_complete_gap_pass. Do not endless-deepen.
After finalize, reply with brief.md only (user-facing). Never paste verify-report.md, run ids, or unfetched URL lists into the chat answer.`,
			message: {
				customType: "research-mode-context",
				content: buildResearchModePrompt(state.activeRunId),
				display: false,
			},
		};
	});
}
