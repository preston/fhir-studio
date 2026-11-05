import {
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from "@angular/core";
import { DatePipe, KeyValuePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { RouterLink, ActivatedRoute } from "@angular/router";
import { HttpErrorResponse } from "@angular/common/http";
import { DomSanitizer, type SafeResourceUrl } from "@angular/platform-browser";
import { firstValueFrom } from "rxjs";
import type {
  GitHubConnectionStatus,
  HostedApplication,
  SmartLaunchContextResponse,
} from "@fhir-studio/core";
import {
  HostingService,
  type GitHubRepository,
} from "../core/services/hosting.service.js";
import { SandboxService } from "../core/services/sandbox.service.js";
import { AuthService } from "../core/services/auth.service.js";
import type { UserPersona } from "../core/services/personas.service.js";
import { HostingUsageComponent } from "./hosting-usage.component.js";

interface LaunchResource {
  id?: string;
  name?: Array<{ text?: string; given?: string[]; family?: string }>;
  status?: string;
}

@Component({
  selector: "app-hosted-applications",
  standalone: true,
  imports: [
    FormsModule,
    RouterLink,
    HostingUsageComponent,
    DatePipe,
    KeyValuePipe,
  ],
  templateUrl: "./hosted-applications.component.html",
  styleUrl: "./hosted-applications.component.scss",
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

  readonly apps = signal<HostedApplication[]>([]);
  readonly app = signal<HostedApplication | null>(null);
  readonly connection = signal<GitHubConnectionStatus | null>(null);
  readonly githubReady = computed(
    () => this.connection()?.status === "CONNECTED",
  );
  readonly artifactBacked = computed(
    () => this.app()?.sourceKind === "artifact",
  );
  readonly integrationManaged = computed(() => !!this.app()?.integrationOrigin);
  readonly publishedRevision = computed(() =>
    this.app()?.builds.find(
      (revision) => revision.id === this.app()?.publishedBuildId,
    ),
  );
  readonly applicationTabs = computed(() =>
    this.artifactBacked()
      ? ["Overview", "Launch", "Deployments", "Usage", "Collaborators"]
      : [
          "Overview",
          "Launch",
          "Deployments",
          "Usage",
          "Collaborators",
          "Settings",
        ],
  );
  readonly repos = signal<GitHubRepository[]>([]);
  readonly tab = signal("Overview");
  readonly filter = signal("Owned");
  readonly creating = signal(false);
  readonly loaded = signal(false);
  readonly error = signal("");
  readonly notice = signal("");
  readonly busy = signal(false);
  readonly launchSrc = signal<SafeResourceUrl | null>(null);
  readonly patients = signal<LaunchResource[]>([]);
  readonly encounters = signal<LaunchResource[]>([]);
  readonly personas = signal<UserPersona[]>([]);
  readonly visibleApps = computed(() =>
    this.apps().filter((application) =>
      this.filter() === "Shared"
        ? application.ownerUserId !== this.auth.currentUser()?.id
        : application.ownerUserId === this.auth.currentUser()?.id,
    ),
  );

  form = {
    name: "",
    repositoryId: "",
    installationId: "",
    branch: "main",
    staticDirectory: "",
    launchPath: "index.html",
    callbackPath: "index.html",
    scope: "launch launch/patient openid fhirUser patient/*.rs",
  };
  settings = {
    name: "",
    description: "",
    branch: "",
    staticDirectory: "",
    launchPath: "",
    callbackPath: "",
    scope: "",
  };
  branch = "";
  memberEmail = "";
  memberRole = "READ_WRITE";
  transferEmail = "";
  patientSearch = "";
  test = { sandbox: "", patient: "", encounter: "", persona: "" };
  publicAcknowledged = false;

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

  ngOnInit(): void {
    try {
      const draft = JSON.parse(
        sessionStorage.getItem("studio-app-wizard") || "{}",
      ) as Partial<typeof this.form>;
      // Read only deployment fields from older wizard drafts.
      for (const key of Object.keys(this.form) as Array<
        keyof typeof this.form
      >) {
        if (typeof draft[key] === "string") this.form[key] = draft[key];
      }
    } catch {
      /* Ignore an invalid local draft. */
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
        : "Operation failed. Please retry.";
  }

  async action(work: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
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
      const selected = this.route.snapshot.queryParamMap.get("app");
      const initial =
        selected || this.visibleApps()[0]?.id || this.apps()[0]?.id;
      if (initial) await this.open(initial);
      else this.creating.set(true);
      this.connection.set(await this.api.connection());
      const installed = this.route.snapshot.queryParamMap.get("installation");
      if (installed) {
        this.form.installationId = installed;
        this.creating.set(true);
      } else if (
        !this.form.installationId &&
        this.connection()?.installations?.length === 1
      ) {
        this.form.installationId = String(
          this.connection()!.installations![0].id,
        );
      }
      if (this.route.snapshot.queryParamMap.get("githubSetup") === "pending") {
        this.notice.set(
          "Repository access is awaiting organization approval. Complete approval on GitHub, then refresh this page.",
        );
      }
      const launchRequested =
        this.route.snapshot.queryParamMap.get("tab") === "Launch";
      const targetSandbox = this.route.snapshot.queryParamMap.get("sandbox");
      if (selected && launchRequested) {
        if (!this.sandbox.sandboxes().length)
          await firstValueFrom(this.sandbox.getSandboxes());
        if (
          targetSandbox &&
          this.sandbox
            .sandboxes()
            .some((item) => item.sandboxId === targetSandbox)
        )
          this.test.sandbox = targetSandbox;
        this.tab.set("Launch");
        this.notice.set(
          "Choose patient, encounter, and persona context, then launch this application. Clinical context stays in Studio.",
        );
      }
    });
    this.loaded.set(true);
    if (this.form.installationId && this.githubReady())
      await this.repositories();
    const launchRequested =
      this.route.snapshot.queryParamMap.get("tab") === "Launch";
    if (launchRequested && this.app() && this.test.sandbox)
      await this.launchChoices();
  }

  startCreate(): void {
    this.creating.set(true);
    this.launchSrc.set(null);
    this.error.set("");
    this.notice.set("");
  }

  rememberWizard(): void {
    sessionStorage.setItem("studio-app-wizard", JSON.stringify(this.form));
  }

  async installationChanged(): Promise<void> {
    this.form.repositoryId = "";
    this.repos.set([]);
    this.rememberWizard();
    if (this.form.installationId) await this.repositories();
  }

  async repositories(): Promise<void> {
    if (!this.form.installationId || !this.githubReady()) return;
    this.rememberWizard();
    await this.action(async () => {
      const repositories: GitHubRepository[] = [];
      for (let page = 1; page <= 100; page++) {
        const result = await this.api.get<{ repositories: GitHubRepository[] }>(
          `/api/github/repositories?installation=${encodeURIComponent(this.form.installationId)}&page=${page}`,
        );
        repositories.push(...result.repositories);
        if (result.repositories.length < 100) break;
      }
      this.repos.set(repositories);
      if (
        this.form.repositoryId &&
        !repositories.some((repo) => String(repo.id) === this.form.repositoryId)
      )
        this.form.repositoryId = "";
    });
  }

  repositoryChanged(): void {
    const repository = this.repos().find(
      (repo) => String(repo.id) === this.form.repositoryId,
    );
    if (repository) {
      this.form.branch = repository.default_branch;
      if (!this.form.name) this.form.name = repository.full_name.split("/")[1];
    }
    this.rememberWizard();
  }

  async create(): Promise<void> {
    await this.action(async () => {
      const application = await this.api.post<HostedApplication>(
        "/api/hosted-applications",
        this.form,
      );
      await this.open(application.id);
      this.apps.set((await this.api.list()).applications);
      this.form = {
        name: "",
        repositoryId: "",
        installationId: this.form.installationId,
        branch: "main",
        staticDirectory: "",
        launchPath: "index.html",
        callbackPath: "index.html",
        scope: "launch launch/patient openid fhirUser patient/*.rs",
      };
      this.publicAcknowledged = false;
      sessionStorage.removeItem("studio-app-wizard");
      this.notice.set(
        "Application added for deployment. Select Deploy to copy the committed static files from your repository.",
      );
    });
  }

  async selectProject(id: string): Promise<void> {
    await this.action(() => this.open(id));
  }

  async open(id: string): Promise<void> {
    const application = await this.api.application(id);
    this.app.set(application);
    this.creating.set(false);
    this.branch = application.branch;
    this.launchSrc.set(null);
    this.settings = {
      name: application.name,
      description: application.description,
      branch: application.branch,
      staticDirectory: this.staticDirectory(application),
      launchPath: application.launchPath,
      callbackPath: application.callbackPath,
      scope: application.scope,
    };
    this.test.sandbox = this.sandbox.activeSandbox()?.sandboxId || "";
    this.tab.set("Overview");
  }

  async refresh(id: string): Promise<void> {
    try {
      const application = await this.api.application(id);
      if (this.app()?.id === id) {
        if (application.publishedBuildId !== this.app()?.publishedBuildId) {
          this.launchSrc.set(null);
        }
        this.app.set(application);
      }
      this.apps.update((applications) =>
        applications.map((item) => (item.id === id ? application : item)),
      );
    } catch {
      /* Preserve the current view during a temporary outage. */
    }
  }

  staticDirectory(application: HostedApplication): string {
    return (
      application.staticDirectory ??
      [application.projectDirectory, application.outputDirectory]
        .filter(Boolean)
        .join("/")
    );
  }

  applicationStatus(application: HostedApplication): string {
    if (application.suspended) return "Suspended";
    const current = application.builds.find(
      (revision) => revision.id === application.desiredBuildId,
    );
    if (
      current &&
      ["WAITING", "BUILDING", "IMPORTING"].includes(current.status)
    )
      return "Deploying";
    if (application.publishedBuildId) return "Published";
    if (current?.status === "FAILED") return "Deployment failed";
    return "Not deployed";
  }

  deploymentStatus(status: string): string {
    return (
      (
        {
          WAITING: "Queued",
          BUILDING: "Preparing files",
          IMPORTING: "Deploying",
          READY: "Ready",
          FAILED: "Failed",
          CANCELED: "Cancelled",
        } as Record<string, string>
      )[status] || status
    );
  }

  deploymentBadge(status: string): string {
    return status === "READY"
      ? "text-bg-success"
      : status === "FAILED"
        ? "text-bg-danger"
        : ["WAITING", "BUILDING", "IMPORTING"].includes(status)
          ? "text-bg-primary"
          : "text-bg-secondary";
  }

  revisionLabel(id: string | null): string {
    const revision = this.app()?.builds.find((item) => item.id === id);
    return revision
      ? `${revision.branch} · ${revision.commit.slice(0, 8) || "Pending"} · ${this.deploymentStatus(revision.status)}`
      : "No deployment yet";
  }

  async deploy(): Promise<void> {
    await this.action(async () => {
      const application = this.app()!;
      await this.api.post(
        `/api/hosted-applications/${application.id}/deployments`,
        { branch: this.branch || application.branch },
      );
      await this.refresh(application.id);
      this.tab.set("Deployments");
      this.notice.set(
        "Deployment queued. Studio is copying the static files from the selected repository revision.",
      );
    });
  }

  async operation(endpoint: string, body: unknown = {}): Promise<void> {
    await this.action(async () => {
      await this.api.post(
        `/api/hosted-applications/${this.app()!.id}/${endpoint}`,
        body,
      );
      await this.refresh(this.app()!.id);
      this.notice.set("Application updated.");
    });
  }

  async saveSettings(): Promise<void> {
    await this.action(async () => {
      await this.api.patch(
        `/api/hosted-applications/${this.app()!.id}`,
        this.settings,
      );
      await this.refresh(this.app()!.id);
      this.branch = this.settings.branch;
      this.apps.set((await this.api.list()).applications);
      this.notice.set(
        "Settings saved. Deploy again to apply changes to hosted files and SMART launch settings.",
      );
    });
  }

  async checkSetup(): Promise<void> {
    await this.action(async () => {
      const result = await this.api.get<{ state: string; message: string }>(
        `/api/hosted-applications/${this.app()!.id}/health`,
      );
      this.notice.set(result.message);
    });
  }

  patientLabel(patient: LaunchResource): string {
    const name = patient.name?.[0];
    return `${name?.text || [...(name?.given || []), name?.family].filter(Boolean).join(" ") || "Patient"} (${patient.id})`;
  }

  async launchChoices(): Promise<void> {
    await this.action(async () => {
      this.patients.set([]);
      this.encounters.set([]);
      this.personas.set([]);
      this.test.patient = "";
      this.test.encounter = "";
      this.test.persona = "";
      const sandbox = this.sandbox
        .sandboxes()
        .find((item) => item.sandboxId === this.test.sandbox);
      if (!sandbox) return;
      this.personas.set(
        (
          await this.api.get<{ personas: UserPersona[] }>(
            `/api/sandboxes/${sandbox.sandboxId}/personas`,
          )
        ).personas,
      );
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
      `/api/sandboxes/${sandbox.sandboxId}/fhir/${sandbox.fhirVersion.toLowerCase()}/Patient?_count=50${this.patientSearch ? "&name=" + encodeURIComponent(this.patientSearch) : ""}`,
    );
    this.patients.set((result.entry || []).map((item) => item.resource));
  }

  async patientChanged(): Promise<void> {
    await this.action(async () => {
      this.test.encounter = "";
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
      this.memberEmail = "";
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
        "Delete this application and stop hosting its files? The source repository or catalog release will remain.",
      )
    )
      return;
    await this.action(async () => {
      await this.api.delete(`/api/hosted-applications/${this.app()!.id}`);
      this.app.set(null);
      this.apps.set((await this.api.list()).applications);
      this.creating.set(!this.apps().length);
    });
  }

  async launch(): Promise<void> {
    await this.action(async () => {
      const application = this.app()!;
      const sandbox = this.sandbox
        .sandboxes()
        .find((item) => item.sandboxId === this.test.sandbox);
      if (!sandbox) throw new Error("Choose an accessible sandbox.");
      const context = await this.api.post<SmartLaunchContextResponse>(
        `/api/sandboxes/${sandbox.sandboxId}/launch-context`,
        {
          clientId: `hosted-${application.id}-published`,
          scope:
            application.builds.find(
              (revision) => revision.id === application.publishedBuildId,
            )?.scope || application.scope,
          patientFhirId: this.test.patient || null,
          encounterFhirId: this.test.encounter || null,
          userPersonaId: this.test.persona || null,
        },
      );
      const url = new URL(application.publishedUrl);
      url.searchParams.set("iss", context.iss);
      url.searchParams.set("launch", context.launch);
      this.launchSrc.set(
        this.sanitizer.bypassSecurityTrustResourceUrl(url.toString()),
      );
    });
  }
}
