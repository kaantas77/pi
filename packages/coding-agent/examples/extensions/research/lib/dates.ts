/**
 * Date parsing for research freshness (domain-agnostic).
 * Distinguishes as-of/start dates from offer end dates.
 */

export function parseIsoDate(raw?: string): string | undefined {
	if (!raw?.trim()) return undefined;
	const t = raw.trim().slice(0, 10);
	if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
	return undefined;
}

const TR_MONTH = "Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık";

const END_MARKER_PREFIX =
	"son\\s*:|biti[sş]|until|through|ends?(?:\\s+on)?|deadline|expiry|expires?(?:\\s+on)?|valid\\s+(?:until|through|to)|tarihine\\s+kadar|son\\s*tarih|geçerlilik\\s+sonu|last\\s+day";

/**
 * Extract end date from offer prose.
 * - "20 Haziran - 19 Temmuz 2026" → 2026-07-19
 * - "Son: 30 Haziran 2026" / "until 2026-06-30" → end date
 * - "1 Ocak 2026 itibarıyla" / "as of …" → undefined (start/as-of, not end)
 */
export function inferValidToFromValue(value: string): string | undefined {
	const v = value.trim();
	if (!v) return undefined;

	const asOfPhrase =
		/\b(?:itibari(?:y[lı]la|yle)?|as\s+of|effective(?:\s+from)?|starting|geçerlilik\s+tarihi|son\s+güncelleme|güncellenme)\b/i;
	const hasRange =
		/\d{1,2}\s*\w+\s*[-–—]\s*\d{1,2}|\buntil\b|\bthrough\b|\bbiti[sş]\b|\bsontarih\b|\btarihine\s+kadar\b/i.test(v);
	const hasEndMarker = new RegExp(`(?:${END_MARKER_PREFIX})`, "i").test(v);

	// As-of/start phrases win over a lone date (unless there is an explicit range)
	if (asOfPhrase.test(v) && !hasRange) return undefined;

	const afterEnd = v.match(
		new RegExp(`(?:${END_MARKER_PREFIX})\\s*:?\\s*(\\d{1,2})\\s*(${TR_MONTH})\\s*(20\\d{2})`, "i"),
	);
	if (afterEnd) {
		const mon = monthNum(afterEnd[2]);
		if (mon) return `${afterEnd[3]}-${mon}-${afterEnd[1].padStart(2, "0")}`;
	}
	const afterEndIso = v.match(new RegExp(`(?:${END_MARKER_PREFIX})\\s*:?\\s*(20\\d{2}-\\d{2}-\\d{2})`, "i"));
	if (afterEndIso) return afterEndIso[1];

	const range = v.match(
		new RegExp(`(\\d{1,2})\\s*(${TR_MONTH})\\s*[-–—]\\s*(\\d{1,2})\\s*(${TR_MONTH})\\s*(20\\d{2})`, "i"),
	);
	if (range) {
		const mon = monthNum(range[4]);
		if (mon) return `${range[5]}-${mon}-${range[3].padStart(2, "0")}`;
	}

	const explicit = v.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/g);
	if (explicit && explicit.length > 0) return explicit[explicit.length - 1];

	const tr = v.match(new RegExp(`(\\d{1,2})\\s*(${TR_MONTH})\\s*(20\\d{2})`, "gi"));
	if (!tr || tr.length === 0) return undefined;
	// Single date without range/end marker → as-of, not end
	if (tr.length === 1 && !hasRange && !hasEndMarker) return undefined;
	const last = tr[tr.length - 1];
	const m = last.match(new RegExp(`(\\d{1,2})\\s*(${TR_MONTH})\\s*(20\\d{2})`, "i"));
	if (!m) return undefined;
	const mon = monthNum(m[2]);
	if (!mon) return undefined;
	return `${m[3]}-${mon}-${m[1].padStart(2, "0")}`;
}

function monthNum(raw: string): string | undefined {
	const months: Record<string, string> = {
		ocak: "01",
		şubat: "02",
		subat: "02",
		mart: "03",
		nisan: "04",
		mayıs: "05",
		mayis: "05",
		haziran: "06",
		temmuz: "07",
		ağustos: "08",
		agustos: "08",
		eylül: "09",
		eylul: "09",
		ekim: "10",
		kasım: "11",
		kasim: "11",
		aralık: "12",
		aralik: "12",
	};
	return months[raw.toLowerCase()];
}
