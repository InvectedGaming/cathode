import { eq, and, or, isNull } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels } from "../db/schema.ts";

/**
 * Adult-content filter. Most providers bucket adult channels into an explicit
 * category group ("XXX", "Adult", "18+", "For Adults"), so we key off the
 * CATEGORY first (reliable) and only fall back to the strongest name markers —
 * deliberately conservative to avoid false positives like "Adult Swim" or a city
 * named "Sussex".
 *
 * Matches are hidden via the normal isHidden mechanism with hiddenReason='adult',
 * so they drop out of the guide, HDHR lineup, and M3U/EPG exports automatically —
 * and turning the setting off cleanly un-hides exactly the ones we hid.
 */

const ADULT_HIDDEN_REASON = "adult";

// Strong markers anywhere in the category string.
const CAT_RE = /(\bxxx\b|\bporn|hardcore|hentai|fetish|brazzers|playboy|hustler|naughty|\beroti|\bnsfw\b|18\s*\+|\+\s*18|adults?\s*only|for\s+adults?)/i;
// A category that IS just the group name ("Adult", "Adults", "XXX", "18+").
const CAT_EXACT = /^\s*(adults?|xxx+|porn|18\s*\+|\+\s*18)\s*$/i;
// On the NAME, only the unambiguous markers — NOT "hardcore" ("Hardcore Pawn" is
// a reality show), "adult" ("Adult Swim"), or substrings ("Sussex").
const NAME_RE = /(\bxxx\b|\bporn\b)/i;

export function isAdult(category: string | null | undefined, name: string | null | undefined): boolean {
  const cat = category ?? "";
  if (CAT_EXACT.test(cat) || CAT_RE.test(cat)) return true;
  if (NAME_RE.test(name ?? "")) return true;
  return false;
}

/**
 * Bring the lineup in line with the hide-adult setting.
 *   hide=true  → hide adult channels we haven't already hidden for another reason
 *   hide=false → un-hide only the channels WE hid (hiddenReason='adult')
 * Returns how many channels changed. Idempotent.
 */
export async function applyAdultFilter(hide: boolean): Promise<number> {
  if (!hide) {
    const undone = await db
      .update(channels)
      .set({ isHidden: false, hiddenReason: null })
      .where(eq(channels.hiddenReason, ADULT_HIDDEN_REASON))
      .returning({ id: channels.id });
    return undone.length;
  }

  // Only touch channels that aren't already hidden by a user/rule (don't clobber
  // those, and skip ones we've already hidden — keeps it idempotent).
  const rows = await db
    .select({ id: channels.id, category: channels.category, name: channels.name })
    .from(channels)
    .where(or(eq(channels.isHidden, false), isNull(channels.isHidden)));

  let changed = 0;
  for (const ch of rows) {
    if (!isAdult(ch.category, ch.name)) continue;
    await db
      .update(channels)
      .set({ isHidden: true, hiddenReason: ADULT_HIDDEN_REASON })
      .where(and(eq(channels.id, ch.id), eq(channels.isHidden, false)));
    changed++;
  }
  return changed;
}
