import { createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/* ────────────────────────────────────────────────────────────────────────────
   The HRMS's signed integration API (/api/v1/integrations/…), as the Root
   portal and Tetra Commission call it: X-Delta-Client, -Timestamp, -Nonce and
   -Signature — an HMAC of METHOD \n PATH_WITH_QUERY \n TIMESTAMP \n NONCE \n
   sha256(body), byte for byte the HRMS's (a mismatch is a blanket 401). Read
   only.
──────────────────────────────────────────────────────────────────────────── */

const TIMEOUT_MS = 8_000;
const apiUrl = () => env.HRMS_API_URL.replace(/\/+$/, "").replace(/\/api\/v1$/, "");

export const hrmsConfigured = (): boolean => !!(env.HRMS_API_URL && env.HRMS_CLIENT_ID && env.HRMS_INTEGRATION_SECRET);

/** One signed GET; the answer's `data`. Throws with a sentence fit to show. */
export async function hrmsGet<T>(path: string, query: Record<string, string>): Promise<T> {
  // Signed as fetched: the path with its query, built once.
  const signedPath = `/api/v1/integrations${path}?${new URLSearchParams(query).toString()}`;
  const timestamp = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const canonical = ["GET", signedPath, timestamp, nonce, createHash("sha256").update("").digest("hex")].join("\n");
  const signature = createHmac("sha256", env.HRMS_INTEGRATION_SECRET).update(canonical).digest("hex");
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${signedPath}`, {
      headers: { "X-Delta-Client": env.HRMS_CLIENT_ID, "X-Delta-Timestamp": timestamp, "X-Delta-Nonce": nonce, "X-Delta-Signature": signature },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error("The HRMS could not be reached");
  }
  if (res.status === 401) throw new Error("The HRMS refused this server's credentials (HRMS_CLIENT_ID / HRMS_INTEGRATION_SECRET)");
  if (res.status === 404) throw new Error("The HRMS does not answer attendance yet — its server needs the new code");
  if (!res.ok) throw new Error(`The HRMS answered ${res.status}`);
  // A page that isn't the HRMS's API (a maintenance page, the wrong HRMS_API_URL) must read as "can't say", not as
  // an HRMS that knows nobody.
  const body = (await res.json().catch(() => null)) as { data?: T } | null;
  if (!body || typeof body !== "object" || !("data" in body)) throw new Error("The HRMS's answer wasn't its API — check HRMS_API_URL");
  return body.data as T;
}
