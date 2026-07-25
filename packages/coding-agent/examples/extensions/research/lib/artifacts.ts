import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inferValidToFromValue } from "./dates.ts";
import { type DiscoveredUrl, loadDiscovered } from "./discovered.ts";
import { humanizeLabel } from "./display.ts";
import {
	isPageAbsenceNotFound,
	isPlanOversized,
	isScheduleLikeField,
	isTimeBoundOfferField,
	pickDefaultRequiredDimensions,
	promoteQuestionDimensions,
	resolveAsOfDate,
	urlLooksLikeSchedule,
} from "./plan-scope.ts";
import type { SourcePolicyName, SourceType } from "./policy.ts";
import { softPlaceholderReason } from "./soft.ts";

export type FindingStatus = "observed" | "inferred" | "conflict" | "not_found";
export type FindingConfidence = "high" | "medium" | "low";
export type ResearchOutputFormat = "brief" | "table" | "json";

export type GapPassStatus = "not_started" | "in_progress" | "done";

export interface GapPassState {
	status: GapPassStatus;
	startedAt?: string;
	completedAt?: string;
	queries: string[];
}

export interface ResearchPlan {
	id: string;
	question: string;
	policy: SourcePolicyName;
	entities: string[];
	dimensions: string[];
	/** Matrix gate dimensions. Defaults to dimensions when omitted. Keep this small. */
	requiredDimensions: string[];
	/** Record if found; never blocks verify. */
	optionalDimensions: string[];
	queries: string[];
	outputFormat: ResearchOutputFormat;
	/** At most one recovery search pass for missing coverage / not_found cells */
	gapPass: GapPassState;
	/** True when entities × requiredDimensions exceeds the soft cap */
	oversized?: boolean;
	/** Optional research "as of" date (YYYY-MM-DD) for freshness checks */
	asOfDate?: string;
	createdAt: string;
	updatedAt: string;
	dir: string;
}

export interface SourceRecord {
	id: string;
	url: string;
	title?: string;
	type: SourceType;
	fetchedAt?: string;
	notes?: string;
}

export interface FindingRecord {
	id: string;
	entity: string;
	field: string;
	value: string;
	evidence: string;
	sourceUrl: string;
	confidence: FindingConfidence;
	status: FindingStatus;
	/** Inclusive start date YYYY-MM-DD when claim is time-bounded */
	validFrom?: string;
	/** Inclusive end date YYYY-MM-DD; past asOf → expired, not publishable as active */
	validTo?: string;
	recordedAt: string;
}

export interface ResearchBundle {
	plan: ResearchPlan;
	sources: SourceRecord[];
	findings: FindingRecord[];
	openQuestions: string[];
	discovered: DiscoveredUrl[];
}

const ROOT_DIRNAME = ".pi-research";

function slugify(input: string): string {
	const base = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return base || "research";
}

function nowIso(): string {
	return new Date().toISOString();
}

