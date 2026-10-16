import type { RepositoryFile } from '@fhir-studio/core';
import { github, repositoryForUser } from './github.js';
import { HostingError, repositoryPath } from './access.js';
import type { HostingConfig } from './config.js';

export const workflowPath = (id: string) =>
  `.github/workflows/fhir-studio-${id}.yml`;
export async function commitFiles(
  token: string,
  base: string,
  branch: string,
  expected: string,
  files: RepositoryFile[],
  message: string,
): Promise<string> {
  if (
    !files.length ||
    files.length > 100 ||
    files.some((f) => Buffer.byteLength(f.content) > 512_000) ||
    files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 2_000_000
  )
    throw new HostingError(
      413,
      'Commit exceeds the file count or text size limit.',
    );
  const head = await github<{ object: { sha: string } }>(
    token,
    `${base}/git/ref/heads/${encodeURIComponent(branch)}`,
  );
  if (head.object.sha !== expected)
    throw new HostingError(
      409,
      'The branch changed. Download your recovery patch and refresh before saving.',
      'conflict',
    );
  const parent = await github<{ tree: { sha: string } }>(
    token,
    `${base}/git/commits/${expected}`,
  );
  const tree = await github<{ sha: string }>(
    token,
    `${base}/git/trees`,
    'POST',
    {
      base_tree: parent.tree.sha,
      tree: files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.content,
      })),
    },
  );
  const commit = await github<{ sha: string }>(
    token,
    `${base}/git/commits`,
    'POST',
    { message, tree: tree.sha, parents: [expected] },
  );
  await github(
    token,
    `${base}/git/refs/heads/${encodeURIComponent(branch)}`,
    'PATCH',
    { sha: commit.sha, force: false },
  );
  return commit.sha;
}
export function managedWorkflow(app: {
  id: string;
  projectDirectory: string;
  buildCommand: string;
  outputDirectory: string;
  nodeVersion: string;
}): string {
  const q = JSON.stringify;
  if (
    [
      app.projectDirectory,
      app.buildCommand,
      app.outputDirectory,
      app.nodeVersion,
    ].some((v) => v.includes('${{'))
  )
    throw new HostingError(
      400,
      'GitHub expression interpolation is prohibited in build configuration.',
    );
  return `name: FHIR Studio ${app.id}\nrun-name: \${{ github.event_name == 'workflow_dispatch' && format('Studio preview {0}', inputs.studio_request_id) || github.event.head_commit.message }}\non:\n  push:\n  workflow_dispatch:\n    inputs:\n      studio_request_id:\n        description: Studio build request\n        required: true\n        type: string\npermissions:\n  contents: read\nconcurrency:\n  group: studio-${app.id}-\${{ github.ref }}\n  cancel-in-progress: true\njobs:\n  build:\n    runs-on: ubuntu-latest\n    timeout-minutes: 15\n    steps:\n      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n        with:\n          persist-credentials: false\n      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38\n        with:\n          node-version: ${q(app.nodeVersion)}\n      - name: Build static application\n        working-directory: ${q(app.projectDirectory || '.')}\n        run: ${q(app.buildCommand)}\n      - uses: actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f\n        with:\n          name: studio-${app.id}-\${{ github.run_id }}-\${{ github.run_attempt }}\n          path: ${q([app.projectDirectory, app.outputDirectory].filter(Boolean).join('/'))}\n          if-no-files-found: error\n          retention-days: 3\n          include-hidden-files: false\n`;
}
export async function sourceSnapshot(
  userId: string,
  repositoryId: string,
  branch: string,
  config: HostingConfig,
) {
  const { token, base } = await repositoryForUser(userId, repositoryId, config);
  const commit = await github<{ sha: string }>(
    token,
    `${base}/commits/${encodeURIComponent(branch)}`,
  );
  const tree = await github<{
    truncated: boolean;
    tree: Array<{ path: string; type: string; size?: number; mode: string }>;
  }>(token, `${base}/git/trees/${commit.sha}?recursive=1`);
  if (tree.truncated || tree.tree.length > 10_000)
    throw new HostingError(
      413,
      'Repository is too large for the Studio editor. Use a local editor.',
    );
  return {
    commit: commit.sha,
    branch,
    files: tree.tree
      .filter(
        (f) =>
          f.type === 'blob' &&
          f.mode === '100644' &&
          !f.path
            .split('/')
            .some((p) => p.startsWith('.') || p === 'node_modules'),
      )
      .map((f) => ({ path: f.path, size: f.size || 0 })),
  };
}
export async function readSource(
  userId: string,
  repositoryId: string,
  ref: string,
  file: string,
  config: HostingConfig,
): Promise<string> {
  repositoryPath(file);
  const { token, base } = await repositoryForUser(userId, repositoryId, config);
  const blob = await github<{
    size: number;
    encoding: string;
    content?: string;
  }>(
    token,
    `${base}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
  );
  if (blob.size > 512_000 || blob.encoding !== 'base64' || !blob.content)
    throw new HostingError(
      413,
      'File is binary or too large for the text editor.',
    );
  const text = Buffer.from(blob.content, 'base64').toString('utf8');
  if (text.includes('\0') || text.includes('\ufffd'))
    throw new HostingError(400, 'Binary files must be edited outside Studio.');
  return text;
}

export async function copyTemplateSnapshot(
  userId: string,
  repositoryId: string,
  commit: string,
  targetToken: string,
  targetBase: string,
  branch: string,
  expected: string,
  config: HostingConfig,
): Promise<void> {
  const source = await repositoryForUser(userId, repositoryId, config);
  const tree = await github<{
    truncated: boolean;
    tree: Array<{
      path: string;
      type: string;
      mode: string;
      sha: string;
      size?: number;
    }>;
  }>(source.token, `${source.base}/git/trees/${commit}?recursive=1`);
  const files = tree.tree.filter(
    (file) =>
      file.type === 'blob' &&
      file.mode === '100644' &&
      !file.path.startsWith('.github/workflows/') &&
      !file.path
        .split('/')
        .some(
          (part) =>
            part === '.git' ||
            part === 'node_modules' ||
            part.startsWith('.env') ||
            /^(\.npmrc|.*\.(pem|key|p12|pfx))$/i.test(part),
        ),
  );
  if (
    tree.truncated ||
    files.length > config.maxFiles ||
    files.reduce((n, file) => n + (file.size || 0), 0) > config.maxArchiveBytes
  )
    throw new HostingError(413, 'Template source exceeds the copy limits.');
  const blobs: Array<{
    path: string;
    mode: string;
    type: string;
    sha: string;
  }> = [];
  for (let start = 0; start < files.length; start += 4) {
    const batch = await Promise.all(
      files.slice(start, start + 4).map(async (file) => {
        const blob = await github<{ content: string; encoding: string }>(
          source.token,
          `${source.base}/git/blobs/${file.sha}`,
        );
        const copied = await github<{ sha: string }>(
          targetToken,
          `${targetBase}/git/blobs`,
          'POST',
          { content: blob.content, encoding: 'base64' },
        );
        return {
          path: file.path,
          mode: '100644',
          type: 'blob',
          sha: copied.sha,
        };
      }),
    );
    blobs.push(...batch);
  }
  const parent = await github<{ tree: { sha: string } }>(
    targetToken,
    `${targetBase}/git/commits/${expected}`,
  );
  const result = await github<{ sha: string }>(
    targetToken,
    `${targetBase}/git/trees`,
    'POST',
    { base_tree: parent.tree.sha, tree: blobs },
  );
  const saved = await github<{ sha: string }>(
    targetToken,
    `${targetBase}/git/commits`,
    'POST',
    {
      message: `Create application from template ${commit}`,
      tree: result.sha,
      parents: [expected],
    },
  );
  await github(
    targetToken,
    `${targetBase}/git/refs/heads/${encodeURIComponent(branch)}`,
    'PATCH',
    { sha: saved.sha, force: false },
  );
}
