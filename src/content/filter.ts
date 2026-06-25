import { eq } from "drizzle-orm";
import { db, sqlite } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { getSetting } from "../settings.ts";
import { isAdult } from "./adult.ts";

/**
 * Auto-hide reconciliation. Brings every channel's hidden state in line with the
 * admin's content settings — adult-content hiding and whole-category hiding — in a
 * SINGLE pass so the two can't fight each other.
 *
 * It only ever touches channels it auto-hid before (hiddenReason 'adult' or
 * 'cat:<name>') or that are currently visible. Channels hidden by the user or a
 * rule (any other hiddenReason) are left alone. Fully reversible: drop a category
 * from the list or turn off adult-hiding and the matching channels reappear.
 */

const isAutoReason = (r: string | null): boolean => r === "adult" || r === "dup" || (typeof r === "string" && r.startsWith("cat:"));

type LocalRow = { id: number; name: string; category: string | null };
// A US broadcast callsign (KxxX / WxxX) uniquely identifies a station, so two
// local channels with the same one are the same station listed twice.
function localCallsign(name: string | null): string | null {
  const m = (name ?? "").match(/\b([KW][A-Z]{2,3})\b/);
  return m ? m[1] : null;
}
// Prefer the per-network copy ("USA Local - NBC") over the "Full List"/MISC one.
const localCatRank = (c: string | null): number => (/USA Local - (NBC|ABC|CBS|FOX)/i.test(c ?? "") ? 0 : /MISC/i.test(c ?? "") ? 1 : 2);

/** Duplicate local stations to hide (every copy but the best-named per callsign). */
function computeLocalDuplicates(rows: LocalRow[]): Set<number> {
  const byCall = new Map<string, LocalRow[]>();
  for (const ch of rows) {
    if (categoryGroup(ch.category) !== "Local") continue;
    const cs = localCallsign(ch.name);
    if (!cs) continue;
    if (!byCall.has(cs)) byCall.set(cs, []);
    byCall.get(cs)!.push(ch);
  }
  const dup = new Set<number>();
  for (const g of byCall.values()) {
    if (g.length < 2) continue;
    g.sort((a, b) => localCatRank(a.category) - localCatRank(b.category) || a.id - b.id);
    for (let i = 1; i < g.length; i++) dup.add(g[i].id); // keep g[0]
  }
  return dup;
}

export async function reconcileAutoHides(): Promise<number> {
  const hideAdult = await getSetting("content.hideAdult");
  const hiddenCats = new Set((await getSetting("content.hiddenCategories")) ?? []);
  const dedupe = await getSetting("content.dedupeLocals");
  const rows = await db.select().from(channels);
  const dupIds = dedupe ? computeLocalDuplicates(rows) : new Set<number>();

  let changed = 0;
  for (const ch of rows) {
    const adult = hideAdult && isAdult(ch.category, ch.name);
    const catHidden = ch.category != null && hiddenCats.has(ch.category);
    const isDup = dupIds.has(ch.id);
    const reason = adult ? "adult" : catHidden ? `cat:${ch.category}` : isDup ? "dup" : null;
    const auto = isAutoReason(ch.hiddenReason);

    if (reason) {
      if (!ch.isHidden) {
        await db.update(channels).set({ isHidden: true, hiddenReason: reason }).where(eq(channels.id, ch.id));
        changed++;
      } else if (auto && ch.hiddenReason !== reason) {
        // e.g. a channel that was category-hidden now also matches adult — keep the reason accurate.
        await db.update(channels).set({ hiddenReason: reason }).where(eq(channels.id, ch.id));
        changed++;
      }
      // already hidden by the user/a rule → leave it.
    } else if (auto) {
      // We hid it, but it no longer should be → restore it.
      await db.update(channels).set({ isHidden: false, hiddenReason: null }).where(eq(channels.id, ch.id));
      changed++;
    }
  }
  return changed;
}

/**
 * Roll a raw provider category up into a high-level group so 100+ categories
 * collapse into a handful of manageable buckets (Sports, News, 24/7, …). Keyword
 * heuristic, ordered most-specific-first; anything unmatched lands in "Other".
 */
export function categoryGroup(category: string | null | undefined): string {
  const c = (category ?? "").toLowerCase();
  if (isAdult(category, null)) return "Adult";
  if (/24\s*[/-]?\s*7/.test(c)) return "24/7 & VOD";
  if (/\b(ppv|pay.?per.?view|event)/.test(c)) return "PPV & Events";
  if (/sport|espn|\bnfl\b|\bnba\b|\bwnba\b|\bmlb\b|\bmilb\b|\bnhl\b|\bufc\b|\bf1\b|\bmma\b|\bepl\b|ncaa|soccer|football|fight|wwe|tennis|golf|racing|nascar|motogp|cricket|rugby|boxing|premier\s*league|la\s*liga|bundesliga|serie\s*a|world\s*cup|olympic|big\s*10|big\s*ten|\bsec\b|\bacc\b/.test(c)) return "Sports";
  if (/\bnews\b|cnbc|bloomberg|weather/.test(c)) return "News & Weather";
  if (/movie|cinema|\bfilm|\bvod\b/.test(c)) return "Movies";
  if (/kids|cartoon|children|disney|\bnick\b|junior|baby/.test(c)) return "Kids";
  if (/music|\bmtv\b|concert|radio/.test(c)) return "Music & Radio";
  if (/document|history|discovery|nat\s*geo|geographic|science|\banimal/.test(c)) return "Documentary";
  if (/religio|church|islam|christ|gospel|cathol|quran|bible|spiritual|faith|hindu/.test(c)) return "Religious";
  if (/shop|teleshop|qvc/.test(c)) return "Shopping";
  if (/local|regional|broadcast|network affiliates/.test(c)) return "Local";
  if (/\b(latin|latino|spanish|espanol|telemundo|univision|galavision|unimas|arabic|asia|ex.?yu|balkan|portug|brasil|italia|deutsch|german|french|francais|turk|hindi|punjabi|desi|polski|polska|romania|greek|albania|kurd|farsi|afghan|ireland|eire)\b/.test(c)) return "International";
  if (/drama|series|\bshows?\b|entertain|reality|comedy|lifestyle|cooking|travel|\btv\b/.test(c)) return "Entertainment";
  return "Other";
}

type CategoryRow = { category: string; total: number; hidden: boolean; group: string };

async function decorate(rows: { category: string; total: number }[]): Promise<CategoryRow[]> {
  const hiddenCats = new Set((await getSetting("content.hiddenCategories")) ?? []);
  return rows.map((r) => ({ category: r.category, total: r.total, hidden: hiddenCats.has(r.category), group: categoryGroup(r.category) }));
}

/** Categories with channel counts, their group, + whether the admin hid each one. */
export async function listCategories(): Promise<CategoryRow[]> {
  return decorate(sqlite.query(
    "SELECT category, COUNT(*) AS total FROM channels WHERE category IS NOT NULL AND category != '' GROUP BY category ORDER BY total DESC",
  ).all() as { category: string; total: number }[]);
}

/** Categories a single provider contributes channels to (via its streams). */
export async function listProviderCategories(providerId: number): Promise<CategoryRow[]> {
  return decorate(sqlite.query(
    `SELECT c.category AS category, COUNT(DISTINCT c.id) AS total
       FROM channels c JOIN streams s ON s.channel_id = c.id
      WHERE s.provider_id = ? AND c.category IS NOT NULL AND c.category != ''
      GROUP BY c.category ORDER BY total DESC`,
  ).all(providerId) as { category: string; total: number }[]);
}
