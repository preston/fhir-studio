import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type { JobScheduleRecord, ScheduledJobType } from '@fhir-studio/core';
import { HostingService } from '../../core/services/hosting.service.js';
@Component({
  selector: 'app-job-schedules',
  standalone: true,
  imports: [CommonModule, FormsModule],
  template: `
    <div class="d-flex gap-2 mb-3">
      <button class="btn btn-primary" (click)="edit()">New schedule</button
      ><button class="btn btn-outline-secondary" (click)="load()">
        Refresh
      </button>
    </div>
    @if (error()) {
      <div class="alert alert-danger">{{ error() }}</div>
    }
    @if (notice()) {
      <div class="alert alert-info">{{ notice() }}</div>
    }
    <div class="table-responsive">
      <table class="table table-striped align-middle">
        <thead>
          <tr>
            <th>Name / job type</th>
            <th>Timing (UTC)</th>
            <th>Last / next run (local)</th>
            <th>Enabled</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          @for (s of schedules(); track s.id) {
            <tr>
              <td>
                {{ s.name }}
                <div class="small text-muted">{{ s.jobType }}</div>
              </td>
              <td>{{ timing(s) }}</td>
              <td>
                {{ s.lastRunAt | date: 'medium' }}<br />{{
                  s.nextRunAt | date: 'medium'
                }}
              </td>
              <td>
                <input
                  type="checkbox"
                  class="form-check-input"
                  [checked]="s.enabled"
                  (change)="toggle(s)"
                  [disabled]="busy()"
                  [attr.aria-label]="'Enable ' + s.name"
                />
              </td>
              <td>
                <div class="btn-group">
                  <button
                    class="btn btn-sm btn-outline-primary"
                    (click)="edit(s)"
                  >
                    Edit</button
                  ><button
                    class="btn btn-sm btn-outline-secondary"
                    (click)="run(s)"
                    [disabled]="busy()"
                  >
                    Run now</button
                  ><button
                    class="btn btn-sm btn-outline-danger"
                    (click)="remove(s)"
                    [disabled]="busy()"
                  >
                    Delete
                  </button>
                </div>
                <a
                  class="btn btn-sm btn-link"
                  [href]="'/administration/jobs?scheduleId=' + s.id"
                  >History</a
                >
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
    @if (editing()) {
      <div class="card card-body border-primary mt-3">
        <h5>{{ editingId ? 'Edit' : 'New' }} schedule</h5>
        <label class="form-label"
          >Name<input
            class="form-control"
            [(ngModel)]="form.name"
            maxlength="200"
        /></label>
        <label class="form-label"
          >Description<input
            class="form-control"
            [(ngModel)]="form.description"
        /></label>
        <label class="form-label"
          >Job type<select
            class="form-select"
            [(ngModel)]="form.jobType"
            (ngModelChange)="chooseType()"
          >
            @for (t of types(); track t.jobType) {
              <option [value]="t.jobType">
                {{ t.jobType }} — {{ t.description }}
              </option>
            }
          </select></label
        >
        <div class="row g-2">
          <label class="col form-label"
            >Frequency<select class="form-select" [(ngModel)]="form.frequency">
              <option value="EVERY_MINUTE">Every minute</option>
              <option value="HOURLY">Hourly</option>
              <option value="DAILY">Daily</option>
            </select></label
          >
          @if (form.frequency !== 'EVERY_MINUTE') {
            <label class="col form-label"
              >Minute (UTC)<input
                class="form-control"
                type="number"
                min="0"
                max="59"
                [(ngModel)]="form.minuteOfHour"
            /></label>
          }
          @if (form.frequency === 'DAILY') {
            <label class="col form-label"
              >Hour (UTC)<input
                class="form-control"
                type="number"
                min="0"
                max="23"
                [(ngModel)]="form.hourOfDay"
            /></label>
          }
        </div>
        <label class="form-label mt-2"
          >Job configuration (JSON)<textarea
            class="form-control font-monospace"
            rows="8"
            [(ngModel)]="payload"
          ></textarea>
        </label>
        <p class="small text-muted">
          Maintenance dry runs report affected records without changing
          applications or files. History purges require datasets and an explicit
          UTC cutoff. Schedules use UTC; dates above display in your local
          timezone.
        </p>
        <label class="form-check mb-3"
          ><input
            type="checkbox"
            class="form-check-input"
            [(ngModel)]="form.enabled"
          />
          Enabled</label
        >
        <div class="d-flex gap-2">
          <button class="btn btn-primary" (click)="save()" [disabled]="busy()">
            Save schedule</button
          ><button
            class="btn btn-outline-secondary"
            (click)="editing.set(false)"
          >
            Cancel
          </button>
        </div>
      </div>
    }
  `,
})
export class JobSchedulesComponent implements OnInit {
  private readonly api = inject(HostingService);
  readonly schedules = signal<JobScheduleRecord[]>([]);
  readonly types = signal<ScheduledJobType[]>([]);
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  editingId = '';
  payload = '{}';
  form = {
    name: '',
    description: '',
    jobType: 'TEST_JOB',
    frequency: 'HOURLY',
    minuteOfHour: 0,
    hourOfDay: 0,
    enabled: false,
  };
  ngOnInit(): void {
    void this.load();
  }
  async load(): Promise<void> {
    await this.action(async () => {
      const [a, b] = await Promise.all([
        this.api.get<{ schedules: JobScheduleRecord[] }>(
          '/api/administration/job-schedules',
        ),
        this.api.get<{ types: ScheduledJobType[] }>(
          '/api/administration/job-types',
        ),
      ]);
      this.schedules.set(a.schedules);
      this.types.set(b.types);
    });
  }
  timing(s: JobScheduleRecord): string {
    return s.frequency === 'EVERY_MINUTE'
      ? 'Every minute'
      : s.frequency === 'HOURLY'
        ? `Hourly at :${String(s.minuteOfHour).padStart(2, '0')}`
        : `Daily ${String(s.hourOfDay).padStart(2, '0')}:${String(s.minuteOfHour).padStart(2, '0')}`;
  }
  edit(s?: JobScheduleRecord): void {
    this.editingId = s?.id ?? '';
    this.form = {
      name: s?.name ?? '',
      description: s?.description ?? '',
      jobType: s?.jobType ?? 'TEST_JOB',
      frequency: s?.frequency ?? 'HOURLY',
      minuteOfHour: s?.minuteOfHour ?? 0,
      hourOfDay: s?.hourOfDay ?? 0,
      enabled: s?.enabled ?? false,
    };
    this.payload = JSON.stringify(s?.input ?? {}, null, 2);
    this.editing.set(true);
  }
  chooseType(): void {
    this.payload = JSON.stringify(
      this.types().find((t) => t.jobType === this.form.jobType)?.defaults ?? {},
      null,
      2,
    );
  }
  async save(): Promise<void> {
    await this.action(async () => {
      const body = {
        ...this.form,
        input: JSON.parse(this.payload) as Record<string, unknown>,
      };
      if (this.editingId)
        await this.api.patch(
          `/api/administration/job-schedules/${this.editingId}`,
          body,
        );
      else await this.api.post('/api/administration/job-schedules', body);
      this.editing.set(false);
    });
    if (!this.error()) await this.load();
  }
  async toggle(s: JobScheduleRecord): Promise<void> {
    await this.action(() =>
      this.api.patch(`/api/administration/job-schedules/${s.id}`, {
        enabled: !s.enabled,
      }),
    );
    if (!this.error()) await this.load();
  }
  async run(s: JobScheduleRecord): Promise<void> {
    await this.action(async () => {
      const r = await this.api.post<{ jobId: string }>(
        `/api/administration/job-schedules/${s.id}/run-now`,
      );
      this.notice.set(`Queued job ${r.jobId}. View the Runs tab for results.`);
    });
  }
  async remove(s: JobScheduleRecord): Promise<void> {
    if (
      !confirm(
        `Delete schedule '${s.name}'? Its execution history will remain.`,
      )
    )
      return;
    await this.action(() =>
      this.api.delete(`/api/administration/job-schedules/${s.id}`),
    );
    if (!this.error()) await this.load();
  }
  private async action(work: () => Promise<unknown>): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await work();
    } catch (e: unknown) {
      this.error.set(
        (e as { error?: { error?: string }; message?: string }).error?.error ??
          (e as Error).message ??
          'Schedule operation failed.',
      );
    } finally {
      this.busy.set(false);
    }
  }
}
