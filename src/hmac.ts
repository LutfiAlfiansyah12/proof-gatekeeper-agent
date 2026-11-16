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

export type SigStyle = 'sha256' | 'v1' | 'bare' | 'base64' | 'sha256-base64' | 'v1-base64';

const HEX64 = /^[0-9a-fA-F]{64}$/;
const B64 = /^[A-Za-z0-9+/]{43}=$/;

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
    case 'base64':
      return digest.toString('base64');
    case 'sha256-base64':
      return `sha256=${digest.toString('base64')}`;
    case 'v1-base64':
      return `v1=${digest.toString('base64')}`;
    default:
      return hex;
  }
}

function parseHeader(header: string): { style: SigStyle; hex: string } | null {
  const h = header.trim();
  const b64ToHex = (b64: string): string | null => {
    try {
      return Buffer.from(b64, 'base64').toString('hex');
    } catch {
      return null;
    }
  };
  if (h.toLowerCase().startsWith('sha256=')) {
    const rest = h.slice(7).trim();
    if (HEX64.test(rest)) return { style: 'sha256', hex: rest };
    const hex = B64.test(rest) ? b64ToHex(rest) : null;
    return hex ? { style: 'sha256-base64', hex } : null;
  }
  if (h.toLowerCase().startsWith('v1=')) {
    const rest = h.slice(3).trim();
    if (HEX64.test(rest)) return { style: 'v1', hex: rest };
    const hex = B64.test(rest) ? b64ToHex(rest) : null;
    return hex ? { style: 'v1-base64', hex } : null;
  }
  if (HEX64.test(h)) return { style: 'bare', hex: h.toLowerCase() };
  if (B64.test(h)) {
    const hex = b64ToHex(h);
    if (hex) return { style: 'base64', hex };
  }
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
