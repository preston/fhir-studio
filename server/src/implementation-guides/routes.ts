// Author: Preston Lee

import express, { type Request, type Response, type Router } from 'express';
import axios from 'axios';
import { type Prisma } from '@prisma/client';
import { getPrisma } from '../db/prisma.js';
import { fetchPackageTarball } from './registry.js';

export function createImplementationGuidesRouter(): Router {
  const router = express.Router();
  const prisma = getPrisma();

  // 1. GET /api/implementation-guides (List registered Implementation Guides)
  router.get('/api/implementation-guides', async (req: Request, res: Response): Promise<void> => {
    try {
      const { search, fhirVersion, category, recommendedForCreation, isSuggested } = req.query;

      const where: Prisma.ImplementationGuideWhereInput = {};

      if (search && String(search).trim()) {
        const q = String(search).trim();
        where.OR = [
          { packageId: { contains: q, mode: 'insensitive' } },
          { title: { contains: q, mode: 'insensitive' } },
          { description: { contains: q, mode: 'insensitive' } },
          { author: { contains: q, mode: 'insensitive' } },
        ];
      }

      if (fhirVersion && String(fhirVersion) !== 'all') {
        const v = String(fhirVersion).toUpperCase();
        // Support matching R4 -> 4.0.1 or 4.0.* or exact
        if (v === 'R4') {
          where.OR = [
            { fhirVersion: { startsWith: '4.0' } },
            { fhirVersion: 'R4' },
          ];
        } else if (v === 'R4B') {
          where.OR = [
            { fhirVersion: { startsWith: '4.3' } },
            { fhirVersion: 'R4B' },
          ];
        } else if (v === 'R5') {
          where.OR = [
            { fhirVersion: { startsWith: '5.0' } },
            { fhirVersion: 'R5' },
          ];
        } else {
          where.fhirVersion = String(fhirVersion);
        }
      }

      if (category && String(category) !== 'all') {
        where.category = String(category).toUpperCase();
      }

      if (recommendedForCreation !== undefined) {
        where.recommendedForCreation = String(recommendedForCreation) === 'true';
      }

      if (isSuggested !== undefined) {
        where.isSuggested = String(isSuggested) === 'true';
      }

      const implementationGuides = await prisma.implementationGuide.findMany({
        where,
        orderBy: [{ recommendedForCreation: 'desc' }, { title: 'asc' }],
      });

      res.json({ implementationGuides });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to fetch implementation guides', message: err?.message });
    }
  });

  // 2. GET /api/implementation-guides/registry/search (Search packages.fhir.org upstream)
  router.get('/api/implementation-guides/registry/search', async (req: Request, res: Response): Promise<void> => {
    const query = String(req.query.q || req.query.search || '').trim();
    if (!query) {
      res.json({ results: [] });
      return;
    }

    try {
      const resp = await axios.get(`https://packages.fhir.org/catalog?name=${encodeURIComponent(query)}`, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });

      const raw = Array.isArray(resp.data) ? resp.data : [];
      res.json({ results: raw });
    } catch (err: any) {
      // Return local database matches if external registry call fails or times out
      try {
        const localMatches = await prisma.implementationGuide.findMany({
          where: {
            OR: [
              { packageId: { contains: query, mode: 'insensitive' } },
              { title: { contains: query, mode: 'insensitive' } },
            ],
          },
        });
        res.json({
          results: localMatches.map((ig) => ({
            name: ig.packageId,
            version: ig.version,
            title: ig.title,
            description: ig.description,
            'dist-tags': { latest: ig.version },
          })),
        });
      } catch {
        res.status(500).json({ error: 'Failed to search FHIR package registry', message: err?.message });
      }
    }
  });

  // 3. GET /api/implementation-guides/registry/download/:packageId{/:version} (Proxy/download package tarball)
  router.get('/api/implementation-guides/registry/download/:packageId{/:version}', async (req: Request, res: Response): Promise<void> => {
    const { packageId, version } = req.params;
    const { tarballUrl } = req.query;

    if (!packageId) {
      res.status(400).json({ error: 'packageId is required' });
      return;
    }

    try {
      let customUrl = typeof tarballUrl === 'string' && tarballUrl.trim() ? tarballUrl.trim() : undefined;

      // Check local DB if custom tarballUrl not provided
      if (!customUrl) {
        const local = await prisma.implementationGuide.findFirst({
          where: version ? { packageId, version } : { packageId },
          orderBy: { updatedAt: 'desc' },
        });
        if (local?.tarballUrl) {
          customUrl = local.tarballUrl;
        }
      }

      const { buffer, filename } = await fetchPackageTarball(packageId, version, customUrl);

      res.setHeader('Content-Type', 'application/tar+gzip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (err: any) {
      res.status(502).json({
        error: `Failed to download package '${packageId}' from FHIR registry`,
        message: err?.message,
      });
    }
  });

  // 4. GET /api/implementation-guides/registry/package/:packageId{/:version}
  router.get('/api/implementation-guides/registry/package/:packageId{/:version}', async (req: Request, res: Response): Promise<void> => {
    const { packageId, version } = req.params;

    try {
      const url = `https://packages.fhir.org/${encodeURIComponent(packageId)}`;

      const resp = await axios.get(url, {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });

      const data = resp.data;
      if (version && data?.versions?.[version]) {
        res.json({ package: data.versions[version] });
      } else {
        res.json({ package: data });
      }
    } catch (err: any) {
      // Check local DB if available
      const local = await prisma.implementationGuide.findFirst({
        where: version ? { packageId, version } : { packageId },
        orderBy: { updatedAt: 'desc' },
      });

      if (local) {
        res.json({
          package: {
            name: local.packageId,
            version: local.version,
            title: local.title,
            description: local.description,
            fhirVersion: local.fhirVersion,
            author: local.author,
            canonical: local.canonicalUrl,
            url: local.url,
          },
        });
        return;
      }

      res.status(404).json({ error: `Package '${packageId}' not found on FHIR registry.`, message: err?.message });
    }
  });

  // 5. GET /api/implementation-guides/:id (Fetch single IG record)
  router.get('/api/implementation-guides/:id', async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    try {
      const ig = await prisma.implementationGuide.findUnique({
        where: { id },
      });

      if (!ig) {
        res.status(404).json({ error: `Implementation guide with id '${id}' not found.` });
        return;
      }

      res.json({ implementationGuide: ig });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to retrieve implementation guide.', message: err?.message });
    }
  });

  return router;
}
