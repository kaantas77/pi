import type { ResearchPlan } from "./artifacts.ts";
import { type CellLedger, cellKey, type LedgerCell } from "./cells.ts";
import { displayFieldLabel, humanizeLabel } from "./display.ts";
import { matrixDimensions } from "./plan-scope.ts";
import { ensurePartialBriefBanner, type VerifyReport } from "./verify.ts";

export interface EntityDisplayMap {
	byName: Map<string, string>;
}

/**
 * User-facing comparison report from the cell ledger.
 * Shape: polished assistant report (summary table + grouped sections + sources).
 * Content: ONLY publishable / expired ledger cells — never invented rankings or soft placeholders.
 */
export function buildPublishBrief(input: {
	plan: ResearchPlan;
	ledger: CellLedger;
	report: VerifyReport;
	entityDisplay?: EntityDisplayMap;
}): string {
	const { plan, ledger, report } = input;
	const dims = matrixDimensions(plan);
	const tr = preferTurkish(plan.question);
	const displayOf = (entity: string) => input.entityDisplay?.byName.get(entity) ?? humanizeLabel(entity);
	const lines: string[] = [];

	lines.push(`# ${shortTitle(plan.question)}`);
	lines.push("");
	lines.push(
		tr ? `**Tarih:** ${formatDisplayDate(ledger.asOf, tr)}` : `**Date:** ${formatDisplayDate(ledger.asOf, tr)}`,
	);
	lines.push("");
	lines.push(introSentence(plan, ledger, tr));
	lines.push("");

	const gapNote = buildUserFacingGapNote(ledger, report, displayOf, tr);
	if (gapNote) {
		lines.push(gapNote);
		lines.push("");
	}

	const summaryDims = pickSummaryDims(dims);
	if (summaryDims.length > 0 && plan.entities.length > 0) {
		lines.push(tr ? "## Özet karşılaştırma" : "## Summary comparison");
		lines.push("");
		lines.push(buildSummaryTable(plan.entities, summaryDims, ledger, displayOf, tr));
		lines.push("");
	}

	const groups = groupEntitiesByPrefix(plan.entities);
	let section = 1;
	for (const group of groups) {
		lines.push(`## ${section}. ${group.title}`);
		lines.push("");
		let sub = 1;
		for (const entity of group.entities) {
			const label = displayOf(entity);
			const entityCells = dims
				.map((field) => ledger.byKey.get(cellKey(entity, field)))
				.filter((c): c is LedgerCell => Boolean(c));
			const pub = entityCells.filter((c) => c.publishable);
			const expired = entityCells.filter((c) => c.status === "expired");
			const conflicts = entityCells.filter((c) => c.status === "conflict");
			const missing = entityCells.filter((c) => c.status === "missing" || c.status === "not_found");

			lines.push(
				groups.length === 1 && group.entities.length === 1 ? `### ${label}` : `### ${section}.${sub} ${label}`,
			);
			lines.push("");
			sub++;

			if (pub.length === 0 && expired.length === 0) {
				lines.push(
					missing.length > 0
						? tr
							? `_Henüz yayınlanabilir bulgu yok. Eksik: ${missing.map((c) => displayFieldLabel(c.field)).join(", ")}._`
							: `_No publishable findings yet. Missing: ${missing.map((c) => displayFieldLabel(c.field)).join(", ")}._`
						: tr
							? "_Henüz yayınlanabilir bulgu yok._"
							: "_No publishable findings yet._",
				);
				if (conflicts.length > 0) {
					lines.push("");
					lines.push(formatConflicts(conflicts, tr));
				}
				lines.push("");
				continue;
			}

			for (const c of pub) {
				const cite = c.sourceUrl ? ` ([${tr ? "kaynak" : "source"}](${c.sourceUrl}))` : "";
				lines.push(`- **${displayFieldLabel(c.field)}:** ${escapeCell(c.value ?? "")}${cite}`);
			}

			if (expired.length > 0) {
				lines.push("");
				lines.push(tr ? "**Süresi dolmuş (aktif değil):**" : "**Expired (not active):**");
				for (const c of expired) {
					lines.push(
						`- **${displayFieldLabel(c.field)}:** ${escapeCell(c.value ?? "")} _(${tr ? "bitiş" : "until"}: ${c.validTo ?? "?"})_`,
					);
				}
			}
			if (conflicts.length > 0) {
				lines.push("");
				lines.push(formatConflicts(conflicts, tr));
			}
			if (missing.length > 0) {
				lines.push("");
				lines.push(
					tr
						? `Doğrulanamadı: ${missing.map((c) => displayFieldLabel(c.field)).join(", ")}.`
						: `Unverified: ${missing.map((c) => displayFieldLabel(c.field)).join(", ")}.`,
				);
			}
			lines.push("");
		}
		section++;
	}

	const sources = collectSources(ledger);
	if (sources.length > 0) {
		lines.push(tr ? "## Kaynaklar" : "## Sources");
		lines.push("");
		for (const url of sources) {
			lines.push(`- ${url}`);
		}
		lines.push("");
	}

	lines.push(tr ? "## Not" : "## Note");
	lines.push("");
	lines.push(
		tr
			? "Yukarıdaki rakam ve iddialar yalnızca fetch edilmiş kaynaklardan kayda geçen publishable hücrelerdir. Çelişkili veya süresi dolmuş değerler aktif iddia olarak yazılmaz. Soft/yaklaşık ifadeler (ör. “Premium”, “~3.000 TL”) yayınlanmaz."
			: "Claims above are only publishable ledger cells backed by fetched sources. Conflicting or expired values are not published as active. Soft/approximate phrasing is never published.",
	);
	lines.push("");

	return ensurePartialBriefBanner(lines.join("\n").trimEnd(), report);
}

