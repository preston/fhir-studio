// Author: Preston Lee

import { Component, OnInit, OnDestroy, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import type {
  BackgroundJob,
  JobSummary,
  JobFilter,
  JobStatus,
} from '@fhir-studio/core';
import { AdministrationService } from '../../core/services/administration.service.js';
import { SandboxService, type Sandbox } from '../../core/services/sandbox.service.js';

@Component({
  selector: 'app-admin-jobs',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-jobs.component.html',
})
export class AdminJobsComponent implements OnInit, OnDestroy {
  public readonly administrationService = inject(AdministrationService);
  public readonly sandboxService = inject(SandboxService);

  public readonly jobs = signal<BackgroundJob[]>([]);
  public readonly jobsSummary = signal<JobSummary | null>(null);
  public readonly totalJobs = signal<number>(0);
  public readonly allSandboxes = signal<Sandbox[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly jobFilters = signal<JobFilter>({
    status: undefined,
    jobType: '',
    search: '',
    page: 1,
    limit: 10,
  });

  public readonly totalPages = computed(() => {
    const total = this.totalJobs();
    const limit = this.jobFilters().limit || 10;
    return Math.max(1, Math.ceil(total / limit));
  });

  public readonly autoRefreshJobs = signal<boolean>(true);
  private jobsPollingInterval: ReturnType<typeof setInterval> | null = null;

  // Modals
  public readonly showJobDetailModal = signal<boolean>(false);
  public readonly selectedJob = signal<BackgroundJob | null>(null);

  public readonly showTestJobModal = signal<boolean>(false);
  public testJobForm = {
    name: 'Synthetic Test Worker Job',
    steps: 5,
    stepDelayMs: 1000,
    message: 'Simulated data analysis batch',
    failAtStep: null as number | null,
    sandboxId: '',
  };

  ngOnInit(): void {
    this.loadJobs();
    this.sandboxService.getSandboxes().subscribe({
      next: (res) => this.allSandboxes.set(res.sandboxes),
    });
    this.startJobsPolling();
  }

  ngOnDestroy(): void {
    this.stopJobsPolling();
  }

  public loadJobs(): void {
    this.loading.set(true);
    this.administrationService.getJobs(this.jobFilters()).subscribe({
      next: (res) => {
        this.jobs.set(res.jobs);
        this.totalJobs.set(res.total);
        this.jobsSummary.set(res.summary);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load background jobs.');
        this.loading.set(false);
      },
    });
  }

  public toggleAutoRefresh(): void {
    this.autoRefreshJobs.update((v) => !v);
    if (this.autoRefreshJobs()) {
      this.startJobsPolling();
    } else {
      this.stopJobsPolling();
    }
  }

  private startJobsPolling(): void {
    this.stopJobsPolling();
    this.jobsPollingInterval = setInterval(() => {
      if (this.autoRefreshJobs()) {
        this.loadJobs();
      }
    }, 4000);
  }

  private stopJobsPolling(): void {
    if (this.jobsPollingInterval) {
      clearInterval(this.jobsPollingInterval);
      this.jobsPollingInterval = null;
    }
  }

  public filterByStatus(status?: JobStatus): void {
    this.jobFilters.update((f) => ({ ...f, status, page: 1 }));
    this.loadJobs();
  }

  public onJobSearchChange(search: string): void {
    this.jobFilters.update((f) => ({ ...f, search, page: 1 }));
    this.loadJobs();
  }

  public setPage(page: number): void {
    if (page < 1 || page > this.totalPages()) return;
    this.jobFilters.update((f) => ({ ...f, page }));
    this.loadJobs();
  }

  public setLimit(limit: number): void {
    this.jobFilters.update((f) => ({ ...f, limit: Number(limit), page: 1 }));
    this.loadJobs();
  }

  public resetFilters(): void {
    this.jobFilters.set({
      status: undefined,
      jobType: '',
      search: '',
      page: 1,
      limit: 10,
    });
    this.loadJobs();
  }

  public getShowingStart(): number {
    if (this.totalJobs() === 0) return 0;
    const page = this.jobFilters().page || 1;
    const limit = this.jobFilters().limit || 10;
    return (page - 1) * limit + 1;
  }

  public getShowingEnd(): number {
    const page = this.jobFilters().page || 1;
    const limit = this.jobFilters().limit || 10;
    return Math.min(page * limit, this.totalJobs());
  }

  public inspectJob(job: BackgroundJob): void {
    this.selectedJob.set(job);
    this.showJobDetailModal.set(true);
  }

  public openTestJobModal(): void {
    const sbs = this.allSandboxes();
    this.testJobForm = {
      name: `Synthetic Test Worker Job #${Math.floor(Math.random() * 1000)}`,
      steps: 6,
      stepDelayMs: 1000,
      message: 'Simulated data analysis batch',
      failAtStep: null,
      sandboxId: sbs.length > 0 ? sbs[0].sandboxId : '',
    };
    this.showTestJobModal.set(true);
  }

  public triggerTestJob(): void {
    const inputPayload: Record<string, any> = {
      steps: Number(this.testJobForm.steps),
      stepDelayMs: Number(this.testJobForm.stepDelayMs),
      message: this.testJobForm.message,
    };
    if (this.testJobForm.failAtStep) {
      inputPayload['failAtStep'] = Number(this.testJobForm.failAtStep);
    }

    this.administrationService
      .enqueueJob({
        name: this.testJobForm.name,
        jobType: 'TEST_JOB',
        input: inputPayload,
        sandboxId: this.testJobForm.sandboxId || undefined,
      })
      .subscribe({
        next: (res) => {
          this.showTestJobModal.set(false);
          this.successMessage.set(`Job '${res.job.name}' enqueued successfully.`);
          this.loadJobs();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to enqueue test job.');
        },
      });
  }

  public cancelJob(job: BackgroundJob): void {
    if (confirm(`Cancel active background job '${job.name}'?`)) {
      this.administrationService.cancelJob(job.id).subscribe({
        next: () => {
          this.successMessage.set(`Job '${job.name}' was cancelled.`);
          this.loadJobs();
          const curr = this.selectedJob();
          if (curr && curr.id === job.id) {
            this.selectedJob.set({ ...curr, status: 'cancelled' });
          }
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to cancel job.');
        },
      });
    }
  }

  public retryJob(job: BackgroundJob): void {
    this.administrationService.retryJob(job.id).subscribe({
      next: (res) => {
        this.successMessage.set(`Job '${job.name}' re-enqueued as #${res.job.id.slice(0, 8)}.`);
        this.loadJobs();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to retry job.');
      },
    });
  }

  public deleteJob(job: BackgroundJob): void {
    if (confirm(`Delete job record '${job.name}'?`)) {
      this.administrationService.deleteJob(job.id).subscribe({
        next: () => {
          this.successMessage.set(`Job record deleted.`);
          if (this.showJobDetailModal() && this.selectedJob()?.id === job.id) {
            this.showJobDetailModal.set(false);
          }
          this.loadJobs();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete job.');
        },
      });
    }
  }

  public purgeCompletedJobs(): void {
    if (confirm('Purge all completed, failed, and cancelled jobs from history?')) {
      this.administrationService.purgeCompletedJobs().subscribe({
        next: (res) => {
          this.successMessage.set(res.message);
          this.loadJobs();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to purge completed jobs.');
        },
      });
    }
  }

  public formatJson(data: any): string {
    if (!data) return '{}';
    return JSON.stringify(data, null, 2);
  }

  public calculateDuration(start?: string | null, end?: string | null): string {
    if (!start) return '-';
    const startDate = new Date(start).getTime();
    const endDate = end ? new Date(end).getTime() : Date.now();
    const diffMs = Math.max(0, endDate - startDate);
    const secs = Math.floor(diffMs / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}m ${remSecs}s`;
  }
}
