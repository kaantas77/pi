import type { FindingRecord, ResearchPlan } from "./artifacts.ts";
import type { CellLedger } from "./cells.ts";
import { labelsMatch, normalizeLabel } from "./normalize.ts";
import { isSoftPlaceholderValue } from "./soft.ts";
import type { EntityAliasMap } from "./verify.ts";

/**
 * Detect planned entities that appear in the user-facing brief but have zero ledger findings.
 * Blocks the "VERIFY FAIL but polished invented markdown" failure mode.
 */
export function findUngroundedEntityMentions(input: {
	briefMarkdown: string;
	plan: ResearchPlan;
	findings: FindingRecord[];
	entityAliases?: EntityAliasMap;
}): string[] {
	const briefNorm = normalizeLabel(input.briefMarkdown);
	const ungrounded: string[] = [];

	for (const entity of input.plan.entities) {
		const aliases = input.entityAliases?.byName.get(entity) ?? [];
		const hasFinding = input.findings.some((f) => labelsMatch(entity, f.entity, aliases));
		if (hasFinding) continue;
		if (briefMentionsEntity(briefNorm, entity, aliases)) {
			ungrounded.push(entity);
		}
	}
	return ungrounded;
}

function briefMentionsEntity(briefNorm: string, entity: string, aliases: string[]): boolean {
	for (const candidate of [entity, ...aliases]) {
		const norm = normalizeLabel(candidate);
		if (norm.length >= 6 && briefNorm.includes(norm)) return true;

		const tokens = norm.split(" ").filter((t) => t.length >= 4);
		if (tokens.length >= 2 && tokens.every((t) => briefNorm.includes(t))) return true;
	}
	return false;
}

export function formatUngroundedBriefBlock(entities: string[]): string {
	if (entities.length === 0) return "";
	return [
		"> **UNGROUNDED PROSE** — entities described below have no ledger findings:",
		...entities.map((e) => `> - ${e}`),
		">",
		"> Do not treat those sections as verified. Fetch/record findings or remove the claims.",
		"",
	].join("\n");
}

/**
 * Audit an agent-authored draft against the ledger before it can bypass brief.md.
 * Domain-agnostic: soft values, invented rankings, expired-as-active, value contradictions.
 */
export function auditDraftAgainstLedger(input: { draftMarkdown: string; ledger: CellLedger }): string[] {
	const draft = input.draftMarkdown;
	const issues: string[] = [];

	if (/kategori\s+baz[iı]nda\s+en|en\s+iyi\s+kart|best\s+card|🥇|recommendation\s+score/i.test(draft)) {
		issues.push(
			"Draft contains ranking/recommendation sections not produced from a scored ledger. Use brief.md only (no invented 'best of').",
		);
	}

	// Soft fee/placeholder language in draft
	const softHits = draft.match(/~\s*[\d.,]+\s*(?:TL|TRY|USD|EUR)|(?<!\w)Premium(?!\w)|Varl[ıi]k\s+bazl[ıi]/gi);
	if (softHits) {
		issues.push(
			`Draft contains soft/approximate claims (${softHits.slice(0, 3).join(", ")}). Soft values cannot ship.`,
		);
	}

	// Expired cells must not appear as "aktif" near their values
	for (const cell of input.ledger.expired) {
		const snippet = (cell.value ?? "").slice(0, 40);
		if (snippet.length < 12) continue;
		const idx = draft.indexOf(snippet);
		if (idx < 0) continue;
		const window = draft.slice(Math.max(0, idx - 80), idx + snippet.length + 80);
		if (/\baktif\b|\bactive\b|🔥/i.test(window) && !/süresi\s+dolmuş|expired|aktif\s+değil/i.test(window)) {
			issues.push(
				`Draft presents expired cell as active: ${cell.entity} × ${cell.field} (until ${cell.validTo ?? "?"}).`,
			);
		}
	}

	// Publishable lounge/access contradictions: draft says unlimited while ledger has a finite count
	for (const cell of input.ledger.publishable) {
		if (!/lounge|access|erişim|erisim/i.test(cell.field)) continue;
		const val = normalizeLabel(cell.value ?? "");
		const finite = /\b(\d+)\b/.test(val) && !/unlimited|sinirsiz|sınırsız/i.test(val);
		if (!finite) continue;
		const entityNorm = normalizeLabel(cell.entity);
		const draftNorm = normalizeLabel(draft);
		if (!draftNorm.includes(entityNorm.split(" ").slice(-1)[0] ?? entityNorm)) continue;
		if (/sinirsiz|sınırsız|unlimited/i.test(draft) && draftNorm.includes(entityNorm.split(" ")[0] ?? "")) {
			// Heuristic: same section likely claims unlimited while ledger is finite
			if (
				new RegExp(
					`${escapeReg(cell.entity.split(/\s+/).slice(-1)[0] ?? "")}[\\s\\S]{0,200}(s[ıi]n[ıi]rs[ıi]z|unlimited)`,
					"i",
				).test(draft)
			) {
				issues.push(
					`Draft claims unlimited access for ${cell.entity} but ledger publishable value is "${cell.value}".`,
				);
			}
		}
	}

	for (const line of draft.split("\n")) {
		const t = line.replace(/[*`|#]/g, " ").trim();
		if (t.length < 8 || t.length > 120) continue;
		if (isSoftPlaceholderValue(t)) {
			issues.push(`Draft line looks like a soft placeholder: "${t.slice(0, 80)}"`);
			break;
		}
	}

	return issues;
}

function escapeReg(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
