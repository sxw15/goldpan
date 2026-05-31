import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SharePayload } from './types.js';

const PAYLOAD_VERSION = 1;

/**
 * Minimum HMAC signing-key length. HMAC-SHA256 outputs 32 bytes (256 bits);
 * a key shorter than that gives the attacker leverage to brute-force without
 * the matching brute-force cost on legitimate signatures. Mirrors the env
 * schema's `z.string().min(32)` so callers can't bypass the check by going
 * directly through this pure helper (e.g. tests, future call sites).
 */
const MIN_SIGNING_KEY_LENGTH = 32;

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url chars');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export interface MintShareUrlInput {
  digestId: number;
  presetId?: number | null;
  signingKey: string;
  ttlDays: number;
  publicBaseUrl: string;
  nowMs?: number;
}

// TODO: payload v=1 仅绑 digestId,SQLite ROWID 复用等罕见场景下旧 sig 可能
// 拿到换主的 row。后续可加 v=2 绑 channel/date 短 hash,verify 时 v=2 强校验、
// v=1 在 ttl 内仍接受,避免 breaking 旧链接。
export function mintShareUrl(input: MintShareUrlInput): string {
  if (input.signingKey.length < MIN_SIGNING_KEY_LENGTH) {
    throw new Error(
      `mintShareUrl: signingKey must be at least ${MIN_SIGNING_KEY_LENGTH} chars (got ${input.signingKey.length})`,
    );
  }
  const payload: SharePayload = {
    v: PAYLOAD_VERSION,
    did: input.digestId,
    exp: Math.floor((input.nowMs ?? Date.now()) / 1000) + input.ttlDays * 86400,
  };
  if (input.presetId !== undefined && input.presetId !== null) {
    payload.pid = input.presetId;
  }
  const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = createHmac('sha256', input.signingKey).update(payloadB64).digest();
  const sigB64 = base64urlEncode(sig);
  // Strip trailing slashes so callers can pass either "https://x.com" or
  // "https://x.com/" without producing "https://x.com//digest/share/...".
  const baseUrl = input.publicBaseUrl.replace(/\/+$/, '');
  return `${baseUrl}/digest/share/${input.digestId}?sig=${payloadB64}.${sigB64}`;
}

export type VerifyResult =
  | { ok: true; payload: SharePayload }
  | { ok: false; reason: 'malformed' | 'tampered' | 'expired' | 'mismatch' };

export interface VerifyShareSigInput {
  digestId: number;
  sigParam: string;
  signingKey: string;
  nowMs?: number;
}

export function verifyShareSig(input: VerifyShareSigInput): VerifyResult {
  const parts = input.sigParam.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;

  let payload: SharePayload;
  try {
    const payloadJson = base64urlDecode(payloadB64).toString('utf8');
    const parsed = JSON.parse(payloadJson) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as SharePayload).v !== PAYLOAD_VERSION ||
      typeof (parsed as SharePayload).did !== 'number' ||
      typeof (parsed as SharePayload).exp !== 'number' ||
      ('pid' in parsed &&
        (typeof (parsed as SharePayload).pid !== 'number' ||
          !Number.isInteger((parsed as SharePayload).pid) ||
          ((parsed as SharePayload).pid ?? 0) <= 0))
    ) {
      return { ok: false, reason: 'malformed' };
    }
    payload = parsed as SharePayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (payload.did !== input.digestId) return { ok: false, reason: 'mismatch' };

  const expectedSig = createHmac('sha256', input.signingKey).update(payloadB64).digest();
  let givenSig: Buffer;
  try {
    givenSig = base64urlDecode(sigB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'tampered' };
  }

  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (nowSec >= payload.exp) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}
