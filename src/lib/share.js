/* Shareable links.
 *
 *   ?view=week&date=2026-07-24&tags=t1,t3
 *
 * Read once when the page loads, and written only when someone asks for a
 * link. Ordinary clicking around never touches the address bar — a URL that
 * rewrites itself as you navigate makes the back button behave strangely and
 * turns every stray click into a new history entry.
 *
 * Tags are encoded as the ones *shown*, not the ones hidden. Hidden would rot:
 * a tag created after the link was made would quietly appear in it. Listing
 * what to show means a link keeps meaning exactly what it meant when it was
 * copied.
 *
 * Tag ids are UUIDs, which would make a link with four tags well over 150
 * characters. Only enough of each id to be unambiguous is written, and reading
 * matches by prefix. Positions or a bitmask would be shorter still, but both
 * change meaning silently when a tag is added, removed or reordered — a link
 * that quietly starts saying something else is worse than a long one.
 */

const VIEWS = ["year", "month", "week", "day"];

/** Untagged events; short so it costs almost nothing in the query string. */
export const NONE = "_";

const MIN_PREFIX = 4;

/**
 * The shortest prefix length that tells every current tag apart, floored at 4.
 * Recomputed per link, so it stays as short as the tag list allows.
 */
function prefixLen(ids) {
  for (let n = MIN_PREFIX; n <= 36; n++) {
    if (new Set(ids.map((id) => id.slice(0, n))).size === ids.length) return n;
  }
  return 36;
}

/** Does this stored id match a prefix taken from a link? */
export const matchesToken = (id, token) =>
  token === NONE ? id === "__none" : id.startsWith(token);

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/**
 * Parse the current query string.
 *
 * Anything malformed is ignored rather than thrown — a mangled link should
 * still open a working calendar. But it's reported in `invalid`, because
 * falling back silently is its own bug: someone following a stale link would
 * see the wrong date, or an empty calendar, with nothing to explain it.
 */
export function readParams(search = window.location.search) {
  const q = new URLSearchParams(search);
  const invalid = [];

  const view = VIEWS.includes(q.get("view")) ? q.get("view") : null;
  if (q.has("view") && !view) invalid.push("view");

  let date = null;
  const raw = q.get("date");
  const m = raw && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    // Reject 2026-02-31 and friends, which Date silently rolls over.
    if (d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3])) date = d;
  }

  // null  = no tags param, show everything
  // []    = param present but empty, show nothing
  if (q.has("date") && !date) invalid.push("date");

  const t = q.get("tags");
  const tags = t === null ? null : t.split(",").filter(Boolean);

  return { view, date, tags, invalid };
}

/**
 * Build an absolute link that reproduces the current view.
 *
 * `hasUntagged` mirrors the sidebar: the Untagged row only exists when some
 * event actually has no tag, so the token for it is only worth writing in the
 * same case. Emitting it always put a stray ",_" on the end of every link for
 * a category most calendars never have.
 */
export function buildShareUrl({ view, cursor, hidden, tags, hasUntagged = false }) {
  const q = new URLSearchParams();
  q.set("view", view);
  q.set("date", ymd(cursor));

  // No filter at all: leave the parameter off, so the link simply means
  // "everything" and stays correct as tags are added later.
  if (hidden.size > 0) {
    const n = prefixLen(tags.map((t) => t.id));
    const shown = tags.filter((t) => !hidden.has(t.id)).map((t) => t.id.slice(0, n));
    if (hasUntagged && !hidden.has("__none")) shown.push(NONE);
    q.set("tags", shown.join(","));
  }

  const { origin, pathname } = window.location;
  return `${origin}${pathname}?${q}`;
}
