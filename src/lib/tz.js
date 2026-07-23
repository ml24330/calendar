/* Pinning the calendar to one timezone.

   The problem this solves: every date helper in dates.js reads wall-clock
   values with getHours(), getDate() and friends, which report whatever zone
   the *machine* is in. In the browser that's the viewer's laptop; on the
   server it's the host, which on most PaaS is UTC. So the same event rendered
   in two places disagreed about what time it was.

   The fix is to keep one zone for the whole calendar. Instants are still
   stored and exported in UTC — nothing about the database or the .ics feed
   changes. Only the wall clock used for display and for day bucketing is
   pinned.

   How: toZoned() returns a Date shifted so its *local* getters report the
   target zone's wall clock. That lets every existing helper keep working
   untouched. fromZoned() inverts it, and is what the event form uses to turn
   what someone typed back into a real instant.

   A shifted Date is a lie about the instant it represents, so the rule is:
   convert at the edges, never store one, and never hand one to toISOString().
*/

export const CALENDAR_TZ = "America/Los_Angeles";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: CALENDAR_TZ,
  hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
});

const ABBR = new Intl.DateTimeFormat("en-US", {
  timeZone: CALENDAR_TZ,
  timeZoneName: "short",
});

/** The wall-clock fields of an instant, as read in CALENDAR_TZ. */
export function zonedParts(instant) {
  const p = {};
  for (const { type, value } of PARTS.formatToParts(instant)) p[type] = value;
  return {
    year: Number(p.year),
    month: Number(p.month) - 1,
    day: Number(p.day),
    // ICU reports midnight as "24" in some versions.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Offset of CALENDAR_TZ from UTC at a given instant, in ms. Negative west. */
function offsetAt(instant) {
  const w = zonedParts(instant);
  const asUTC = Date.UTC(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return asUTC - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * A true instant -> a Date whose *local* getters read as CALENDAR_TZ wall clock.
 *
 * Built by reading the zone's fields and feeding them straight to the local
 * Date constructor. The tempting shortcut — shifting the timestamp by the
 * zone's UTC offset — is wrong, because the local getters then re-interpret
 * the result through the machine's own offset and you count it twice. That
 * bug is invisible on a machine already in the target zone, which is exactly
 * where it would have been written and tested.
 */
export function toZoned(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  const w = zonedParts(d);
  return new Date(w.year, w.month, w.day, w.hour, w.minute, w.second);
}

/**
 * A CALENDAR_TZ wall-clock Date -> the true instant it refers to.
 *
 * The offset depends on the instant we're solving for, so guess at UTC and
 * correct. Two passes converge everywhere. Two caveats, both inherent to
 * civil time rather than to this code:
 *   - In a spring-forward gap the wall time doesn't exist; we land just after
 *     the transition.
 *   - In a fall-back hour two instants share one wall time; we return the
 *     earlier (still-daylight) one.
 */
export function fromZoned(wall) {
  const y = wall.getFullYear(), mo = wall.getMonth(), d = wall.getDate();
  const h = wall.getHours(), mi = wall.getMinutes(), s = wall.getSeconds();
  const target = Date.UTC(y, mo, d, h, mi, s);
  let t = target;
  for (let i = 0; i < 2; i++) t = target - offsetAt(new Date(t));
  return new Date(t);
}

/** Convenience: an event's stored ISO string as a zoned Date. */
export const zoned = (iso) => toZoned(new Date(iso));

/** "Now", on the calendar's clock. */
export const zonedNow = () => toZoned(new Date());

/** "PDT" or "PST", for labelling times so travellers aren't misled. */
export function zoneAbbr(instant = new Date()) {
  const part = ABBR.formatToParts(instant).find((p) => p.type === "timeZoneName");
  return part ? part.value : "";
}

/** True when the viewer's own clock differs from the calendar's right now. */
export function viewerIsElsewhere() {
  const now = new Date();
  return offsetAt(now) !== -now.getTimezoneOffset() * 60000;
}
