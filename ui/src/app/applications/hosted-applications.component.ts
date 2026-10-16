import { HostingUsageComponent } from './hosting-usage.component.js';
import {
  Component,
  DestroyRef,
  OnInit,
  inject,
  effect,
  signal,
  computed,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink, ActivatedRoute } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { DomSanitizer, type SafeResourceUrl } from '@angular/platform-browser';
import type {
  GitHubConnectionStatus,
  HostedApplication,
  RepositorySnapshot,
} from '@fhir-studio/core';
import {
  HostingService,
  type AppTemplate,
  type GitHubRepository,
} from '../core/services/hosting.service.js';
import { SandboxService } from '../core/services/sandbox.service.js';
import { AuthService } from '../core/services/auth.service.js';
import type { UserPersona } from '../core/services/personas.service.js';
import { HostedEditorState } from './hosted-editor-state.js';
interface LaunchResource {
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  status?: string;
}
import {
  CodeEditorComponent,
  type CodeEditorLanguage,
} from '../shared/code-editor/code-editor.component.js';

@Component({
  selector: 'app-hosted-applications',
  standalone: true,
  imports: [FormsModule, RouterLink, CodeEditorComponent, HostingUsageComponent],
  templateUrl: './hosted-applications.component.html',
})
export class HostedApplicationsComponent implements OnInit {
  readonly api = inject(HostingService);
  readonly sandbox = inject(SandboxService);
  readonly auth = inject(AuthService);
  private readonly sanitizer = inject(DomSanitizer);
  private readonly destroy = inject(DestroyRef);
  private readonly route = inject(ActivatedRoute);
  private readonly wizardReady = signal(false);
  private initialized = false;
  constructor() {
    effect(() => {
      if (
        this.wizardReady() &&
        this.auth.isInitialized() &&
        this.auth.isAuthenticated() &&
        !this.initialized
      ) {
        this.initialized = true;
        void this.initialize();
      }
    });
  }
  readonly apps = signal<HostedApplication[]>([]);
  readonly app = signal<HostedApplication | null>(null);
  readonly connection = signal<GitHubConnectionStatus | null>(null);
  readonly templates = signal<AppTemplate[]>([]);
  readonly repos = signal<GitHubRepository[]>([]);
  readonly tab = signal('Code');
  readonly filter = signal('Owned');
  readonly error = signal('');
  readonly notice = signal('');
  readonly busy = signal(false);
  private readonly editorState = new HostedEditorState();
  readonly snapshot = this.editorState.snapshot;
  readonly drafts = this.editorState.drafts;
  readonly selectedFile = this.editorState.selectedFile;
  readonly editor = this.editorState.editor;
  readonly previewSrc = signal<SafeResourceUrl | null>(null);
  readonly reviewedPreviewId = signal<string | null>(null);
  readonly patients = signal<LaunchResource[]>([]);
  readonly encounters = signal<LaunchResource[]>([]);
  readonly personas = signal<UserPersona[]>([]);
  patientSearch = '';
  readonly visibleApps = computed(() =>
    this.apps().filter((app) =>
      this.filter() === 'Shared'
        ? app.ownerUserId !== this.auth.currentUser()?.id
        : app.ownerUserId === this.auth.currentUser()?.id,
    ),
  );
  readonly language = computed<CodeEditorLanguage>(() => {
    const extension = this.selectedFile().split('.').pop();
    return extension === 'json'
      ? 'json'
      : extension === 'ts' || extension === 'tsx'
        ? 'typescript'
        : extension === 'js' || extension === 'jsx' || extension === 'mjs'
          ? 'javascript'
          : extension === 'html'
            ? 'html'
            : extension === 'css'
              ? 'css'
              : 'text';
  });
  form = {
    name: '',
    repositoryId: '',
    installationId: '',
    starter: '',
    branch: 'main',
    projectDirectory: '',
    buildCommand: 'npm ci && npm run build',
    outputDirectory: 'dist',
    nodeVersion: '26',
    launchPath: 'index.html',
    callbackPath: 'index.html',
    scope: 'launch launch/patient openid fhirUser patient/*.rs',
  };
  settings = {
    name: '',
    description: '',
    branch: '',
    projectDirectory: '',
    buildCommand: '',
    outputDirectory: '',
    nodeVersion: '',
    launchPath: '',
    callbackPath: '',
    scope: '',
    autoPublish: false,
    isTemplate: false,
    templateVisibility: 'PRIVATE',
  };
  newRepo = { owner: '', name: '', private: true };
  branch = '';
  newBranch = '';
  newFile = '';
  memberEmail = '';
  memberRole = 'READ_WRITE';
  transferEmail = '';
  relinkRepositoryId = '';
  relinkInstallationId = '';
  test = { sandbox: '', patient: '', encounter: '', persona: '' };
  publicAcknowledged = false;
  private get baseline(): Record<string, string> { return this.editorState.baseline; }
  private set baseline(value: Record<string, string>) { this.editorState.baseline = value; }
  setting(key: string): string {
    const value = this.settings[key as keyof typeof this.settings];
    return typeof value === 'string' ? value : '';
  }
  changeSetting(key: string, value: string): void {
    const fields = this.settings as unknown as Record<string, string | boolean>;
    if (typeof fields[key] === 'string') fields[key] = value;
  }
  async resume(): Promise<void> {
    await this.action(async () => {
      await this.api.patch(`/api/hosted-applications/${this.app()!.id}`, {
        resume: true,
      });
      await this.refresh(this.app()!.id);
    });
  }
  async selectProject(id: string): Promise<void> {
    await this.action(() => this.open(id));
  }
  private readonly draftKey = () =>
    `studio-app-draft:${this.auth.currentUser()?.id}:${this.app()?.id}`;
  ngOnInit(): void {
    try {
      const draft = sessionStorage.getItem('studio-app-wizard');
      if (draft)
        this.form = {
          ...this.form,
          ...(JSON.parse(draft) as typeof this.form),
        };
    } catch {
      /* corrupted local draft */
    }
    this.wizardReady.set(true);
    this.sandbox.getSandboxes().subscribe();
    const timer = setInterval(() => {
      const id = this.app()?.id;
      if (id && !this.busy()) void this.refresh(id);
    }, 5000);
    this.destroy.onDestroy(() => clearInterval(timer));
  }
  private message(error: unknown): string {
    return error instanceof HttpErrorResponse
      ? error.error?.error || error.message
      : error instanceof Error
        ? error.message
        : 'Operation failed.';
  }
  async action(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    try {
      await work();
    } catch (error) {
      this.error.set(this.message(error));
    } finally {
      this.busy.set(false);
    }
  }
  async initialize(): Promise<void> {
    await this.action(async () => {
      this.apps.set((await this.api.list()).applications);
      this.connection.set(await this.api.connection());
      const installed = this.route.snapshot.queryParamMap.get('installation');
      if (installed) this.form.installationId = installed;
      if (this.route.snapshot.queryParamMap.get('githubSetup') === 'pending')
        this.notice.set(
          'Repository installation is awaiting organization approval. Complete approval on GitHub, then refresh.',
        );
      const templates = await this.api.get<{
        curated: AppTemplate[];
        community: AppTemplate[];
      }>('/api/application-templates');
      this.templates.set([
        ...templates.curated.map((t) => ({
          ...t,
          name: `Curated · ${t.name}`,
        })),
        ...templates.community.map((t) => ({
          ...t,
          name: `Community · ${t.name}`,
        })),
      ]);
      const selected = this.route.snapshot.queryParamMap.get('app');
      if (selected) await this.open(selected);
    });
    if (this.form.installationId) await this.repositories();
  }
  rememberWizard(): void {
    sessionStorage.setItem('studio-app-wizard', JSON.stringify(this.form));
  }
  starterChanged(): void {
    const template = this.templates().find(
      (item) => item.id === this.form.starter,
    );
    this.form.buildCommand = this.form.starter
      ? 'npm install --ignore-scripts && npm run build'
      : 'npm ci && npm run build';
    this.form.outputDirectory =
      this.form.starter === 'angular' ? 'dist/browser' : 'dist';
    for (const field of [
      'projectDirectory',
      'buildCommand',
      'outputDirectory',
      'nodeVersion',
      'launchPath',
      'callbackPath',
      'scope',
    ] as const)
      if (template?.[field] !== undefined) this.form[field] = template[field];
    this.rememberWizard();
  }
  async repositories(): Promise<void> {
    this.rememberWizard();
    await this.action(async () => {
      const repositories: GitHubRepository[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = (
          await this.api.get<{ repositories: GitHubRepository[] }>(
            `/api/github/repositories?installation=${this.form.installationId}&page=${page}`,
          )
        ).repositories;
        repositories.push(...result);
        if (result.length < 100) break;
      }
      this.repos.set(repositories);
    });
  }
  repositoryChanged(): void {
    const repo = this.repos().find(
      (r) => String(r.id) === String(this.form.repositoryId),
    );
    if (repo) {
      this.form.branch = repo.default_branch;
      if (!this.form.name) this.form.name = repo.full_name.split('/')[1];
    }
    this.rememberWizard();
  }
  async detectDefaults(): Promise<void> {
    await this.action(async () => {
      const defaults = await this.api.get<{
        buildCommand: string;
        outputDirectory: string;
        nodeVersion: string;
        note: string;
      }>(
        `/api/github/build-defaults?repositoryId=${this.form.repositoryId}&projectDirectory=${encodeURIComponent(this.form.projectDirectory)}&branch=${encodeURIComponent(this.form.branch)}`,
      );
      this.form.buildCommand = defaults.buildCommand;
      this.form.outputDirectory = defaults.outputDirectory;
      this.form.nodeVersion = defaults.nodeVersion;
      this.notice.set(defaults.note);
      this.rememberWizard();
    });
  }
  async createRepository(): Promise<void> {
    await this.action(async () => {
      const repo = await this.api.post<GitHubRepository>(
        '/api/github/repositories',
        this.newRepo,
      );
      this.repos.update((repos) => [repo, ...repos]);
      this.form.repositoryId = String(repo.id);
      this.form.branch = repo.default_branch;
      this.form.name ||= this.newRepo.name;
      this.rememberWizard();
      this.notice.set(
        `Created ${repo.full_name}. Add it to the Studio GitHub App installation, then refresh the repository list.`,
      );
    });
  }
  async create(): Promise<void> {
    await this.action(async () => {
      const app = await this.api.post<HostedApplication>(
        '/api/hosted-applications',
        this.form,
      );
      sessionStorage.removeItem('studio-app-wizard');
      await this.open(app.id);
      this.apps.set((await this.api.list()).applications);
      this.notice.set(
        'Application created. Install its workflow on a writable branch, merge to the default branch on GitHub if necessary, then build.',
      );
    });
  }
  async refresh(id: string): Promise<void> {
    try {
      const app = await this.api.application(id);
      if (this.app()?.id === id) this.app.set(app);
    } catch {
      /* keep the working editor through temporary outages */
    }
  }
  async open(id: string): Promise<void> {
    if (
      Object.keys(this.drafts()).length &&
      !confirm(
        'Switch application? Your edits will remain in this tab’s recovery draft.',
      )
    )
      return;
    const app = await this.api.application(id);
    this.app.set(app);
    this.branch = app.branch;
    this.selectedFile.set('');
    this.editor.set('');
    this.snapshot.set(null);
    this.previewSrc.set(null);
    this.reviewedPreviewId.set(null);
    this.baseline = {};
    this.settings = {
      name: app.name,
      description: app.description,
      branch: app.branch,
      projectDirectory: app.projectDirectory,
      buildCommand: app.buildCommand,
      outputDirectory: app.outputDirectory,
      nodeVersion: app.nodeVersion,
      launchPath: app.launchPath,
      callbackPath: app.callbackPath,
      scope: app.scope,
      autoPublish: app.autoPublish,
      isTemplate: app.isTemplate,
      templateVisibility: app.templateVisibility,
    };
    try {
      const recovery = JSON.parse(
        sessionStorage.getItem(this.draftKey()) || '{}',
      ) as {
        files?: Record<string, string>;
        baseline?: Record<string, string>;
        snapshot?: RepositorySnapshot;
      };
      this.drafts.set(recovery.files || {});
      this.baseline = recovery.baseline || {};
      if (recovery.snapshot) {
        this.snapshot.set(recovery.snapshot);
        this.branch = recovery.snapshot.branch;
      }
    } catch {
      this.drafts.set({});
    }
    this.test.sandbox = this.sandbox.activeSandbox()?.sandboxId || '';
    this.tab.set('Code');
  }
  async loadSource(): Promise<void> {
    await this.action(async () => {
      const snapshot = await this.api.snapshot(this.app()!.id, this.branch);
      this.editorState.load(snapshot);
      this.notice.set(
        'Source loaded. Unsaved edits remain in this tab until saved or discarded.',
      );
    });
  }
  async file(path: string): Promise<void> {
    await this.action(async () => {
      const app = this.app()!;
      const commit = this.snapshot()?.commit;
      if (!commit) throw Error('Load the branch first.');
      const response = await this.api.get<{ content: string }>(
        `/api/hosted-applications/${app.id}/source?branch=${encodeURIComponent(this.branch)}&commit=${encodeURIComponent(commit)}&path=${encodeURIComponent(path)}`,
      );
      this.baseline[path] = response.content;
      this.selectedFile.set(path);
      this.editor.set(this.drafts()[path] ?? response.content);
    });
  }
  edit(content: string): void {
    this.editorState.edit(content);
    this.rememberDraft();
  }
  private rememberDraft(): void {
    try {
      sessionStorage.setItem(
        this.draftKey(),
        JSON.stringify({
          files: this.drafts(),
          baseline: this.baseline,
          snapshot: this.snapshot(),
        }),
      );
    } catch {
      this.error.set(
        'Tab storage is full. Download your recovery patch before leaving this page.',
      );
    }
  }
  addFile(): void {
    if (!this.newFile || this.busy()) return;
    if (this.snapshot()?.files.some(file => file.path === this.newFile) || Object.hasOwn(this.drafts(), this.newFile)) {
      this.error.set('That file already exists. Select the existing file to edit it.');
      return;
    }
    this.selectedFile.set(this.newFile);
    this.editor.set('');
    this.baseline[this.newFile] = '';
    this.edit('');
    this.newFile = '';
  }
  async save(preview = false): Promise<void> {
    await this.action(async () => {
      const app = this.app()!;
      if (!this.snapshot()) throw Error('Load the branch before saving.');
      if (this.snapshot()!.branch !== this.branch) throw Error('Load the selected branch before saving. Your draft has been preserved.');
      const files = Object.entries(this.drafts()).map(([path, content]) => ({
        path,
        content,
      }));
      if (!files.length) {
        if (preview)
          await this.api.post(`/api/hosted-applications/${app.id}/builds`, {
            branch: this.branch,
          });
        return;
      }
      const result = await this.api.post<{ commit: string }>(
        `/api/hosted-applications/${app.id}/source`,
        {
          branch: this.branch,
          expectedCommit: this.snapshot()!.commit,
          files,
          preview,
        },
      );
      this.editorState.saved(result.commit, files);
      if (Object.keys(this.drafts()).length) this.rememberDraft();
      else sessionStorage.removeItem(this.draftKey());
      this.notice.set(
        `Saved commit ${result.commit.slice(0, 8)}. ${Object.keys(this.drafts()).length ? 'Newer edits remain unsaved in this tab. ' : ''}${preview ? 'Waiting for its GitHub build.' : ''}`,
      );
      await this.refresh(app.id);
    });
  }
  recovery(): void {
    const patch = Object.entries(this.drafts())
      .map(([path, content]) => {
        const original = this.baseline[path] || '';
        const before = original.match(/[^\n]*\n|[^\n]+$/g) || [];
        const after = content.match(/[^\n]*\n|[^\n]+$/g) || [];
        const lines = (prefix: string, items: string[]) =>
          items
            .map(
              (line) =>
                prefix +
                line +
                (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n'),
            )
            .join('');
        return `--- ${Object.hasOwn(this.baseline, path) && this.snapshot()?.files.some((file) => file.path === path) ? 'a/' + path : '/dev/null'}\n+++ b/${path}\n@@ -${before.length ? 1 : 0},${before.length} +${after.length ? 1 : 0},${after.length} @@\n${lines('-', before)}${lines('+', after)}`;
      })
      .join('');
    const url = URL.createObjectURL(new Blob([patch], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'studio-recovery.patch';
    link.click();
    URL.revokeObjectURL(url);
  }
  discard(): void {
    if (confirm('Discard this tab’s pending edits?')) {
      this.drafts.set({});
      sessionStorage.removeItem(this.draftKey());
      this.editor.set(this.baseline[this.selectedFile()] || '');
    }
  }
  async operation(endpoint: string, body: unknown = {}): Promise<void> {
    await this.action(async () => {
      await this.api.post(
        `/api/hosted-applications/${this.app()!.id}/${endpoint}`,
        body,
      );
      await this.refresh(this.app()!.id);
      this.notice.set('Operation completed.');
    });
  }
  async createBranch(): Promise<void> {
    await this.operation('branches', {
      branch: this.newBranch,
      commit: this.snapshot()?.commit,
    });
    if (!this.error()) {
      this.branch = this.newBranch;
      this.newBranch = '';
      this.snapshot.update((snapshot) =>
        snapshot ? { ...snapshot, branch: this.branch } : null,
      );
      this.rememberDraft();
    }
  }
  async saveSettings(): Promise<void> {
    await this.action(async () => {
      await this.api.patch(
        `/api/hosted-applications/${this.app()!.id}`,
        this.settings,
      );
      await this.refresh(this.app()!.id);
      this.notice.set(
        'Settings saved. Repair the workflow after changing build configuration.',
      );
    });
  }
  async checkSetup(): Promise<void> {
    await this.action(async () => {
      const health = await this.api.get<{ state: string; message: string }>(
        `/api/hosted-applications/${this.app()!.id}/health`,
      );
      this.notice.set(`${health.state}: ${health.message}`);
    });
  }
  buildLabel(id: string | null): string {
    const build = this.app()?.builds.find((item) => item.id === id);
    const user = this.app()?.collaborators.find(
      (member) => member.userId === build?.requestedByUserId,
    )?.user;
    const label =
      build?.requestedByUserId === this.auth.currentUser()?.id
        ? 'you'
        : user?.displayName ||
          user?.email ||
          (build?.githubActor
            ? 'GitHub ' + build.githubActor
            : build?.requestedByUserId);
    return build
      ? `${build.branch} · ${build.commit.slice(0, 8)} · ${build.status}${label ? ' · requested by ' + label : ''}`
      : 'None';
  }
  patientLabel(patient: LaunchResource): string {
    const name = patient.name?.[0];
    return `${name?.text || [...(name?.given || []), name?.family].filter(Boolean).join(' ') || 'Patient'} (${patient.id})`;
  }
  async launchChoices(): Promise<void> {
    await this.action(async () => {
      this.patients.set([]);
      this.encounters.set([]);
      this.personas.set([]);
      this.test.patient = '';
      this.test.encounter = '';
      this.test.persona = '';
      const sandbox = this.sandbox
        .sandboxes()
        .find((item) => item.sandboxId === this.test.sandbox);
      if (!sandbox) return;
      const personas = await this.api.get<{ personas: UserPersona[] }>(
        `/api/sandboxes/${sandbox.sandboxId}/personas`,
      );
      this.personas.set(personas.personas);
      await this.searchPatients();
    });
  }
  async searchPatients(): Promise<void> {
    const sandbox = this.sandbox
      .sandboxes()
      .find((item) => item.sandboxId === this.test.sandbox);
    if (!sandbox) return;
    const result = await this.api.get<{
      entry?: Array<{ resource: LaunchResource }>;
    }>(
      `/api/sandboxes/${sandbox.sandboxId}/fhir/${sandbox.fhirVersion.toLowerCase()}/Patient?_count=50${this.patientSearch ? '&name=' + encodeURIComponent(this.patientSearch) : ''}`,
    );
    this.patients.set((result.entry || []).map((item) => item.resource));
  }
  async patientChanged(): Promise<void> {
    await this.action(async () => {
      this.test.encounter = '';
      this.encounters.set([]);
      const sandbox = this.sandbox
        .sandboxes()
        .find((item) => item.sandboxId === this.test.sandbox);
      if (!sandbox || !this.test.patient) return;
      const result = await this.api.get<{
        entry?: Array<{ resource: LaunchResource }>;
      }>(
        `/api/sandboxes/${sandbox.sandboxId}/fhir/${sandbox.fhirVersion.toLowerCase()}/Encounter?_count=50&patient=${encodeURIComponent(this.test.patient)}`,
      );
      this.encounters.set((result.entry || []).map((item) => item.resource));
    });
  }
  async collaborator(): Promise<void> {
    await this.action(async () => {
      await this.api.put(
        `/api/hosted-applications/${this.app()!.id}/collaborators`,
        { email: this.memberEmail, role: this.memberRole },
      );
      await this.refresh(this.app()!.id);
      this.memberEmail = '';
    });
  }
  async removeCollaborator(userId: string): Promise<void> {
    await this.action(async () => {
      await this.api.delete(
        `/api/hosted-applications/${this.app()!.id}/collaborators/${userId}`,
      );
      await this.refresh(this.app()!.id);
    });
  }
  async remove(): Promise<void> {
    if (
      !confirm(
        'Delete this application and stop hosting its preview and published files? The GitHub repository will remain.',
      )
    )
      return;
    await this.action(async () => {
      await this.api.delete(`/api/hosted-applications/${this.app()!.id}`);
      this.app.set(null);
      this.apps.set((await this.api.list()).applications);
    });
  }
  async launch(channel: 'preview' | 'published' = 'preview'): Promise<void> {
    await this.action(async () => {
      const app = this.app()!;
      const sandbox = this.sandbox
        .sandboxes()
        .find((s) => s.sandboxId === this.test.sandbox);
      if (!sandbox) throw Error('Choose an accessible sandbox.');
      const context = await this.api.post<{ launch: string }>(
        `/api/sandboxes/${sandbox.sandboxId}/launch-context`,
        {
          clientId: `hosted-${app.id}-${channel}`,
          scope:
            app.builds.find(
              (build) =>
                build.id ===
                (channel === 'preview'
                  ? app.previewBuildId
                  : app.publishedBuildId),
            )?.scope || app.scope,
          patientFhirId: this.test.patient || null,
          encounterFhirId: this.test.encounter || null,
          userPersonaId: this.test.persona || null,
        },
      );
      const url = new URL(
        channel === 'preview' ? app.previewUrl : app.publishedUrl,
      );
      url.searchParams.set(
        'iss',
        `${window.location.origin}/api/sandboxes/${sandbox.sandboxId}/fhir/${sandbox.fhirVersion.toLowerCase()}`,
      );
      url.searchParams.set('launch', context.launch);
      this.previewSrc.set(
        this.sanitizer.bypassSecurityTrustResourceUrl(url.toString()),
      );
      if (channel === 'preview') this.reviewedPreviewId.set(app.previewBuildId);
    });
  }
}
