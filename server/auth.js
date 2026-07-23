import crypto from "node:crypto";

/* scrypt, not a bare SHA-256. A raw hash of a passphrase is cheap to attack
   offline with a wordlist; scrypt is deliberately slow and memory-hard, and
   the per-passphrase salt means one cracked calendar doesn't help with the
   next. Format: scrypt$<salt-b64>$<key-b64> */

const KEY_LEN = 64;

export function hashPassphrase(passphrase) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, KEY_LEN);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export function verifyPassphrase(passphrase, stored) {
  if (!stored) return false;
  const [alg, saltB64, keyB64] = stored.split("$");
  if (alg !== "scrypt" || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, "base64");
  const key = Buffer.from(keyB64, "base64");
  const candidate = crypto.scryptSync(passphrase, salt, key.length);
  // Constant-time, so response timing doesn't leak how much of the key matched.
  return crypto.timingSafeEqual(key, candidate);
}

export const newToken = () => crypto.randomBytes(32).toString("base64url");

/** Reads `Authorization: Bearer <token>`, falling back to ?token= so a feed
    URL can carry one (calendar apps can't send headers). */
export function tokenFrom(req, url) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return url.searchParams.get("token") || null;
}