function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readJsonl<T>(filePath: string): T[] {
	if (!existsSync(filePath)) return [];
	const text = readFileSync(filePath, "utf-8");
	const rows: T[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed) as T);
		} catch {
			// skip corrupt lines
		}
	}
	return rows;
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function appendJsonl(filePath: string, value: unknown): void {
	appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

export function researchRoot(cwd: string): string {
	return join(cwd, ROOT_DIRNAME);
}

export function listResearchRuns(cwd: string): string[] {
	const root = researchRoot(cwd);
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
}

export function resolveRunDir(cwd: string, runId?: string): string {
	const root = researchRoot(cwd);
	if (runId) {
		const direct = join(root, runId);
		if (existsSync(join(direct, "plan.json"))) return direct;
		throw new Error(`Research run not found: ${runId}`);
	}

	const runs = listResearchRuns(cwd);
	if (runs.length === 0) {
		throw new Error(`No research run found under ${ROOT_DIRNAME}/. Call research_init first.`);
	}

	let best: { dir: string; updatedAt: string } | undefined;
	for (const name of runs) {
		const planPath = join(root, name, "plan.json");
		if (!existsSync(planPath)) continue;
		try {
			const plan = JSON.parse(readFileSync(planPath, "utf-8")) as ResearchPlan;
			if (!best || plan.updatedAt > best.updatedAt) {
				best = { dir: join(root, name), updatedAt: plan.updatedAt };
			}
		} catch {
			// ignore
		}
	}
	if (!best) throw new Error(`No valid research plan under ${ROOT_DIRNAME}/`);
	return best.dir;
}

/** Returns latest run dir if one exists, otherwise undefined. */
export function tryResolveRunDir(cwd: string, runId?: string): string | undefined {
	try {
		return resolveRunDir(cwd, runId);
	} catch {
		return undefined;
	}
}

export function createResearchRun(
	cwd: string,
	input: {
		question: string;
		policy: SourcePolicyName;
		entities: string[];
		dimensions: string[];
		requiredDimensions?: string[];
		optionalDimensions?: string[];
		queries?: string[];
		outputFormat?: ResearchOutputFormat;
		asOfDate?: string;
		runId?: string;
	},
): ResearchPlan {
	const root = researchRoot(cwd);
	mkdirSync(root, { recursive: true });

	const id = input.runId?.trim() || `${slugify(input.question)}-${Date.now().toString(36)}`;
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });

	const dimensions = normalizeList(input.dimensions);
	const optionalDimensions = normalizeList(input.optionalDimensions ?? []);
	let requiredDimensions = normalizeList(
		input.requiredDimensions?.length ? input.requiredDimensions : pickDefaultRequiredDimensions(dimensions),
	);
	requiredDimensions = promoteQuestionDimensions(input.question.trim(), requiredDimensions, [
		...dimensions,
		...optionalDimensions,
		...requiredDimensions,
	]);
	// Ensure required ⊆ dimensions ∪ required (allow required-only fields)
	const allDims = normalizeList([...dimensions, ...requiredDimensions, ...optionalDimensions]);

	const createdAt = nowIso();
	const asOfDate = resolveAsOfDate(input.asOfDate);
	const plan: ResearchPlan = {
		id,
		question: input.question.trim(),
		policy: input.policy,
		entities: normalizeList(input.entities),
		dimensions: allDims,
		requiredDimensions,
		optionalDimensions: optionalDimensions.filter((d) => !requiredDimensions.includes(d)),
		queries: normalizeList(input.queries ?? []),
		outputFormat: input.outputFormat ?? "brief",
		gapPass: { status: "not_started", queries: [] },
		asOfDate,
		createdAt,
		updatedAt: createdAt,
		dir,
	};
	plan.oversized = isPlanOversized(plan);

	writeJson(join(dir, "plan.json"), plan);
	writeFileSync(join(dir, "sources.jsonl"), "", "utf-8");
	writeFileSync(join(dir, "findings.jsonl"), "", "utf-8");
	writeFileSync(join(dir, "discovered.jsonl"), "", "utf-8");
	writeJson(join(dir, "open_questions.json"), []);
	writeJson(join(dir, "entities.json"), {
		entities: plan.entities.map((name) => ({
			name,
			displayName: humanizeLabel(name),
			aliases: [] as string[],
		})),
	});

	return plan;
}

function normalizeList(items: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of items) {
		const v = item.trim();
		if (!v) continue;
		const key = v.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(v);
	}
	return out;
}

export function loadPlan(runDir: string): ResearchPlan {
	const plan = JSON.parse(readFileSync(join(runDir, "plan.json"), "utf-8")) as ResearchPlan;
	plan.dir = runDir;
	if (!plan.gapPass || typeof plan.gapPass !== "object") {
		plan.gapPass = { status: "not_started", queries: [] };
	} else if (!Array.isArray(plan.gapPass.queries)) {
		plan.gapPass.queries = [];
	}
	if (!Array.isArray(plan.requiredDimensions) || plan.requiredDimensions.length === 0) {
		plan.requiredDimensions = pickDefaultRequiredDimensions(plan.dimensions ?? []);
	}
	if (!Array.isArray(plan.optionalDimensions)) {
		plan.optionalDimensions = [];
	}
	if (!plan.asOfDate) {
		plan.asOfDate = resolveAsOfDate();
	} else {
		plan.asOfDate = resolveAsOfDate(plan.asOfDate);
	}
	plan.oversized = isPlanOversized(plan);
	return plan;
}

export function touchPlan(plan: ResearchPlan, patch: Partial<ResearchPlan> = {}): ResearchPlan {
	const next: ResearchPlan = {
		...plan,
		...patch,
		updatedAt: nowIso(),
		dir: plan.dir,
	};
	writeJson(join(plan.dir, "plan.json"), next);
	return next;
}

export function loadSources(runDir: string): SourceRecord[] {
	return readJsonl<SourceRecord>(join(runDir, "sources.jsonl"));
}

export function loadFindings(runDir: string): FindingRecord[] {
	return readJsonl<FindingRecord>(join(runDir, "findings.jsonl"));
}

export function loadOpenQuestions(runDir: string): string[] {
	const path = join(runDir, "open_questions.json");
	if (!existsSync(path)) return [];
	const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
	if (!Array.isArray(raw)) return [];
	return raw.map((x) => String(x));
}

export function setOpenQuestions(runDir: string, questions: string[]): string[] {
	const normalized = normalizeList(questions);
	writeJson(join(runDir, "open_questions.json"), normalized);
	return normalized;
}

export function recordSource(
	runDir: string,
	input: {
		url: string;
		title?: string;
		type: SourceType;
		fetchedAt?: string;
		notes?: string;
	},
): SourceRecord {
	const sources = loadSources(runDir);
	const existing = sources.find((s) => s.url === input.url);
	if (existing) {
		const updated: SourceRecord = {
			...existing,
			title: input.title ?? existing.title,
			type: input.type,
			fetchedAt: input.fetchedAt ?? existing.fetchedAt,
			notes: input.notes ?? existing.notes,
		};
		const next = sources.map((s) => (s.id === existing.id ? updated : s));
		writeFileSync(
			join(runDir, "sources.jsonl"),
			next.map((s) => JSON.stringify(s)).join("\n") + (next.length ? "\n" : ""),
			"utf-8",
		);
		return updated;
	}

	const record: SourceRecord = {
		id: newId("src"),
		url: input.url,
		title: input.title,
		type: input.type,
		fetchedAt: input.fetchedAt,
		notes: input.notes,
	};
	appendJsonl(join(runDir, "sources.jsonl"), record);
	return record;
}

