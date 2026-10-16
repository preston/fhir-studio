import {
  Component,
  Input,
  OnChanges,
  inject,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import type { HostingUsageReport } from '@fhir-studio/core';
export function hostingBytes(value: string | number): string {
  let n = Number(value),
    unit = 0;
  while (n >= 1024 && unit < 5) {
    n /= 1024;
    unit++;
  }
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'][unit]}`;
}
@Component({
  selector: 'app-hosting-usage',
  standalone: true,
  imports: [CommonModule, FormsModule, NgxEchartsDirective],
  template: `
    <div class="d-flex flex-wrap gap-2 mb-3 align-items-end">
      <label class="form-label"
        >From (UTC)<input class="form-control" type="date" [(ngModel)]="from"
      /></label>
      <label class="form-label"
        >Through (UTC)<input
          class="form-control"
          type="date"
          [(ngModel)]="through"
      /></label>
      <label class="form-label"
        >Channel<select class="form-select" [(ngModel)]="channel">
          <option value="">Both</option>
          <option value="preview">Preview</option>
          <option value="published">Published</option>
        </select></label
      >
      <button
        class="btn btn-primary mb-2"
        (click)="load()"
        [disabled]="loading()"
      >
        Refresh
      </button>
      @if (administrative) {
        <a class="btn btn-outline-secondary mb-2" [href]="url() + '&format=csv'"
          >Export CSV</a
        >
      }
    </div>
    @if (error()) {
      <div class="alert alert-danger">{{ error() }}</div>
    }
    @if (report(); as r) {
      @if (collectionStale()) {
        <div class="alert alert-warning">
          Host usage collection has not reported within five minutes. Current
          usage is unknown.
        </div>
      }

      <div class="row g-3 mb-3">
        @for (card of cards(); track card.label) {
          <div class="col-sm-6 col-lg-3">
            <div class="card card-body h-100">
              <span class="small text-muted">{{ card.label }}</span
              ><strong class="fs-4">{{ card.value }}</strong>
            </div>
          </div>
        }
      </div>
      @if (r.visitors; as visitors) {
        <p class="text-muted small">
          Estimated browsers: {{ visitors.preview | number }} preview /
          {{ visitors.published | number }} published. Estimates are separate
          per hostname, use a 90-day cookie, and have approximately 3.3%
          standard error. Cookies blocked or cleared can affect coverage.
        </p>
      }
      <label class="form-label"
        >Chart metric<select
          class="form-select"
          [(ngModel)]="metric"
          (ngModelChange)="draw()"
        >
          <option value="requests">Requests</option>
          <option value="documents">HTML document responses</option>
          <option value="bytes">Response bytes</option>
          <option value="launches">SMART launches</option>
          <option value="status5xx">Server errors</option>
        </select></label
      >
      <div echarts [options]="chart()" style="height: 320px"></div>
      @if (!r.points.length) {
        <p class="text-muted">No recorded traffic for this range.</p>
      }
      <p class="small text-muted">
        Server observations include bots and asset requests. HTML responses
        include launch and callback documents; SPA navigation and browser-cached
        views are not measured. Response time measures server response
        completion. Traffic is retained until an administrator purges it.
      </p>
      <details>
        <summary>Collection health</summary>
        @for (c of r.collectors; track c.id) {
          <div class="small">
            {{ c.kind }} · last flush {{ c.lastFlushedAt | date: 'medium' }} ·
            {{ c.dropped }} dropped samples
          </div>
        }
        @if (!r.collectors.length) {
          <div class="alert alert-warning">
            No collector has reported yet. Usage is unknown.
          </div>
        }
      </details>
    }
  `,
})
export class HostingUsageComponent implements OnChanges {
  @Input() applicationId = '';
  @Input() administrative = false;
  private readonly http = inject(HttpClient);
  readonly report = signal<HostingUsageReport | null>(null);
  readonly error = signal('');
  readonly loading = signal(false);
  readonly chart = signal<EChartsOption>({});
  readonly bytes = hostingBytes;
  readonly collectionStale = computed(
    () =>
      !this.report()?.collectors.some(
        (c) =>
          c.kind === 'host' &&
          Date.parse(c.lastFlushedAt) > Date.now() - 300000,
      ),
  );
  from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  through = new Date().toISOString().slice(0, 10);
  channel = '';
  metric: 'requests' | 'documents' | 'bytes' | 'launches' | 'status5xx' =
    'requests';
  private requestVersion = 0;
  readonly cards = computed(() => {
    const r = this.report();
    if (!r) return [];
    return [
      { label: 'Requests', value: r.totals.requests.toLocaleString() },
      {
        label: 'HTML document responses',
        value: r.totals.documents.toLocaleString(),
      },
      { label: 'Response bandwidth', value: hostingBytes(r.totals.bytes) },
      { label: 'SMART launches', value: r.totals.launches.toLocaleString() },
      {
        label: '4xx / 5xx responses',
        value: `${r.totals.status4xx} / ${r.totals.status5xx}`,
      },
      {
        label: 'Average / p95 server time',
        value: `${r.averageResponseMs.toFixed(1)} / ${r.p95ResponseMs ?? '—'} ms`,
      },
      { label: 'Known bot requests', value: r.totals.bots.toLocaleString() },
      {
        label: 'Rate limited / aborted',
        value: `${r.totals.rateLimited} / ${r.totals.aborted}`,
      },
    ];
  });
  ngOnChanges(): void {
    void this.load();
  }
  url(): string {
    const until = new Date(`${this.through}T00:00:00Z`);
    until.setUTCDate(until.getUTCDate() + 1);
    const params = new URLSearchParams({
      from: `${this.from}T00:00:00Z`,
      to: Number.isFinite(+until) ? until.toISOString() : '',
      ...(this.channel ? { channel: this.channel } : {}),
      ...(this.administrative && this.applicationId
        ? { applicationId: this.applicationId }
        : {}),
    });
    return `${this.administrative ? '/api/administration/hosting/usage' : `/api/hosted-applications/${this.applicationId}/usage`}?${params}`;
  }
  async load(): Promise<void> {
    if (!this.administrative && !this.applicationId) return;
    const version = ++this.requestVersion;
    this.loading.set(true);
    this.error.set('');
    try {
      const report = await firstValueFrom(
        this.http.get<HostingUsageReport>(this.url()),
      );
      if (version === this.requestVersion) {
        this.report.set(report);
        this.draw();
      }
    } catch (e: unknown) {
      if (version === this.requestVersion)
        this.error.set(
          (e as { error?: { error?: string } }).error?.error ??
            'Failed to load usage.',
        );
    } finally {
      if (version === this.requestVersion) this.loading.set(false);
    }
  }
  draw(): void {
    const points = this.report()?.points ?? [];
    this.chart.set({
      tooltip: { trigger: 'axis' },
      legend: { data: ['Preview', 'Published'] },
      xAxis: { type: 'time' },
      yAxis: { type: 'value' },
      series: ['preview', 'published'].map((channel) => ({
        type: 'line' as const,
        name: channel === 'preview' ? 'Preview' : 'Published',
        showSymbol: false,
        data: points
          .filter((p) => p.channel === channel)
          .map((p) => [p.hour, Number(p[this.metric])]),
      })),
    });
  }
}