/** Group entities by shared leading tokens (domain-agnostic family grouping). */
export function groupEntitiesByPrefix(entities: string[]): Array<{ title: string; entities: string[] }> {
	const tokenized = entities.map((e) => ({ e, tokens: e.trim().split(/\s+/).filter(Boolean) }));
	const used = new Set<string>();
	const groups: Array<{ title: string; entities: string[] }> = [];

	for (const len of [3, 2, 1]) {
		const counts = new Map<string, string[]>();
		for (const { e, tokens } of tokenized) {
			if (used.has(e) || tokens.length < len) continue;
			const key = tokens.slice(0, len).join(" ");
			const list = counts.get(key) ?? [];
			list.push(e);
			counts.set(key, list);
		}
		const ranked = [...counts.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
		for (const [title, list] of ranked) {
			const available = list.filter((e) => !used.has(e));
			if (available.length < 2) continue;
			for (const e of available) used.add(e);
			groups.push({ title, entities: available });
		}
	}

	for (const e of entities) {
		if (!used.has(e)) groups.push({ title: e, entities: [e] });
	}
	return groups;
}

export function preferTurkish(question: string): boolean {
	if (/[ğüşıöçĞÜŞİÖÇ]/.test(question)) return true;
	return /\b(ve|ile|için|nedir|karşılaştır|kampanya|ücret|banka)\b/i.test(question);
}

function shortTitle(question: string): string {
	const q = question.trim();
	if (q.length <= 90) return q.replace(/\?+$/, "");
	return `${q.slice(0, 87).trim()}…`;
}

function formatDisplayDate(iso: string, tr: boolean): string {
	const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return iso;
	if (!tr) return iso;
	const months = [
		"Ocak",
		"Şubat",
		"Mart",
		"Nisan",
		"Mayıs",
		"Haziran",
		"Temmuz",
		"Ağustos",
		"Eylül",
		"Ekim",
		"Kasım",
		"Aralık",
	];
	const month = months[Number(m[2]) - 1] ?? m[2];
	return `${Number(m[3])} ${month} ${m[1]}`;
}

function introSentence(plan: ResearchPlan, ledger: CellLedger, tr: boolean): string {
	const n = ledger.publishable.length;
	const total = ledger.cells.length;
	if (n === 0) {
		return tr
			? "Bu turda yayınlanabilir (kaynaklı) bulgu üretilemedi; eksikler aşağıda işaretlendi."
			: "No publishable (sourced) findings in this run; gaps are marked below.";
	}
	if (n < total) {
		return tr
			? `${plan.entities.length} varlık için ${n}/${total} zorunlu hücre kaynaklı doğrulandı. Eksik veya çelişkili satırlar ayrıca belirtilir.`
			: `${plan.entities.length} entities: ${n}/${total} required cells verified from sources. Gaps and conflicts are called out.`;
	}
	return tr
		? `${plan.entities.length} varlık için zorunlu hücreler kaynaklı olarak dolduruldu.`
		: `${plan.entities.length} entities: required cells filled from sources.`;
}

function formatConflicts(conflicts: LedgerCell[], tr: boolean): string {
	const lines = [tr ? "Çelişkili kayıtlar (yayınlanmadı):" : "Conflicting records (not published):"];
	for (const c of conflicts) {
		lines.push(`- **${displayFieldLabel(c.field)}:** ${c.values.map(escapeCell).join(" ≠ ")}`);
	}
	return lines.join("\n");
}

function pickSummaryDims(dims: string[]): string[] {
	const preferred = [
		/ücret|ucret|fee|price|cost|pricing/i,
		/kampanya|campaign|promo|offer/i,
		/avantaj|benefit|lounge/i,
	];
	const picked: string[] = [];
	for (const re of preferred) {
		const hit = dims.find((d) => re.test(d) && !picked.includes(d));
		if (hit) picked.push(hit);
	}
	for (const d of dims) {
		if (picked.length >= 5) break;
		if (!picked.includes(d)) picked.push(d);
	}
	return picked.slice(0, 5);
}

export function buildUserFacingGapNote(
	ledger: CellLedger,
	report: VerifyReport,
	displayOf: (entity: string) => string = humanizeLabel,
	tr = true,
): string {
	if (report.ok && ledger.conflicts.length === 0 && ledger.missing.length === 0 && ledger.expired.length === 0) {
		return "";
	}
	const bits: string[] = [];
	if (!report.ok) bits.push(tr ? "doğrulama tam geçmedi — paket kısmi" : "verify did not pass — partial package");
	if (ledger.missing.length > 0) {
		bits.push(tr ? `${ledger.missing.length} hücre doğrulanamadı` : `${ledger.missing.length} cells unverified`);
	}
	if (ledger.conflicts.length > 0) {
		const sample = ledger.conflicts
			.slice(0, 4)
			.map((c) => `${displayOf(c.entity)} / ${displayFieldLabel(c.field)}`)
			.join("; ");
		bits.push(
			tr
				? `çelişkili kayıtlar yayınlanmadı (${sample}${ledger.conflicts.length > 4 ? "…" : ""})`
				: `conflicts not published (${sample}${ledger.conflicts.length > 4 ? "…" : ""})`,
		);
	}
	if (ledger.expired.length > 0) {
		bits.push(
			tr
				? `${ledger.expired.length} süresi dolmuş alan aktif sayılmadı`
				: `${ledger.expired.length} expired fields not treated as active`,
		);
	}
	if (bits.length === 0) return "";
	return tr ? `> **Eksik / dikkat:** ${bits.join("; ")}.` : `> **Gaps:** ${bits.join("; ")}.`;
}

function buildSummaryTable(
	entities: string[],
	dims: string[],
	ledger: CellLedger,
	displayOf: (entity: string) => string,
	tr: boolean,
): string {
	const header = [tr ? "Varlık" : "Entity", ...dims.map(displayFieldLabel)];
	const sep = header.map(() => "---");
	const rows: string[] = [`| ${header.join(" | ")} |`, `| ${sep.join(" | ")} |`];
	for (const entity of entities) {
		const cols = [escapeCell(displayOf(entity))];
		for (const field of dims) {
			cols.push(formatSummaryCell(ledger.byKey.get(cellKey(entity, field)), tr));
		}
		rows.push(`| ${cols.join(" | ")} |`);
	}
	return rows.join("\n");
}

function formatSummaryCell(cell: LedgerCell | undefined, tr: boolean): string {
	if (!cell) return "—";
	if (cell.status === "conflict") return tr ? "çelişki" : "conflict";
	if (cell.status === "expired") return tr ? "süresi dolmuş" : "expired";
	if (cell.status === "missing") return "—";
	if (cell.status === "not_found") return tr ? "bulunamadı" : "not found";
	if (!cell.publishable) return "—";
	return escapeCell(truncate(cell.value ?? "", 72));
}

function collectSources(ledger: CellLedger): string[] {
	const urls: string[] = [];
	const seen = new Set<string>();
	for (const c of [...ledger.publishable, ...ledger.expired]) {
		const u = c.sourceUrl?.trim();
		if (!u || seen.has(u)) continue;
		seen.add(u);
		urls.push(u);
	}
	return urls;
}

function escapeCell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function truncate(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}