export function recordFinding(
	runDir: string,
	input: {
		entity: string;
		field: string;
		value: string;
		evidence: string;
		sourceUrl: string;
		confidence: FindingConfidence;
		status: FindingStatus;
		validFrom?: string;
		validTo?: string;
		/** When set, observed findings must cite a URL that was web_fetch'd. */
		fetchedUrls?: Set<string>;
	},
): FindingRecord {
	if (!input.sourceUrl.trim() && input.status !== "not_found") {
		throw new Error("sourceUrl is required for findings that are not status=not_found");
	}
	if (input.status === "observed" && !input.evidence.trim()) {
		throw new Error("evidence is required for status=observed findings");
	}

	if (input.status === "observed") {
		const soft = softPlaceholderReason(input.value);
		if (soft) {
			throw new Error(
				`${soft}. Use status=not_found (or fetch the concrete page and record a concrete value). Soft placeholders cannot be observed.`,
			);
		}
		if (input.fetchedUrls && input.sourceUrl.trim() && !input.fetchedUrls.has(input.sourceUrl.trim())) {
			throw new Error(
				`sourceUrl was discovered/cited but not web_fetch'd yet: ${input.sourceUrl}. Fetch it before recording status=observed.`,
			);
		}
		if (isTimeBoundOfferField(input.field) && input.status === "observed") {
			const inferredEnd = inferValidToFromValue(input.value);
			if (!input.validTo?.trim() && inferredEnd) {
				input = { ...input, validTo: inferredEnd };
			}
			if (!input.validTo?.trim()) {
				throw new Error(
					`Time-bound offer field "${input.field}" requires validTo (YYYY-MM-DD end date), or an end marker in the value (e.g. "Son: 30 Haziran 2026", "until 2026-06-30"). ` +
						`Ongoing benefits (lounge, earn rates, standing perks) should use a separate dimension without forcing an end date. ` +
						`Expired offers must not publish as active.`,
				);
			}
		}
		// Fee/schedule fields: non-primary URLs may be recorded; evidence ranking + verify quality notes
		// decide publishability. Soft/unfetched gates above still apply.
	}

	if (input.status === "not_found" && isScheduleLikeField(input.field) && isPageAbsenceNotFound(input.value)) {
		const fetched = [...(input.fetchedUrls ?? [])];
		const triedSchedule = fetched.some((u) => urlLooksLikeSchedule(u)) || urlLooksLikeSchedule(input.sourceUrl);
		if (!triedSchedule) {
			throw new Error(
				`Cannot mark "${input.field}" as not_found just because a marketing/product page omits it. ` +
					`Search and web_fetch a fee/pricing/schedule URL first (path often contains ücret/fee/faiz/pricing), then record a concrete value or a real not_found.`,
			);
		}
	}

	const record: FindingRecord = {
		id: newId("fnd"),
		entity: input.entity.trim(),
		field: input.field.trim(),
		value: input.value.trim(),
		evidence: input.evidence.trim(),
		sourceUrl: input.sourceUrl.trim(),
		confidence: input.confidence,
		status: input.status,
		validFrom: input.validFrom?.trim() || undefined,
		validTo: input.validTo?.trim() || undefined,
		recordedAt: nowIso(),
	};
	appendJsonl(join(runDir, "findings.jsonl"), record);
	return record;
}

export function loadBundle(cwd: string, runId?: string): ResearchBundle {
	const dir = resolveRunDir(cwd, runId);
	return {
		plan: loadPlan(dir),
		sources: loadSources(dir),
		findings: loadFindings(dir),
		openQuestions: loadOpenQuestions(dir),
		discovered: loadDiscovered(dir),
	};
}

export function writeBrief(runDir: string, markdown: string): string {
	const path = join(runDir, "brief.md");
	writeFileSync(path, markdown.endsWith("\n") ? markdown : `${markdown}\n`, "utf-8");
	return path;
}

export function writeTableCsv(runDir: string, findings: FindingRecord[]): string {
	const path = join(runDir, "findings.csv");
	const header = ["entity", "field", "value", "status", "confidence", "sourceUrl", "evidence"];
	const csvEscape = (v: string) => `"${v.replaceAll('"', '""')}"`;
	const lines = [
		header.join(","),
		...findings.map((f) =>
			[f.entity, f.field, f.value, f.status, f.confidence, f.sourceUrl, f.evidence].map(csvEscape).join(","),
		),
	];
	writeFileSync(path, `${lines.join("\n")}\n`, "utf-8");
	return path;
}
