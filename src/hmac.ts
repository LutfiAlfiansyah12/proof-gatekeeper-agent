import * as crypto from 'node:crypto';

/**
 * HMAC-SHA256 over the RAW request/response body bytes.
 *
 * The inbound header format used by the platform is not fully pinned down by
 * the docs, so verification accepts the common conventions:
 *   - "sha256=<hex>"   (github-style prefix)
 *   - "v1=<hex>"       (versioned prefix)
 *   - "<hex>"          (bare hex)
 * Responses are signed in the SAME style the inbound request used (or
 * "sha256=" by default), so the platform can verify them symmetrically.
 */

export type SigStyle = 'sha256' | 'v1' | 'bare';

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function computeHmac(rawBody: Buffer, secret: string): Buffer {
  return crypto.createHmac('sha256', secret).update(rawBody).digest();
}

export function encodeHeader(digest: Buffer, style: SigStyle): string {
  const hex = digest.toString('hex');
  switch (style) {
    case 'sha256':
      return `sha256=${hex}`;
    case 'v1':
      return `v1=${hex}`;
    default:
      return hex;
  }
}

function parseHeader(header: string): { style: SigStyle; hex: string } | null {
  const h = header.trim();
  if (h.toLowerCase().startsWith('sha256=')) {
    const hex = h.slice(7).trim();
    return HEX64.test(hex) ? { style: 'sha256', hex } : null;
  }
  if (h.toLowerCase().startsWith('v1=')) {
    const hex = h.slice(3).trim();
    return HEX64.test(hex) ? { style: 'v1', hex } : null;
  }
  if (HEX64.test(h)) return { style: 'bare', hex: h.toLowerCase() };
  return null;
}

/** Constant-time comparison of two hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase(), 'utf8');
  const bb = Buffer.from(b.toLowerCase(), 'utf8');
  if (ab.length !== bb.length) {
    // Still burn comparable time to avoid a length oracle.
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export interface VerifyResult {
  valid: boolean;
  /** The style that matched (use it to sign the response). */
  style?: SigStyle;
}

export function verifyHmac(
  rawBody: Buffer,
  header: string | undefined | null,
  secret: string,
): VerifyResult {
  if (!header || !secret) return { valid: false };
  const parsed = parseHeader(header);
  if (!parsed) return { valid: false };
  const expected = computeHmac(rawBody, secret);
  return { valid: safeEqualHex(parsed.hex, expected.toString('hex')), style: parsed.style };
}
