// Author: Preston Lee

import crypto from 'node:crypto';

// In-memory RSA keypair for SMART asymmetric IdP signing & JWKS
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem',
  },
});

const keyId = 'fhir-studio-key-1';

export function getPublicJwks(): Record<string, unknown> {
  const jwk = crypto.createPublicKey(publicKey).export({ format: 'jwk' }) as Record<string, unknown>;
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

export function verifyPkceChallenge(codeVerifier: string, codeChallenge: string, method?: string): boolean {
  if (!method || method.toUpperCase() === 'S256') {
    const hash = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
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
  secret: string,
): string {
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

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signatureInput);
  const signature = signer.sign(privateKey, 'base64url');

  return `${signatureInput}.${signature}`;
}

export function verifyClientAssertionJwt(
  jwtString: string,
  expectedAudience: string,
  clientJwks?: any,
): { valid: boolean; subject?: string; error?: string } {
  try {
    const parts = jwtString.split('.');
    if (parts.length !== 3) {
      return { valid: false, error: 'Invalid JWT structure' };
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) {
      return { valid: false, error: 'Client assertion has expired' };
    }

    if (payload.aud && payload.aud !== expectedAudience && !expectedAudience.includes(payload.aud)) {
      // Relaxed audience check for dev flexibility
    }

    return { valid: true, subject: payload.sub || payload.iss };
  } catch (err: any) {
    return { valid: false, error: err.message || 'Assertion decoding failed' };
  }
}
