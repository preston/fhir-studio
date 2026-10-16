import crypto from 'node:crypto';
export const HLL_SIZE = 1024;
export function addVisitor(sketch: Uint8Array, value: string): void {
  const hash = crypto.createHash('sha256').update(value).digest();
  const index = hash.readUInt16BE(0) >>> 6;
  // Remaining 54 bits of the first 64-bit hash; rank counts leading zeroes plus one.
  const rest = hash.readBigUInt64BE(0) & ((1n << 54n) - 1n);
  let rank = 1;
  for (let bit = 53n; bit >= 0n && (rest & (1n << bit)) === 0n; bit--) rank++;
  sketch[index] = Math.max(sketch[index] ?? 0, rank);
}
export function mergeVisitors(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(HLL_SIZE);
  for (let i = 0; i < HLL_SIZE; i++)
    result[i] = Math.max(left[i] ?? 0, right[i] ?? 0);
  return result;
}
export function estimateVisitors(sketch: Uint8Array): number {
  let sum = 0,
    zeros = 0;
  for (let i = 0; i < HLL_SIZE; i++) {
    const v = sketch[i] ?? 0;
    sum += 2 ** -v;
    if (!v) zeros++;
  }
  const raw = ((0.7213 / (1 + 1.079 / HLL_SIZE)) * HLL_SIZE ** 2) / sum;
  return Math.round(
    raw <= 2.5 * HLL_SIZE && zeros
      ? HLL_SIZE * Math.log(HLL_SIZE / zeros)
      : raw,
  );
}
export const VISITOR_COOKIE = '__Host-studio-visitor';
const COOKIE_AGE = 90 * 86400;
export function visitorCookie(
  key: string,
  hostname: string,
  value?: string,
  now = Date.now(),
): { token: string; visitor: string | null; fresh: boolean } {
  const sign = (payload: string) =>
    crypto
      .createHmac('sha256', Buffer.from(key, 'base64'))
      .update(`${hostname}:${payload}`)
      .digest('base64url');
  if (value && value.length < 200) {
    const [id, issued, signature] = value.split('.');
    const payload = `${id}.${issued}`;
    const expected = sign(payload);
    if (
      /^[a-f0-9]{32}$/.test(id ?? '') &&
      /^\d{10}$/.test(issued ?? '') &&
      signature?.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) &&
      Number(issued) <= now / 1000 &&
      Number(issued) > now / 1000 - COOKIE_AGE
    )
      return {
        token: value,
        visitor: crypto
          .createHash('sha256')
          .update(`${hostname}:${id}`)
          .digest('hex'),
        fresh: false,
      };
  }
  const payload = `${crypto.randomBytes(16).toString('hex')}.${Math.floor(now / 1000)}`;
  return { token: `${payload}.${sign(payload)}`, visitor: null, fresh: true };
}
export const visitorCookieOptions = {
  secure: true,
  httpOnly: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: COOKIE_AGE * 1000,
};
