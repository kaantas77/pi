import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceType } from "./policy.ts";

export type DiscoveredStatus = "discovered" | "fetched" | "skipped";

export interface DiscoveredUrl {
	url: string;
	title?: string;
	query?: string;
	sourceType: SourceType;
	rankScore: number;
	/** Top results per search are must-fetch (or explicit skip) before verify PASS. */
	mustFetch: boolean;
	status: DiscoveredStatus;
	skipReason?: string;
	discoveredAt: string;
	fetchedAt?: string;
}

const FILE = "discovered.jsonl";

function nowIso(): string {
	return new Date().toISOString();
}

function readAll(runDir: string): DiscoveredUrl[] {
	const path = join(runDir, FILE);
	if (!existsSync(path)) return [];
	const rows: DiscoveredUrl[] = [];
	for (const line of readFileSync(path, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			rows.push(JSON.parse(trimmed) as DiscoveredUrl);
		} catch {
			// skip
		}
	}
	return rows;
}

function writeAll(runDir: string, rows: DiscoveredUrl[]): void {
	writeFileSync(
		join(runDir, FILE),
		rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""),
		"utf-8",
	);
}

export function loadDiscovered(runDir: string): DiscoveredUrl[] {
	return readAll(runDir);
}

export function recordDiscoveredUrls(
	runDir: string,
	input: {
		query: string;
		results: Array<{ url: string; title?: string; sourceType: SourceType; rankScore: number }>;
		mustFetchTopN?: number;
	},
): { added: number; mustFetch: number; total: number } {
	const topN = input.mustFetchTopN ?? 5;
	const rows = readAll(runDir);
	const byUrl = new Map(rows.map((r) => [r.url, r]));
	let added = 0;
	let mustFetch = 0;

	input.results.forEach((r, index) => {
		const url = r.url.trim();
		if (!url) return;
		const existing = byUrl.get(url);
		// Secondary/aggregator hits are discovery-only — never block verify as must-fetch.
		const eligible = r.sourceType !== "secondary";
		const shouldMust = eligible && index < topN;
		if (existing) {
			if (shouldMust && !existing.mustFetch) {
				existing.mustFetch = true;
				mustFetch++;
			}
			if (r.rankScore > existing.rankScore) existing.rankScore = r.rankScore;
			if (r.title && !existing.title) existing.title = r.title;
			if (r.sourceType === "primary") existing.sourceType = "primary";
			// If later classified secondary, demote mustFetch
			if (r.sourceType === "secondary") {
				existing.sourceType = "secondary";
				existing.mustFetch = false;
			}
			return;
		}

		const row: DiscoveredUrl = {
			url,
			title: r.title,
			query: input.query,
			sourceType: r.sourceType,
			rankScore: r.rankScore,
			mustFetch: shouldMust,
			status: "discovered",
			discoveredAt: nowIso(),
		};
		byUrl.set(url, row);
		added++;
		if (shouldMust) mustFetch++;
	});

	writeAll(runDir, Array.from(byUrl.values()));
	return { added, mustFetch, total: byUrl.size };
}

export function markDiscoveredFetched(runDir: string, urls: string[]): number {
	const rows = readAll(runDir);
	const want = new Set(urls.map((u) => u.trim()).filter(Boolean));
	if (want.size === 0) return 0;
	let n = 0;
	const fetchedAt = nowIso();
	for (const row of rows) {
		if (!want.has(row.url)) continue;
		if (row.status !== "fetched") n++;
		row.status = "fetched";
		row.fetchedAt = fetchedAt;
	}
	// Also add previously unknown URLs as fetched (direct fetch without prior search)
	for (const url of want) {
		if (rows.some((r) => r.url === url)) continue;
		rows.push({
			url,
			sourceType: "unknown",
			rankScore: 0,
			mustFetch: false,
			status: "fetched",
			discoveredAt: fetchedAt,
			fetchedAt,
		});
		n++;
	}
	writeAll(runDir, rows);
	return n;
}

export function skipDiscoveredUrl(runDir: string, url: string, reason: string): DiscoveredUrl {
	const rows = readAll(runDir);
	const existing = rows.find((r) => r.url === url);
	if (!existing) {
		const row: DiscoveredUrl = {
			url,
			sourceType: "unknown",
			rankScore: 0,
			mustFetch: true,
			status: "skipped",
			skipReason: reason.trim(),
			discoveredAt: nowIso(),
		};
		rows.push(row);
		writeAll(runDir, rows);
		return row;
	}
	existing.status = "skipped";
	existing.skipReason = reason.trim();
	writeAll(runDir, rows);
	return existing;
}

export function listUnfetchedMustFetch(runDir: string): DiscoveredUrl[] {
	return readAll(runDir)
		.filter((r) => r.mustFetch && r.status === "discovered")
		.sort((a, b) => b.rankScore - a.rankScore);
}

export function fetchedUrlSet(runDir: string): Set<string> {
	const set = new Set<string>();
	for (const row of readAll(runDir)) {
		if (row.status === "fetched") set.add(row.url);
	}
	return set;
}
