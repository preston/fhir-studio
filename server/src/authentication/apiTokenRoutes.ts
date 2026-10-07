// Author: Preston Lee

import { Router, type Request, type Response } from 'express';
import { getPrisma } from '../db/prisma.js';
import { loadSsoConfig } from '../auth/sso_config.js';
import { createSessionAuth } from '../authentication/requireAuthentication.js';
import { generateApiToken, loadApiTokenPepper } from '../authentication/apiToken.js';
import type {
  PersonalAccessTokenListItem,
  PersonalAccessTokenMintResponse,
} from '@fhir-studio/core';

const NAME_MAX_LENGTH = 64;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,63}$/u;

function parseTokenName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'name is required.' };
  }
  const name = raw.trim();
  if (!name) {
    return { ok: false, error: 'name is required.' };
  }
  if (name.length > NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be at most ${NAME_MAX_LENGTH} characters.` };
  }
  if (!NAME_PATTERN.test(name)) {
    return {
      ok: false,
      error: 'name must start with a letter or digit and may include spaces, dots, underscores, hyphens, or apostrophes.',
    };
  }
  return { ok: true, name };
}

function parseExpiresAt(raw: unknown): { ok: true; expiresAt: Date | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, expiresAt: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, error: 'expiresAt must be an ISO-8601 date string or null.' };
  }
  const expiresAt = new Date(raw);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, error: 'expiresAt is not a valid date.' };
  }
  if (expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: 'expiresAt must be in the future.' };
  }
  return { ok: true, expiresAt };
}

export function createApiTokensRouter(): Router {
  const router = Router();
  const oidc = loadSsoConfig();
  const { requireSessionAuthentication } = createSessionAuth(oidc);
  const prisma = getPrisma(oidc.databaseUrl);
  const pepper = loadApiTokenPepper();

  router.get(
    '/api/personal-access-tokens',
    requireSessionAuthentication,
    async (req: Request, res: Response): Promise<void> => {
      const userId = req.sessionAuth!.userId;
      const tokens = await prisma.apiToken.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          expiresAt: true,
          lastUsedAt: true,
          createdAt: true,
        },
      });
      const items: PersonalAccessTokenListItem[] = tokens.map((t) => ({
        id: t.id,
        name: t.name,
        expiresAt: t.expiresAt?.toISOString() ?? null,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      }));
      res.json({ tokens: items });
    },
  );

  router.post(
    '/api/personal-access-tokens',
    requireSessionAuthentication,
    async (req: Request, res: Response): Promise<void> => {
      const userId = req.sessionAuth!.userId;
      const parsedName = parseTokenName(req.body?.name);
      if (!parsedName.ok) {
        res.status(400).json({ error: parsedName.error });
        return;
      }
      const parsedExpiry = parseExpiresAt(req.body?.expiresAt);
      if (!parsedExpiry.ok) {
        res.status(400).json({ error: parsedExpiry.error });
        return;
      }

      const duplicate = await prisma.apiToken.findFirst({
        where: { userId, name: parsedName.name },
        select: { id: true },
      });
      if (duplicate) {
        res.status(409).json({ error: 'A personal access token with that name already exists.' });
        return;
      }

      const generated = generateApiToken(pepper);
      const created = await prisma.apiToken.create({
        data: {
          userId,
          name: parsedName.name,
          tokenHash: generated.hash,
          prefix: generated.prefix,
          expiresAt: parsedExpiry.expiresAt,
        },
      });
      const body: PersonalAccessTokenMintResponse = {
        token: generated.token,
        id: created.id,
        name: created.name,
        expiresAt: created.expiresAt?.toISOString() ?? null,
        createdAt: created.createdAt.toISOString(),
      };
      res.status(201).json(body);
    },
  );

  router.patch(
    '/api/personal-access-tokens/:tokenId',
    requireSessionAuthentication,
    async (req: Request, res: Response): Promise<void> => {
      const userId = req.sessionAuth!.userId;
      const tokenId = String(req.params.tokenId);
      const existing = await prisma.apiToken.findFirst({
        where: { id: tokenId, userId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Personal access token not found.' });
        return;
      }

      // Name is the only mutable field; token secret and expiry are immutable after mint.
      const parsedName = parseTokenName(req.body?.name);
      if (!parsedName.ok) {
        res.status(400).json({ error: parsedName.error });
        return;
      }
      if (parsedName.name !== existing.name) {
        const duplicate = await prisma.apiToken.findFirst({
          where: { userId, name: parsedName.name, NOT: { id: existing.id } },
          select: { id: true },
        });
        if (duplicate) {
          res.status(409).json({ error: 'A personal access token with that name already exists.' });
          return;
        }
      }

      const updated = await prisma.apiToken.update({
        where: { id: existing.id },
        data: { name: parsedName.name },
      });
      const item: PersonalAccessTokenListItem = {
        id: updated.id,
        name: updated.name,
        expiresAt: updated.expiresAt?.toISOString() ?? null,
        lastUsedAt: updated.lastUsedAt?.toISOString() ?? null,
        createdAt: updated.createdAt.toISOString(),
      };
      res.json(item);
    },
  );

  router.delete(
    '/api/personal-access-tokens/:tokenId',
    requireSessionAuthentication,
    async (req: Request, res: Response): Promise<void> => {
      const userId = req.sessionAuth!.userId;
      const tokenId = String(req.params.tokenId);
      const existing = await prisma.apiToken.findFirst({
        where: { id: tokenId, userId },
      });
      if (!existing) {
        res.status(404).json({ error: 'Personal access token not found.' });
        return;
      }
      await prisma.apiToken.delete({ where: { id: existing.id } });
      res.json({ message: 'Personal access token revoked.' });
    },
  );

  return router;
}
