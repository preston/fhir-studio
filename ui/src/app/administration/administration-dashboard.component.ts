// Author: Preston Lee

import { Component, OnInit, OnDestroy, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { NgxEchartsDirective } from 'ngx-echarts';
import type { EChartsOption } from 'echarts';
import type {
  BackgroundJob,
  JobSummary,
  JobFilter,
  JobStatus,
  AdministrationSandboxFilter,
  SandboxSummary,
  SandboxAgePreset,
  SandboxLastUsedPreset,
  SandboxSortField,
} from '@fhir-studio/core';
import {
  AdministrationService,
  type AdministrationMetrics,
  type AdministrationUser,
  type AdministrationGroup,
  type AdministrationRole,
  type AdministrationAppointment,
} from '../core/services/administration.service.js';
import { SandboxService, type Sandbox } from '../core/services/sandbox.service.js';

@Component({
  selector: 'app-administration-dashboard',
  standalone: true,
  imports: [CommonModule, FormsModule, NgxEchartsDirective],
  templateUrl: './administration-dashboard.component.html',
  styleUrls: ['./administration-dashboard.component.scss'],
})
export class AdministrationDashboardComponent implements OnInit, OnDestroy {
  public readonly administrationService = inject(AdministrationService);
  public readonly sandboxService = inject(SandboxService);

  public readonly activeTab = signal<'metrics' | 'users' | 'groups' | 'roles' | 'appointments' | 'jobs' | 'purge'>('metrics');

  public readonly metrics = signal<AdministrationMetrics | null>(null);
  public readonly users = signal<AdministrationUser[]>([]);
  public readonly groups = signal<AdministrationGroup[]>([]);
  public readonly roles = signal<AdministrationRole[]>([]);
  public readonly appointments = signal<AdministrationAppointment[]>([]);
  public readonly allSandboxes = signal<Sandbox[]>([]);

  // Jobs state
  public readonly jobs = signal<BackgroundJob[]>([]);
  public readonly jobsSummary = signal<JobSummary | null>(null);
  public readonly totalJobs = signal<number>(0);
  public readonly jobFilters = signal<JobFilter>({
    status: undefined,
    jobType: '',
    search: '',
    page: 1,
    limit: 25,
  });
  public readonly autoRefreshJobs = signal<boolean>(true);
  private jobsPollingInterval: ReturnType<typeof setInterval> | null = null;

  // Purge Sandboxes state
  public readonly purgeSandboxes = signal<SandboxSummary[]>([]);
  public readonly purgeTotal = signal<number>(0);
  public readonly purgeTotalPages = signal<number>(1);
  public readonly purgeLoading = signal<boolean>(false);
  public readonly purgeFilters = signal<AdministrationSandboxFilter>({
    search: '',
    user: '',
    fhirVersion: 'all',
    agePreset: 'all',
    lastUsedPreset: 'all',
    sortBy: 'createdAt',
    sortOrder: 'desc',
    page: 1,
    limit: 10,
  });

  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Chart configs signals
  public readonly versionChartOptions = signal<EChartsOption>({});
  public readonly accessModeChartOptions = signal<EChartsOption>({});
  public readonly signupsTimelineOptions = signal<EChartsOption>({});

  // Modals & Forms
  public readonly showGroupModal = signal<boolean>(false);
  public groupForm = { id: '', name: '', description: '', ssoRoleMapping: '' };

  public readonly showRoleModal = signal<boolean>(false);
  public roleForm: Partial<AdministrationRole> = {
    name: '',
    description: '',
    default: false,
    ssoRoleMapping: '',
    permission_sandboxes_create: true,
    permission_sandboxes_shared: true,
    permission_ehr_simulator: true,
    permission_data_manager: true,
    permission_applications_register: true,
    permission_package_import: true,
    permission_global_manage: false,
  };

  public readonly showAppointmentModal = signal<boolean>(false);
  public appointmentForm = {
    entityType: 'User' as 'User' | 'Group',
    entityId: '',
    roleId: '',
  };

  // Job Modals
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
    this.loadAllData();
    this.startJobsPolling();
  }

  ngOnDestroy(): void {
    this.stopJobsPolling();
  }

  public setTab(tab: 'metrics' | 'users' | 'groups' | 'roles' | 'appointments' | 'jobs' | 'purge'): void {
    this.activeTab.set(tab);
    if (tab === 'jobs') {
      this.loadJobs();
    } else if (tab === 'purge') {
      this.loadPurgeSandboxes();
    }
  }

  public loadAllData(): void {
    this.loading.set(true);
    this.administrationService.getMetrics().subscribe({
      next: (m) => {
        this.metrics.set(m);
        this.setupCharts(m);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load administration metrics.');
        this.loading.set(false);
      },
    });

    this.administrationService.getUsers().subscribe({
      next: (res) => this.users.set(res.users),
    });

    this.administrationService.getGroups().subscribe({
      next: (res) => this.groups.set(res.groups),
    });

    this.administrationService.getRoles().subscribe({
      next: (res) => this.roles.set(res.roles),
    });

    this.administrationService.getAppointments().subscribe({
      next: (res) => this.appointments.set(res.appointments),
    });

    this.sandboxService.getSandboxes().subscribe({
      next: (res) => this.allSandboxes.set(res.sandboxes),
    });

    this.loadJobs();
    this.loadPurgeSandboxes();
  }

  public loadJobs(): void {
    this.administrationService.getJobs(this.jobFilters()).subscribe({
      next: (res) => {
        this.jobs.set(res.jobs);
        this.totalJobs.set(res.total);
        this.jobsSummary.set(res.summary);
      },
      error: (err) => {
        if (this.activeTab() === 'jobs') {
          this.errorMessage.set(err?.error?.error || 'Failed to load background jobs.');
        }
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
      if (this.autoRefreshJobs() && (this.activeTab() === 'jobs' || this.activeTab() === 'metrics')) {
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

  public filterByType(jobType?: string): void {
    this.jobFilters.update((f) => ({ ...f, jobType: jobType || '', page: 1 }));
    this.loadJobs();
  }

  public onJobSearchChange(search: string): void {
    this.jobFilters.update((f) => ({ ...f, search }));
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

  private setupCharts(m: AdministrationMetrics): void {
    this.versionChartOptions.set({
      tooltip: { trigger: 'item' },
      legend: { bottom: '0' },
      series: [
        {
          name: 'FHIR Release',
          type: 'pie',
          radius: ['40%', '70%'],
          data: m.charts.versionDistribution,
        },
      ],
    });

    this.accessModeChartOptions.set({
      tooltip: { trigger: 'item' },
      legend: { bottom: '0' },
      series: [
        {
          name: 'Access Mode',
          type: 'pie',
          radius: ['40%', '70%'],
          data: m.charts.accessModeDistribution,
        },
      ],
    });

    const months = m.charts.monthlySignupsTimeline.map((item) => item.month);
    const signupCounts = m.charts.monthlySignupsTimeline.map((item) => item.count);

    this.signupsTimelineOptions.set({
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: months.length > 0 ? months : ['2026-08'] },
      yAxis: { type: 'value' },
      series: [
        {
          name: 'New Signups',
          type: 'bar',
          data: signupCounts.length > 0 ? signupCounts : [1],
          itemStyle: { color: '#0d6efd' },
        },
      ],
    });
  }

  public toggleSuspend(user: AdministrationUser): void {
    const nextState = !user.isSuspended;
    const action = nextState ? 'suspend' : 'unsuspend';
    if (confirm(`Are you sure you want to ${action} user '${user.email || user.displayName}'?`)) {
      this.administrationService.suspendUser(user.id, nextState).subscribe({
        next: () => {
          this.users.update((list) =>
            list.map((u) => (u.id === user.id ? { ...u, isSuspended: nextState } : u)),
          );
          this.successMessage.set(`User account ${action}ed successfully.`);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || `Failed to ${action} user.`);
        },
      });
    }
  }

  public saveGroup(): void {
    if (!this.groupForm.name) return;
    if (this.groupForm.id) {
      this.administrationService.updateGroup(this.groupForm.id, this.groupForm).subscribe({
        next: () => {
          this.showGroupModal.set(false);
          this.successMessage.set('Group updated.');
          this.loadAllData();
        },
      });
    } else {
      this.administrationService.createGroup(this.groupForm).subscribe({
        next: () => {
          this.showGroupModal.set(false);
          this.successMessage.set('Group created.');
          this.loadAllData();
        },
      });
    }
  }

  public deleteGroup(groupId: string): void {
    if (confirm('Delete this group?')) {
      this.administrationService.deleteGroup(groupId).subscribe({
        next: () => {
          this.successMessage.set('Group deleted.');
          this.loadAllData();
        },
      });
    }
  }

  public saveRole(): void {
    if (!this.roleForm.name) return;
    if (this.roleForm.id) {
      this.administrationService.updateRole(this.roleForm.id, this.roleForm).subscribe({
        next: () => {
          this.showRoleModal.set(false);
          this.successMessage.set('Role updated.');
          this.loadAllData();
        },
      });
    } else {
      this.administrationService.createRole(this.roleForm).subscribe({
        next: () => {
          this.showRoleModal.set(false);
          this.successMessage.set('Role created.');
          this.loadAllData();
        },
      });
    }
  }

  public deleteRole(roleId: string): void {
    if (confirm('Delete this role?')) {
      this.administrationService.deleteRole(roleId).subscribe({
        next: () => {
          this.successMessage.set('Role deleted.');
          this.loadAllData();
        },
      });
    }
  }

  public saveAppointment(): void {
    if (!this.appointmentForm.entityId || !this.appointmentForm.roleId) return;
    this.administrationService.createAppointment(this.appointmentForm).subscribe({
      next: () => {
        this.showAppointmentModal.set(false);
        this.successMessage.set('Appointment created.');
        this.loadAllData();
      },
    });
  }

  public deleteAppointment(id: string): void {
    if (confirm('Delete this appointment?')) {
      this.administrationService.deleteAppointment(id).subscribe({
        next: () => {
          this.successMessage.set('Appointment deleted.');
          this.loadAllData();
        },
      });
    }
  }

  public purgeSandbox(sandbox: Sandbox | SandboxSummary): void {
    if (confirm(`CRITICAL: Permanently purge sandbox '${sandbox.name}' and delete its HAPI FHIR JPA partition? This action is irreversible.`)) {
      this.administrationService.purgeSandbox(sandbox.sandboxId).subscribe({
        next: () => {
          this.successMessage.set(`Sandbox '${sandbox.name}' was purged completely.`);
          this.loadAllData();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Purge failed.');
        },
      });
    }
  }

  // Purge Sandboxes filtering, sorting, and pagination
  public loadPurgeSandboxes(): void {
    this.purgeLoading.set(true);
    this.administrationService.getAdminSandboxes(this.purgeFilters()).subscribe({
      next: (res) => {
        this.purgeSandboxes.set(res.sandboxes);
        this.purgeTotal.set(res.total);
        this.purgeTotalPages.set(res.totalPages);
        this.purgeLoading.set(false);
      },
      error: (err) => {
        if (this.activeTab() === 'purge') {
          this.errorMessage.set(err?.error?.error || 'Failed to load sandboxes for purge.');
        }
        this.purgeLoading.set(false);
      },
    });
  }

  public onPurgeSearchChange(search: string): void {
    this.purgeFilters.update((f) => ({ ...f, search, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onPurgeUserChange(user: string): void {
    this.purgeFilters.update((f) => ({ ...f, user, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onPurgeFhirVersionChange(fhirVersion: string): void {
    this.purgeFilters.update((f) => ({ ...f, fhirVersion, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onAgePresetChange(agePreset: any): void {
    this.purgeFilters.update((f) => ({ ...f, agePreset, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public onLastUsedPresetChange(lastUsedPreset: any): void {
    this.purgeFilters.update((f) => ({ ...f, lastUsedPreset, page: 1 }));
    this.loadPurgeSandboxes();
  }

  public setPurgeSort(field: SandboxSortField): void {
    this.purgeFilters.update((f) => {
      const isCurrent = f.sortBy === field;
      const nextOrder = isCurrent && f.sortOrder === 'asc' ? 'desc' : 'asc';
      return { ...f, sortBy: field, sortOrder: nextOrder, page: 1 };
    });
    this.loadPurgeSandboxes();
  }

  public setPurgePage(page: number): void {
    if (page < 1 || page > this.purgeTotalPages()) return;
    this.purgeFilters.update((f) => ({ ...f, page }));
    this.loadPurgeSandboxes();
  }

  public setPurgeLimit(limit: number): void {
    this.purgeFilters.update((f) => ({ ...f, limit: Number(limit), page: 1 }));
    this.loadPurgeSandboxes();
  }

  public resetPurgeFilters(): void {
    this.purgeFilters.set({
      search: '',
      user: '',
      fhirVersion: 'all',
      agePreset: 'all',
      lastUsedPreset: 'all',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      page: 1,
      limit: 10,
    });
    this.loadPurgeSandboxes();
  }

  public getPurgeShowingStart(): number {
    if (this.purgeTotal() === 0) return 0;
    const page = this.purgeFilters().page || 1;
    const limit = this.purgeFilters().limit || 10;
    return (page - 1) * limit + 1;
  }

  public getPurgeShowingEnd(): number {
    const page = this.purgeFilters().page || 1;
    const limit = this.purgeFilters().limit || 10;
    return Math.min(page * limit, this.purgeTotal());
  }
}
