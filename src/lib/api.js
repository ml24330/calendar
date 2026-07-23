/* Client for the calendar API.

   The admin token lives in sessionStorage: it survives a page refresh but
   dies with the tab. It is only a key to the server's session table — the
   server decides what an admin may see, so a forged token here gets you
   nothing. */

const TOKEN_KEY = "orgcal:token";

export const getToken = () => {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
};
const setToken = (t) => {
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
};

async function call(path, { method = "GET", body } = {}) {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    // Vite answers unknown paths with index.html and a 200, so an ok status
    // is not proof the API is there. Check the content type.
    throw new ApiError("The calendar server isn't responding. Is `npm run dev` running?", res.status);
  }
  const data = await res.json();
  if (!res.ok) throw new ApiError(data.error || "Something went wrong.", res.status, data);
  return data;
}

export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

export const bootstrap = () => call("/api/bootstrap");

export async function login(passphrase) {
  const { token } = await call("/api/session", { method: "POST", body: { passphrase } });
  setToken(token);
  return token;
}

export async function logout() {
  try { await call("/api/session", { method: "DELETE" }); } catch { /* already gone */ }
  setToken(null);
}

export const createEvent = (ev) => call("/api/events", { method: "POST", body: ev });
export const updateEvent = (id, patch) => call(`/api/events/${id}`, { method: "PATCH", body: patch });
export const deleteEvent = (id) => call(`/api/events/${id}`, { method: "DELETE" });
export const saveTags = (tags) => call("/api/tags", { method: "PUT", body: { tags } });

/** URL for the PDF of the current view. Carries the token so an admin's
    export includes drafts. */
export function pdfUrl({ view, date, tagIds, query }) {
  const p = new URLSearchParams({ view, date: date.toISOString() });
  if (tagIds && tagIds.length) p.set("tags", tagIds.join(","));
  if (query) p.set("q", query);
  const token = getToken();
  if (token) p.set("token", token);
  return `/export.pdf?${p.toString()}`;
}
