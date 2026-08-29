// Author: Preston Lee

import crypto from 'node:crypto';

export function hmacSign(payload: string, secret: string): string {
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export interface HmacVerifyResult {
  payload: string;
  usedPreviousSecret: boolean;
}

export function hmacVerify(cookieValue: string, secrets: readonly string[]): HmacVerifyResult | null {
  const dot = cookieValue.lastIndexOf('.');
  if (dot <= 0 || dot === cookieValue.length - 1) {
    return null;
  }
  const payload = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);
  const sigBuf = Buffer.from(sig);

  for (let i = 0; i < secrets.length; i++) {
    const secret = secrets[i];
    if (!secret) {
      continue;
    }
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    const expectedBuf = Buffer.from(expected);
    if (sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return { payload, usedPreviousSecret: i > 0 };
    }
  }
  return null;
}
