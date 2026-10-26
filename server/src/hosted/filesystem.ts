import { assertOwnerQuota, lockHostingAllocation } from './quotas.js';
import { createWriteStream } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  open,
} from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import path from 'node:path';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { HostingConfig } from './config.js';
import { HostingError } from './access.js';
import { getPrisma } from '../db/prisma.js';
import { lockApplication } from './github.js';

const extensions = new Set([
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.json',
  '.map',
  '.txt',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
]);
export function safeAssetPath(name: string): string {
  const parts = name.split('/');
  if (
    !name ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /[\x00-\x1f:]/.test(name) ||
    parts.some((p) => !p || p.startsWith('.')) ||
    !extensions.has(path.extname(name).toLowerCase())
  )
    throw new HostingError(400, `Unsupported or unsafe artifact file: ${name}`);
  if (parts[0] === '_studio')
    throw new HostingError(400, 'The _studio path is reserved.');
  return name;
}
export function buildDirectory(
  config: HostingConfig,
  appId: string,
  buildId: string,
): string {
  if (![appId, buildId].every((id) => /^[a-f0-9-]{36}$/.test(id)))
    throw new HostingError(400, 'Invalid storage identifier.');
  return path.join(config.root, 'apps', appId, buildId);
}
export async function checkStorage(config: HostingConfig): Promise<void> {
  await access(config.root);
  const info = await statfs(config.root);
  if (info.bavail * info.bsize < config.maxExpandedBytes * 2)
    throw new HostingError(507, 'Insufficient free space for a safe import.');
}
export async function reserveStorage(
  config: HostingConfig,
  buildId: string,
): Promise<void> {
  await getPrisma().$transaction(async (tx) => {
    await lockHostingAllocation(tx);
    const current = await tx.hostedBuild.findUniqueOrThrow({
      where: { id: buildId },
    });
    if (current.status !== 'IMPORTING' || current.directory)
      throw new HostingError(409, 'The import is no longer active.');
    const owner = await tx.hostedApplication.findUniqueOrThrow({ where: { id: current.applicationId } });
    await assertOwnerQuota(tx, config, owner.ownerUserId, 0, BigInt(config.maxExpandedBytes) - current.byteSize);
    const used = await tx.hostedBuild.aggregate({
      _sum: { byteSize: true },
      where: { id: { not: buildId } },
    });
    if (
      Number(used._sum.byteSize || 0) + config.maxExpandedBytes >
      config.maxStorageBytes
    )
      throw new HostingError(
        507,
        'Hosted application storage budget exceeded.',
      );
    await tx.hostedBuild.update({
      where: { id: buildId },
      data: { byteSize: BigInt(config.maxExpandedBytes) },
    });
  });
}
export async function downloadArtifact(
  url: string,
  destination: string,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const target = new URL(url);
  if (
    target.protocol !== 'https:' ||
    !(
      /(^|\.)blob\.core\.windows\.net$/.test(target.hostname) ||
      /(^|\.)githubusercontent\.com$/.test(target.hostname) ||
      /(^|\.)actions\.github\.com$/.test(target.hostname)
    )
  )
    throw new HostingError(
      502,
      'GitHub returned an unapproved artifact download host.',
    );
  const response = await fetch(target, { redirect: 'error', signal });
  if (!response.ok || !response.body)
    throw new HostingError(
      502,
      'Artifact download failed. Retry import or rebuild.',
    );
  if (Number(response.headers.get('content-length') || 0) > limit)
    throw new HostingError(413, 'Artifact exceeds the compressed size limit.');
  let count = 0;
  const hash = crypto.createHash('sha256');
  const body = response.body;
  const chunks = async function* () {
    const reader = body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        yield Buffer.from(part.value);
      }
    } finally {
      reader.releaseLock();
    }
  };
  await pipeline(
    Readable.from(chunks()),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        count += chunk.length;
        if (count > limit)
          return callback(
            new HostingError(
              413,
              'Artifact exceeds the compressed size limit.',
            ),
          );
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
    { signal },
  );
  return `sha256:${hash.digest('hex')}`;
}
export async function extractArtifact(
  archive: string,
  destination: string,
  config: HostingConfig,
  signal: AbortSignal,
): Promise<number> {
  await mkdir(destination, { recursive: true, mode: 0o750 });
  return new Promise((resolve, reject) => {
    yauzl.open(
      archive,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip)
          return reject(error || new Error('Invalid ZIP archive.'));
        if (zip.entryCount > config.maxFiles) {
          zip.close();
          reject(
            new HostingError(413, 'Artifact exceeds the entry count limit.'),
          );
          return;
        }
        let total = 0;
        let files = 0;
        const seen = new Set<string>();
        const fail = (cause: unknown) => {
          zip.close();
          reject(cause);
        };
        zip.on('error', fail);
        zip.on('end', () => resolve(total));
        zip.on('entry', (entry: yauzl.Entry) => {
          void (async () => {
            signal.throwIfAborted();
            const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
            if (
              entry.generalPurposeBitFlag & 1 ||
              (mode && mode !== 0x8000 && mode !== 0x4000)
            )
              throw new HostingError(
                400,
                'Archive links, devices, and encrypted files are prohibited.',
              );
            if (entry.fileName.endsWith('/')) {
              const name = entry.fileName.slice(0, -1);
              if (
                name.split('/').some((p) => !p || p.startsWith('.')) ||
                /[\\:\x00-\x1f]/.test(name) ||
                name.startsWith('/')
              )
                throw new HostingError(400, 'Unsafe archive directory.');
              zip.readEntry();
              return;
            }
            const name = safeAssetPath(entry.fileName);
            if (seen.has(name.toLowerCase()))
              throw new HostingError(400, 'Duplicate artifact path.');
            seen.add(name.toLowerCase());
            if (
              ++files > config.maxFiles ||
              total + entry.uncompressedSize > config.maxExpandedBytes
            )
              throw new HostingError(
                413,
                'Artifact exceeds the expanded size or file count limit.',
              );
            const target = path.join(destination, name);
            await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
            let checksum = 0;
            await new Promise<void>((done, failed) =>
              zip.openReadStream(entry, (err, stream) => {
                if (err || !stream) return failed(err);
                void pipeline(
                  stream,
                  new Transform({
                    transform(chunk: Buffer, _enc, cb) {
                      total += chunk.length;
                      checksum = crc32(chunk, checksum);
                      if (total > config.maxExpandedBytes)
                        return cb(
                          new HostingError(
                            413,
                            'Expanded size limit exceeded.',
                          ),
                        );
                      cb(null, chunk);
                    },
                  }),
                  createWriteStream(target, { flags: 'wx', mode: 0o640 }),
                  { signal },
                ).then(() => done(), failed);
              }),
            );
            if (checksum !== entry.crc32)
              throw new HostingError(400, 'ZIP entry checksum mismatch.');
            const handle = await open(target, 'r');
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            zip.readEntry();
          })().catch(fail);
        });
        zip.readEntry();
      },
    );
  });
}
export async function finalizeBuild(
  config: HostingConfig,
  appId: string,
  buildId: string,
  staging: string,
): Promise<string> {
  const syncDirectory = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true }))
      if (entry.isDirectory())
        await syncDirectory(path.join(directory, entry.name));
    const handle = await open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  await syncDirectory(staging);
  const target = buildDirectory(config, appId, buildId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  await rename(staging, target);
  await chmod(target, 0o750);
  const parent = await open(path.dirname(target), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return target;
}
export async function cleanupStorage(config: HostingConfig, checkCancelled: () => Promise<void> = async () => {}): Promise<void> {
  const prisma = getPrisma();
  // Reclaimed or terminal leases cannot keep quota reserved after a worker crash.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('hosted-storage', 0))`;
    const pending = await tx.hostedBuild.findMany({
      where: {
        directory: null,
        byteSize: { gt: 0 },
        updatedAt: { lt: new Date(Date.now() - 10 * 60_000) },
      },
    });
    for (const build of pending) {
      const job = build.jobId
        ? await tx.job.findUnique({ where: { id: build.jobId } })
        : null;
      if (
        job &&
        (job.status === 'queued' ||
          (job.status === 'in_progress' &&
            job.leaseExpiresAt &&
            job.leaseExpiresAt > new Date()))
      )
        continue;
      await tx.hostedBuild.update({
        where: { id: build.id },
        data: {
          byteSize: 0,
          ...(build.status === 'IMPORTING'
            ? {
                status: 'FAILED',
                error: 'Import interrupted. Retry import or rebuild.',
              }
            : {}),
        },
      });
    }
  });
  const root = path.join(config.root, 'apps');
  for (const item of await readdir(root, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (!item.isDirectory() || !/^[a-f0-9-]{36}$/.test(item.name)) continue;
    await checkCancelled();
    await prisma.$transaction(
      async (tx) => {
        await lockApplication(tx, item.name);
        const app = await tx.hostedApplication.findUnique({
          where: { id: item.name },
        });
        // Trash retains assigned builds until a purge job removes the application.
        const desired = app?.desiredBuildId
          ? await tx.hostedBuild.findUnique({
              where: { id: app.desiredBuildId },
            })
          : null;
        const keep = new Set([
          app?.previewBuildId,
          app?.publishedBuildId,
          desired &&
          ['WAITING', 'BUILDING', 'IMPORTING'].includes(desired.status)
            ? desired.id
            : null,
        ]);
        const referencedContent = await tx.hostedBuild.findMany({where:{id:{in:[...keep].filter((id): id is string => !!id)}}});
        for (const build of referencedContent) if (build.contentBuildId) keep.add(build.contentBuildId);
        for (const directory of await readdir(path.join(root, item.name), {
          withFileTypes: true,
        })) {
          if (!directory.isDirectory() || keep.has(directory.name)) continue;
          const target = buildDirectory(config, item.name, directory.name);
          if ((await stat(target)).mtimeMs > Date.now() - 10 * 60_000) continue;
          await checkCancelled();
          await rm(target, { recursive: true, force: true });
          await tx.hostedBuild.updateMany({
            where: { id: directory.name },
            data: { directory: null, byteSize: 0 },
          });
        }
      },
      { timeout: 30_000 },
    );
  }
  // Staging is private and never served; use the job lease to protect live attempts.
  for (const item of await readdir(path.join(config.root, '.staging'), {
    withFileTypes: true,
  }).catch(() => [])) {
    await checkCancelled();
    const jobId = item.name.slice(0, 36);
    const job = /^[a-f0-9-]{36}$/.test(jobId)
      ? await prisma.job.findUnique({ where: { id: jobId } })
      : null;
    const target = path.join(config.root, '.staging', item.name);
    if (
      (await stat(target)).mtimeMs < Date.now() - 60 * 60_000 &&
      !(
        job?.status === 'in_progress' &&
        job.leaseExpiresAt &&
        job.leaseExpiresAt > new Date()
      )
    )
      await rm(target, { recursive: true, force: true });
  }
}
