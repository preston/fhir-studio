import { Component, OnInit, DestroyRef, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type {
  HostingAction,
  HostingActionPreview,
  HostingActionRequest,
  HostingInventoryItem,
  HostingInventoryReport,
  HostingOwnerReport,
  BackgroundJob,
} from '@fhir-studio/core';
import { HostingService } from '../../core/services/hosting.service.js';
import {
  HostingUsageComponent,
  hostingBytes,
} from '../../applications/hosting-usage.component.js';
interface AuditRecord {
  id: string;
  applicationId: string | null;
  userId: string | null;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}
interface StorageReport {
  allocatedBytes: string;
  reservedBytes: string;
  trashBytes: string;
  budgetBytes: number;
  freeBytes: string;
  inspection: { output: Record<string, unknown>; completedAt: string } | null;
}
@Component({
  selector: 'app-admin-hosting',
  standalone: true,
  imports: [CommonModule, FormsModule, HostingUsageComponent],
  template: `
    <div class="d-flex flex-wrap justify-content-between gap-2 mb-3">
      <div>
        <h3>Application Hosting</h3>
        <p class="text-muted mb-0">
          Manage hosted applications, usage, storage, ownership and recovery.
        </p>
      </div>
      <button
        class="btn btn-outline-secondary"
        (click)="load()"
        [disabled]="busy()"
      >
        Refresh
      </button>
    </div>
    <ul class="nav nav-pills mb-3">
      @for (t of tabs; track t) {
        <li class="nav-item">
          <button
            class="nav-link"
            [class.active]="tab() === t"
            (click)="changeTab(t)"
          >
            {{ t }}
          </button>
        </li>
      }
    </ul>
    @if (error()) {
      <div class="alert alert-danger">{{ error() }}</div>
    }
    @if (notice()) {
      <div class="alert alert-info">{{ notice() }}</div>
    }
    @if (job(); as j) {
      <div class="card card-body mb-3">
        <strong>{{ j.name }} · {{ j.status }} · {{ j.progress }}%</strong>
        <div>{{ j.stage }}</div>
        @if (j.error) {
          <div class="text-danger">{{ j.error }}</div>
        }
        @if (j.status === 'completed' || j.status === 'failed') {
          <pre class="small mb-0">{{ j.output | json }}</pre>
        }
      </div>
    }
    @if (tab() === 'Inventory' || tab() === 'Health' || tab() === 'Trash') {
      <div class="d-flex flex-wrap gap-2 mb-3">
        <input
          class="form-control"
          style="max-width: 280px"
          placeholder="Application, repository or owner"
          [(ngModel)]="search"
          (keyup.enter)="filter()"
          aria-label="Search applications"
        />
        @if (tab() === 'Inventory') {
          <select
            class="form-select"
            style="max-width: 180px"
            [(ngModel)]="status"
            (ngModelChange)="filter()"
          >
            <option value="active">All active</option>
            <option value="published">Published</option>
            <option value="suspended">Suspended</option>
            <option value="stale">Stale candidates</option>
            <option value="all">Including trash</option>
          </select>
        }
        <select
          class="form-select"
          style="max-width: 200px"
          [(ngModel)]="sortBy"
          (ngModelChange)="filter()"
        >
          <option value="createdAt">Creation date</option>
          <option value="name">Name</option>
          <option value="lastDeveloperActivityAt">Developer activity</option>
          <option value="lastServedAt">Last document response</option>
          <option value="lastReconciledAt">Reconciliation</option>
        </select>
        <select
          class="form-select"
          style="max-width: 140px"
          [(ngModel)]="sortOrder"
          (ngModelChange)="filter()"
        >
          <option value="desc">Descending</option>
          <option value="asc">Ascending</option>
        </select>
        <button class="btn btn-outline-primary" (click)="filter()">
          Search</button
        ><a class="btn btn-outline-secondary" [href]="inventoryUrl(true)"
          >Export CSV</a
        >
      </div>
      @if (tab() === 'Trash') {
        <p class="alert alert-warning">
          Trash retains deployed content for 30 days. Restoring reinstates prior
          publication and suspension state. Permanent purge also removes
          application metadata; traffic and audit history remain.
        </p>
      }
      <div class="table-responsive">
        <table class="table table-striped align-middle">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  class="form-check-input"
                  (change)="selectAll($event)"
                  aria-label="Select this page"
                />
              </th>
              <th>Application / repository</th>
              <th>Owner</th>
              <th>State</th>
              <th>Activity (local)</th>
              <th>Storage / sandboxes</th>
              <th>Health</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            @for (a of inventory().applications; track a.id) {
              <tr>
                <td>
                  <input
                    type="checkbox"
                    class="form-check-input"
                    [checked]="selected().includes(a.id)"
                    (change)="select(a.id)"
                    [attr.aria-label]="'Select ' + a.name"
                  />
                </td>
                <td>
                  <strong>{{ a.name }}</strong>
                  <div class="small text-muted">{{ a.repository }}</div>
                  @if (a.cleanupProtected) {
                    <span class="badge text-bg-info">Cleanup protected</span>
                  }
                </td>
                <td>
                  {{ a.owner.displayName || a.owner.email || a.ownerUserId }}
                </td>
                <td>
                  {{
                    a.deletedAt
                      ? 'Trash'
                      : a.suspended
                        ? 'Suspended'
                        : a.publishedBuildId
                          ? 'Published'
                          : 'Preview / draft'
                  }}
                  @if (a.deleteAfter) {
                    <div class="small">
                      Purge after {{ a.deleteAfter | date: 'medium' }}
                    </div>
                  }
                </td>
                <td class="small">
                  Developer: {{ a.lastDeveloperActivityAt | date: 'short'
                  }}<br />Served: {{ a.lastServedAt | date: 'short'
                  }}<br />Launch: {{ a.lastLaunchAt | date: 'short' }}
                </td>
                <td>
                  {{ bytes(a.storageBytes) }}
                  <div class="small">
                    Reserved {{ bytes(a.reservedBytes) }} ·
                    {{ a.sandboxCount }} sandboxes
                  </div>
                </td>
                <td class="small">
                  @for (issue of a.issues; track issue) {
                    <div class="text-danger">{{ issue }}</div>
                  }
                  @if (a.abandonmentCandidate) {
                    <span class="badge text-bg-warning">Stale candidate</span>
                  }
                  <div>{{ a.latestBuild?.status }}</div>
                </td>
                <td>
                  <button
                    class="btn btn-sm btn-outline-primary"
                    (click)="inspect(a)"
                  >
                    Inspect
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="d-flex gap-2 align-items-center mb-3">
        <button
          class="btn btn-sm btn-outline-secondary"
          (click)="pageChange(-1)"
          [disabled]="page <= 1"
        >
          Previous</button
        ><span>{{ inventory().total }} applications · Page {{ page }}</span
        ><button
          class="btn btn-sm btn-outline-secondary"
          (click)="pageChange(1)"
          [disabled]="page * 25 >= inventory().total"
        >
          Next
        </button>
      </div>
      <div class="card card-body">
        <h5>Manage selected applications ({{ selected().length }})</h5>
        <div class="row g-2">
          <label class="col-md-3 form-label"
            >Action<select
              class="form-select"
              [(ngModel)]="action"
              (ngModelChange)="preview.set(null)"
            >
              @for (a of actions; track a) {
                <option [value]="a">{{ a }}</option>
              }
            </select></label
          >
          <label class="col form-label"
            >Administrative reason<input
              class="form-control"
              [(ngModel)]="reason"
              maxlength="2000"
              (ngModelChange)="preview.set(null)"
          /></label>
          @if (action === 'reassign') {
            <label class="col form-label"
              >New owner UUID<input
                class="form-control"
                [(ngModel)]="newOwnerId"
                (ngModelChange)="preview.set(null)"
            /></label>
          }
        </div>
        <button
          class="btn btn-outline-primary align-self-start"
          (click)="previewAction()"
          [disabled]="busy() || !selected().length || !reason.trim()"
        >
          Preview impact
        </button>
        @if (preview(); as p) {
          <div class="border rounded p-3 mt-3">
            <strong
              >{{ action }} · {{ p.applications.length }} applications ·
              {{ bytes(p.storageBytes) }} allocated</strong
            >
            <ul>
              @for (a of p.applications; track a.id) {
                <li>
                  {{ a.name }} · {{ bytes(a.storageBytes) }}
                  @if (a.error) {
                    <span class="text-danger">{{ a.error }}</span>
                  }
                </li>
              }
            </ul>
            <p>{{ reason }}</p>
            <button
              class="btn"
              [class.btn-danger]="action === 'purge' || action === 'trash'"
              [class.btn-primary]="action !== 'purge' && action !== 'trash'"
              (click)="execute()"
              [disabled]="busy() || previewHasErrors()"
            >
              Confirm {{ action }}</button
            ><button class="btn btn-link" (click)="preview.set(null)">
              Cancel
            </button>
          </div>
        }
      </div>
      @if (detail(); as d) {
        <div class="card card-body mt-3">
          <div class="d-flex justify-content-between">
            <h5>{{ detailName }}</h5>
            <button
              class="btn-close"
              (click)="detail.set(null)"
              aria-label="Close details"
            ></button>
          </div>
          <pre class="small" style="max-height: 400px; overflow: auto">{{
            d | json
          }}</pre>
          <div class="d-flex gap-2">
            <button
              class="btn btn-outline-primary"
              (click)="showUsage(detailId)"
            >
              Usage</button
            ><button
              class="btn btn-outline-secondary"
              (click)="applicationAudit(detailId)"
            >
              Audit history
            </button>
          </div>
        </div>
      }
    }
    @if (tab() === 'Usage') {
      <div class="mb-3">
        <label class="form-label"
          >Application UUID (empty for instance traffic)<input
            class="form-control"
            [(ngModel)]="usageId"
            (keyup.enter)="applyUsage()" /></label
        ><button class="btn btn-outline-primary ms-2" (click)="applyUsage()">
          Apply
        </button>
      </div>
      <app-hosting-usage
        [administrative]="true"
        [applicationId]="usageApplicationId()"
      />
    }
    @if (tab() === 'Storage') {
      @if (storage(); as s) {
        <div class="row g-3 mb-3">
          @for (c of storageCards(s); track c.label) {
            <div class="col-md-4">
              <div class="card card-body">
                <span class="text-muted">{{ c.label }}</span
                ><strong class="fs-4">{{ bytes(c.value) }}</strong>
              </div>
            </div>
          }
        </div>
        <h5>Latest storage inspection</h5>
        @if (s.inspection) {
          <p>{{ s.inspection.completedAt | date: 'medium' }}</p>
          <pre>{{ s.inspection.output | json }}</pre>
        } @else {
          <p>No completed inspection yet.</p>
        }
        <p class="text-muted">
          Import reservations and retained trash count toward storage. Use Jobs
          & Workers schedules to inspect or clean files.
        </p>
        <a class="btn btn-outline-primary" href="/administration/jobs"
          >Jobs & Workers</a
        >
      }
    }
    @if (tab() === 'Owners & quotas') {
      <div class="d-flex gap-2 mb-3">
        <input
          class="form-control"
          placeholder="Find users by name or email"
          [(ngModel)]="ownerSearch"
          (keyup.enter)="ownerPage = 1; load()"
          aria-label="Search owners"
        /><button
          class="btn btn-outline-primary"
          (click)="ownerPage = 1; load()"
        >
          Search</button
        ><a class="btn btn-outline-secondary" [href]="ownersUrl(true)"
          >Export CSV</a
        >
      </div>
      <div class="table-responsive">
        <table class="table table-striped">
          <thead>
            <tr>
              <th>Owner</th>
              <th>Applications / limit</th>
              <th>Storage / limit</th>
              <th>Reserved / trash</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (o of owners(); track o.userId) {
              <tr>
                <td>
                  {{ o.displayName || o.email || o.userId }}
                  <div class="small font-monospace">{{ o.userId }}</div>
                  @if (o.isSuspended) {
                    <span class="badge text-bg-warning">Suspended</span>
                  }
                </td>
                <td>
                  {{ o.applications }} / {{ o.effectiveApplicationLimit }}
                  {{ o.applicationLimit === null ? '(inherited)' : '' }}
                </td>
                <td>
                  {{ bytes(o.storageBytes) }} /
                  {{
                    o.storageBytesLimit === null
                      ? 'Instance budget'
                      : bytes(o.storageBytesLimit)
                  }}
                </td>
                <td>
                  {{ bytes(o.reservedBytes) }} / {{ bytes(o.trashBytes) }}
                </td>
                <td>
                  <button
                    class="btn btn-sm btn-outline-primary"
                    (click)="editQuota(o)"
                  >
                    Edit quota
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="d-flex gap-2 mb-3">
        <button
          class="btn btn-sm btn-outline-secondary"
          (click)="ownerPage = ownerPage - 1; load()"
          [disabled]="ownerPage <= 1"
        >
          Previous</button
        ><span>{{ ownerTotal }} users · Page {{ ownerPage }}</span
        ><button
          class="btn btn-sm btn-outline-secondary"
          (click)="ownerPage = ownerPage + 1; load()"
          [disabled]="ownerPage * 25 >= ownerTotal"
        >
          Next
        </button>
      </div>
      @if (quotaOwner(); as o) {
        <div class="card card-body">
          <h5>Quota for {{ o.displayName || o.email }}</h5>
          <label class="form-label"
            >Application limit (empty inherits)<input
              class="form-control"
              type="number"
              min="0"
              [(ngModel)]="quotaApps" /></label
          ><label class="form-label"
            >Storage limit in bytes (empty uses instance budget)<input
              class="form-control"
              inputmode="numeric"
              [(ngModel)]="quotaStorage" /></label
          ><label class="form-label"
            >Reason<input
              class="form-control"
              [(ngModel)]="quotaReason"
              maxlength="2000"
          /></label>
          <p class="small text-muted">
            Existing applications continue serving if a new limit is below
            current usage. Additional allocations will be blocked.
          </p>
          <div>
            <button
              class="btn btn-primary"
              (click)="saveQuota()"
              [disabled]="busy() || !quotaReason.trim()"
            >
              Save quota</button
            ><button class="btn btn-link" (click)="quotaOwner.set(null)">
              Cancel
            </button>
          </div>
        </div>
      }
    }
    @if (tab() === 'Audit') {
      <div class="d-flex flex-wrap gap-2 mb-3">
        <label
          >From (UTC)<input
            class="form-control"
            type="date"
            [(ngModel)]="auditFrom" /></label
        ><label
          >Through (UTC)<input
            class="form-control"
            type="date"
            [(ngModel)]="auditThrough" /></label
        ><label
          >Application UUID<input
            class="form-control"
            [(ngModel)]="auditId" /></label
        ><label
          >Action<input class="form-control" [(ngModel)]="auditAction" /></label
        ><button
          class="btn btn-outline-primary align-self-end"
          (click)="auditPage = 1; load()"
        >
          Search</button
        ><a
          class="btn btn-outline-secondary align-self-end"
          [href]="auditUrl(true)"
          >Export CSV</a
        >
      </div>
      <div class="table-responsive">
        <table class="table">
          <thead>
            <tr>
              <th>Date (local)</th>
              <th>Application / actor</th>
              <th>Action / detail</th>
            </tr>
          </thead>
          <tbody>
            @for (r of audit(); track r.id) {
              <tr>
                <td>{{ r.createdAt | date: 'medium' }}</td>
                <td class="small">
                  {{ r.applicationId }}<br />{{ r.userId || 'System' }}
                </td>
                <td>
                  {{ r.action }}
                  <pre class="small text-wrap">{{ r.detail | json }}</pre>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      <div class="d-flex gap-2">
        <button
          class="btn btn-sm btn-outline-secondary"
          (click)="auditPage = auditPage - 1; load()"
          [disabled]="auditPage <= 1"
        >
          Previous</button
        ><span>{{ auditTotal }} records · Page {{ auditPage }}</span
        ><button
          class="btn btn-sm btn-outline-secondary"
          (click)="auditPage = auditPage + 1; load()"
          [disabled]="auditPage * 25 >= auditTotal"
        >
          Next
        </button>
      </div>
    }
  `,
})
export class AdminHostingComponent implements OnInit {
  private readonly api = inject(HostingService);
  private readonly destroy = inject(DestroyRef);
  readonly tabs = [
    'Inventory',
    'Usage',
    'Storage',
    'Health',
    'Owners & quotas',
    'Audit',
    'Trash',
  ];
  readonly actions: HostingAction[] = [
    'suspend',
    'resume',
    'unpublish',
    'trash',
    'restore',
    'purge',
    'protect',
    'unprotect',
    'reassign',
  ];
  readonly tab = signal('Inventory');
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  readonly inventory = signal<HostingInventoryReport>({
    applications: [],
    total: 0,
    page: 1,
    limit: 25,
  });
  readonly selected = signal<string[]>([]);
  readonly preview = signal<HostingActionPreview | null>(null);
  readonly owners = signal<HostingOwnerReport[]>([]);
  readonly quotaOwner = signal<HostingOwnerReport | null>(null);
  readonly storage = signal<StorageReport | null>(null);
  readonly audit = signal<AuditRecord[]>([]);
  readonly detail = signal<unknown>(null);
  readonly job = signal<BackgroundJob | null>(null);
  readonly usageApplicationId = signal('');
  readonly bytes = hostingBytes;
  search = '';
  status = 'active';
  sortBy = 'createdAt';
  sortOrder = 'desc';
  page = 1;
  action: HostingAction = 'suspend';
  reason = '';
  newOwnerId = '';
  usageId = '';
  detailId = '';
  detailName = '';
  ownerSearch = '';
  ownerPage = 1;
  ownerTotal = 0;
  quotaApps: number | null = null;
  quotaStorage = '';
  quotaReason = '';
  auditId = '';
  auditAction = '';
  auditPage = 1;
  auditTotal = 0;
  auditFrom = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  auditThrough = new Date().toISOString().slice(0, 10);
  private polling?: ReturnType<typeof setInterval>;
  ngOnInit(): void {
    this.destroy.onDestroy(() => {
      if (this.polling) clearInterval(this.polling);
    });
    void this.load();
  }
  changeTab(t: string): void {
    this.tab.set(t);
    this.page = 1;
    this.selected.set([]);
    this.preview.set(null);
    void this.load();
  }
  filter(): void {
    this.page = 1;
    this.selected.set([]);
    this.preview.set(null);
    void this.load();
  }
  pageChange(delta: number): void {
    this.page += delta;
    this.selected.set([]);
    this.preview.set(null);
    void this.load();
  }
  inventoryUrl(exporting = false): string {
    const p = new URLSearchParams({
      search: this.search,
      status:
        this.tab() === 'Trash'
          ? 'trash'
          : this.tab() === 'Health'
            ? 'problem'
            : this.status,
      page: String(exporting ? 1 : this.page),
      limit: String(exporting ? 10000 : 25),
      sortBy: this.sortBy,
      sortOrder: this.sortOrder,
      ...(exporting ? { format: 'csv' } : {}),
    });
    return `/api/administration/hosting/applications?${p}`;
  }
  ownersUrl(exporting = false): string {
    return `/api/administration/hosting/owners?${new URLSearchParams({ search: this.ownerSearch, page: String(exporting ? 1 : this.ownerPage), limit: String(exporting ? 10000 : 25), ...(exporting ? { format: 'csv' } : {}) })}`;
  }
  auditUrl(exporting = false): string {
    const to = new Date(`${this.auditThrough}T00:00:00Z`);
    to.setUTCDate(to.getUTCDate() + 1);
    return `/api/administration/hosting/audit?${new URLSearchParams({ from: `${this.auditFrom}T00:00:00Z`, to: Number.isFinite(+to) ? to.toISOString() : '', applicationId: this.auditId, action: this.auditAction, page: String(exporting ? 1 : this.auditPage), limit: String(exporting ? 10000 : 25), ...(exporting ? { format: 'csv' } : {}) })}`;
  }
  async load(): Promise<void> {
    await this.work(async () => {
      if (['Inventory', 'Health', 'Trash'].includes(this.tab()))
        this.inventory.set(
          await this.api.get<HostingInventoryReport>(this.inventoryUrl()),
        );
      if (this.tab() === 'Storage')
        this.storage.set(
          await this.api.get<StorageReport>(
            '/api/administration/hosting/storage',
          ),
        );
      if (this.tab() === 'Owners & quotas') {
        const r = await this.api.get<{
          owners: HostingOwnerReport[];
          total: number;
        }>(this.ownersUrl());
        this.owners.set(r.owners);
        this.ownerTotal = r.total;
      }
      if (this.tab() === 'Audit') {
        const r = await this.api.get<{ records: AuditRecord[]; total: number }>(
          this.auditUrl(),
        );
        this.audit.set(r.records);
        this.auditTotal = r.total;
      }
    });
  }
  select(id: string): void {
    this.selected.update((ids) =>
      ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id],
    );
    this.preview.set(null);
  }
  selectAll(event: Event): void {
    this.selected.set(
      (event.target as HTMLInputElement).checked
        ? this.inventory().applications.map((a) => a.id)
        : [],
    );
    this.preview.set(null);
  }
  request(): HostingActionRequest {
    return {
      ids: this.selected(),
      action: this.action,
      reason: this.reason,
      ...(this.action === 'reassign' ? { ownerUserId: this.newOwnerId } : {}),
    };
  }
  async previewAction(): Promise<void> {
    await this.work(async () =>
      this.preview.set(
        await this.api.post<HostingActionPreview>(
          '/api/administration/hosting/actions/preview',
          this.request(),
        ),
      ),
    );
  }
  previewHasErrors(): boolean {
    return this.preview()?.applications.some((a) => !!a.error) ?? true;
  }
  async execute(): Promise<void> {
    await this.work(async () => {
      const body = {
        ...this.request(),
        expectedGenerations: Object.fromEntries(
          this.preview()!.applications.map((a) => [a.id, a.generation]),
        ),
      };
      const r = await this.api.post<{ jobId: string }>(
        '/api/administration/hosting/actions',
        body,
      );
      this.preview.set(null);
      this.notice.set(`Queued job ${r.jobId}. Results appear here.`);
      this.poll(r.jobId);
    });
  }
  private poll(id: string): void {
    if (this.polling) clearInterval(this.polling);
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const r = await this.api.get<{ job: BackgroundJob }>(
          `/api/administration/jobs/${id}`,
        );
        this.job.set(r.job);
        if (['completed', 'failed', 'cancelled'].includes(r.job.status)) {
          clearInterval(this.polling);
          this.selected.set([]);
          await this.load();
        }
      } catch {
        clearInterval(this.polling);
        this.error.set(
          'Could not poll the action job. Inspect Jobs & Workers.',
        );
      } finally {
        running = false;
      }
    };
    this.polling = setInterval(() => {
      void tick();
    }, 1500);
    void tick();
  }
  async inspect(a: HostingInventoryItem): Promise<void> {
    this.detailId = a.id;
    this.detailName = a.name;
    await this.work(async () =>
      this.detail.set(
        await this.api.get(`/api/administration/hosting/applications/${a.id}`),
      ),
    );
  }
  showUsage(id: string): void {
    this.usageId = id;
    this.usageApplicationId.set(id);
    this.tab.set('Usage');
  }
  applyUsage(): void {
    this.usageApplicationId.set(this.usageId.trim());
  }
  applicationAudit(id: string): void {
    this.auditId = id;
    this.auditPage = 1;
    this.tab.set('Audit');
    void this.load();
  }
  storageCards(
    s: StorageReport,
  ): Array<{ label: string; value: string | number }> {
    return [
      { label: 'Allocated including reservations', value: s.allocatedBytes },
      { label: 'Import reservations', value: s.reservedBytes },
      { label: 'Retained trash', value: s.trashBytes },
      { label: 'Instance budget', value: s.budgetBytes },
      { label: 'Filesystem free space', value: s.freeBytes },
    ];
  }
  editQuota(o: HostingOwnerReport): void {
    this.quotaOwner.set(o);
    this.quotaApps = o.applicationLimit;
    this.quotaStorage = o.storageBytesLimit ?? '';
    this.quotaReason = '';
  }
  async saveQuota(): Promise<void> {
    await this.work(async () => {
      await this.api.put(
        `/api/administration/hosting/owners/${this.quotaOwner()!.userId}`,
        {
          applicationLimit: this.quotaApps,
          storageBytesLimit: this.quotaStorage.trim() || null,
          reason: this.quotaReason,
        },
      );
      this.quotaOwner.set(null);
    });
    if (!this.error()) await this.load();
  }
  private async work(fn: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await fn();
    } catch (e: unknown) {
      this.error.set(
        (e as { error?: { error?: string } }).error?.error ??
          'Hosting operation failed.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
