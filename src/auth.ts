/**
 * Bearer token authentication with a constant-time comparison.
 *
 * Both values are hashed with SHA-256 first so the comparison always runs over
 * 32 bytes: neither the content nor the length of the configured token leaks
 * through timing.
 */

const encoder = new TextEncoder();

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** Constant-time equality of two byte arrays of the same length. */
export function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)]);
  return constantTimeEqualBytes(ha, hb);
}

export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header);
  return m ? m[1] : null;
}

export const MIN_TOKEN_LENGTH = 32;

export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/** Check the Authorization header against the configured token. */
export async function authorize(header: string | null, configured: string | undefined): Promise<AuthResult> {
  if (!configured || configured.length < MIN_TOKEN_LENGTH) {
    // Fail closed when the secret is missing or obviously weak.
    return { ok: false, status: 503, reason: `admin API disabled: ADMIN_TOKEN must be set (>= ${MIN_TOKEN_LENGTH} chars)` };
  }
  const presented = extractBearer(header);
  if (!presented) return { ok: false, status: 401, reason: "missing bearer token" };
  return (await constantTimeEqual(presented, configured))
    ? { ok: true }
    : { ok: false, status: 401, reason: "invalid token" };
}
