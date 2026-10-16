// Author: Preston Lee

import crypto from 'node:crypto';
import { requireEnv } from '../env.js';

let signingKeys:
  | { publicKey: crypto.KeyObject; privateKey: crypto.KeyObject; keyId: string }
  | undefined;
export function initializeSmartSigning(): NonNullable<typeof signingKeys> {
  if (signingKeys) return signingKeys;
  const configured =
    process.env.FHIR_STUDIO_SERVER_SMART_SIGNING_KEY ||
    (process.env.NODE_ENV === 'production'
      ? requireEnv('FHIR_STUDIO_SERVER_SMART_SIGNING_KEY')
      : '');
  const privateKey = configured
    ? crypto.createPrivateKey(configured.replace(/\\n/g, '\n'))
    : crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  if (
    privateKey.asymmetricKeyType !== 'rsa' ||
    (privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048
  )
    throw new Error(
      'SMART signing requires an RSA private key of at least 2048 bits.',
    );
  const publicKey = crypto.createPublicKey(privateKey);
  const keyId = crypto
    .createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 24);
  signingKeys = { privateKey, publicKey, keyId };
  return signingKeys;
}

export function getPublicJwks(): Record<string, unknown> {
  const { publicKey, keyId } = initializeSmartSigning();
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    keys: [
      {
        ...jwk,
        kid: keyId,
        use: 'sig',
        alg: 'RS256',
      },
    ],
  };
}

export function verifyPkceChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method?: string,
): boolean {
  if (!method || method.toUpperCase() === 'S256') {
    const hash = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return hash === codeChallenge;
  }
  if (method.toLowerCase() === 'plain') {
    return codeVerifier === codeChallenge;
  }
  return false;
}

export function generateRandomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function generateIdToken(
  claims: {
    iss: string;
    sub: string;
    aud: string;
    fhirUser?: string;
    name?: string;
    email?: string;
    profile?: string;
    [key: string]: unknown;
  },
  _secret: string,
): string {
  const { privateKey, keyId } = initializeSmartSigning();
  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: keyId,
  };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...claims,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    'base64url',
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(privateKey, 'base64url');

  return `${signatureInput}.${signature}`;
}

export function verifyClientAssertionJwt(
  jwtString: string,
  expectedAudience: string,
  clientJwks?: unknown,
  registeredJwksUri?: string | null,
): {
  valid: boolean;
  subject?: string;
  jti?: string;
  expiresAt?: Date;
  error?: string;
} {
  try {
    if (jwtString.length > 16_384)
      return { valid: false, error: 'Client assertion is too large' };
    const parts = jwtString.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWT structure' };
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as Record<string, unknown>;
    const now = Math.floor(Date.now() / 1000);

    if (
      typeof payload.exp !== 'number' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= now ||
      payload.exp > now + 300 ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      payload.jti.length > 256 ||
      typeof payload.sub !== 'string' ||
      payload.sub !== payload.iss
    ) {
      return { valid: false, error: 'Client assertion has expired' };
    }

    if (
      payload.aud !== expectedAudience ||
      !['RS256', 'RS384', 'ES384'].includes(String(header.alg)) ||
      (header.jku !== undefined && header.jku !== registeredJwksUri) ||
      typeof header.kid !== 'string' ||
      !clientJwks ||
      typeof clientJwks !== 'object' ||
      !('keys' in clientJwks) ||
      !Array.isArray(clientJwks.keys)
    )
      return {
        valid: false,
        error: 'Invalid registered key, algorithm, or audience',
      };
    const candidates = clientJwks.keys.filter(
      (key: Record<string, unknown> | null) =>
        key && key.kty === (header.alg === 'ES384' ? 'EC' : 'RSA') && key.kid === header.kid &&
        (!key.alg || key.alg === header.alg) && (!key.use || key.use === 'sig') &&
        (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))),
    );
    const key = candidates.length === 1 ? candidates[0] as crypto.webcrypto.JsonWebKey : null;
    const publicKey = key ? crypto.createPublicKey({ key, format: 'jwk' }) : null;
    if (
      !publicKey ||
      (header.alg === 'ES384' ? key?.crv !== 'P-384' : (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) ||
      !crypto.verify(
        header.alg === 'RS256' ? 'RSA-SHA256' : 'sha384',
        Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(parts[2], 'base64url'),
      )
    )
      return { valid: false, error: 'Invalid assertion signature' };
    return {
      valid: true,
      subject: payload.sub,
      jti: payload.jti,
      expiresAt: new Date(payload.exp * 1000),
    };
  } catch (err: unknown) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : 'Assertion decoding failed',
    };
  }
}
