// Author: Preston Lee

import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  BackgroundJob,
  JobSummary,
  JobFilter,
  CreateJobPayload,
  AdministrationSandboxFilter,
  AdministrationSandboxListResponse,
  ImplementationGuideSummary,
  CreateImplementationGuidePayload,
  UpdateImplementationGuidePayload,
  ImplementationGuideFilter,
} from '@fhir-studio/core';

export interface AdministrationMetrics {
  summary: {
    totalSandboxes: number;
    r4Sandboxes: number;
    r5Sandboxes: number;
    openSandboxes: number;
    securedSandboxes: number;
    sharedSandboxes: number;
    totalUsers: number;
    suspendedUsers: number;
    totalSessions: number;
    totalApplications: number;
    totalScenarios: number;
  };
  charts: {
    versionDistribution: Array<{ name: string; value: number }>;
    accessModeDistribution: Array<{ name: string; value: number }>;
    monthlySignupsTimeline: Array<{ month: string; count: number }>;
    monthlySandboxesTimeline: Array<{ month: string; count: number }>;
  };
}

export interface AdministrationUser {
  id: string;
  ssoIssuer: string;
  ssoSubject: string;
  email: string | null;
  displayName: string | null;
  isSuspended: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
  roles?: AdministrationRole[];
  memberships?: Array<{
    id: string;
    group: AdministrationGroup;
  }>;
  _count?: {
    sessions: number;
    sandboxesCreated: number;
  };
}

export interface AdministrationGroup {
  id: string;
  name: string;
  description: string | null;
  ssoRoleMapping: string | null;
  createdAt: string;
  updatedAt: string;
  members?: Array<{
    id: string;
    user: AdministrationUser;
  }>;
  roles?: AdministrationRole[];
}

export interface AdministrationRole {
  id: string;
  name: string;
  description: string | null;
  default: boolean;
  ssoRoleMapping: string | null;
  permission_sandboxes_create: boolean;
  permission_sandboxes_shared: boolean;
  permission_ehr_simulator: boolean;
  permission_data_manager: boolean;
  permission_applications_register: boolean;
  permission_package_import: boolean;
  permission_global_manage: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdministrationAppointment {
  id: string;
  entityType: 'User' | 'Group';
  entityId: string;
  roleId: string;
  role: AdministrationRole;
  createdAt: string;
  updatedAt: string;
}

@Injectable({
  providedIn: 'root',
})
export class AdministrationService {
  private readonly http = inject(HttpClient);

  public getMetrics(): Observable<AdministrationMetrics> {
    return this.http.get<AdministrationMetrics>('/api/administration/metrics');
  }

  // Users
  public getUsers(): Observable<{ users: AdministrationUser[] }> {
    return this.http.get<{ users: AdministrationUser[] }>('/api/administration/users');
  }

  public suspendUser(userId: string, isSuspended: boolean): Observable<{ user: AdministrationUser }> {
    return this.http.put<{ user: AdministrationUser }>(`/api/administration/users/${userId}/suspend`, {
      isSuspended,
    });
  }

  // Groups
  public getGroups(): Observable<{ groups: AdministrationGroup[] }> {
    return this.http.get<{ groups: AdministrationGroup[] }>('/api/administration/groups');
  }

  public createGroup(data: {
    name: string;
    description?: string;
    ssoRoleMapping?: string;
  }): Observable<{ group: AdministrationGroup }> {
    return this.http.post<{ group: AdministrationGroup }>('/api/administration/groups', data);
  }

  public updateGroup(
    groupId: string,
    data: Partial<AdministrationGroup>,
  ): Observable<{ group: AdministrationGroup }> {
    return this.http.put<{ group: AdministrationGroup }>(`/api/administration/groups/${groupId}`, data);
  }

  public deleteGroup(groupId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/groups/${groupId}`);
  }

  public addGroupMember(groupId: string, userId: string): Observable<{ member: unknown }> {
    return this.http.post<{ member: unknown }>(`/api/administration/groups/${groupId}/members`, { userId });
  }

  public removeGroupMember(groupId: string, userId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/groups/${groupId}/members/${userId}`);
  }

  // Roles
  public getRoles(): Observable<{ roles: AdministrationRole[] }> {
    return this.http.get<{ roles: AdministrationRole[] }>('/api/administration/roles');
  }

  public createRole(data: Partial<AdministrationRole>): Observable<{ role: AdministrationRole }> {
    return this.http.post<{ role: AdministrationRole }>('/api/administration/roles', data);
  }

  public updateRole(roleId: string, data: Partial<AdministrationRole>): Observable<{ role: AdministrationRole }> {
    return this.http.put<{ role: AdministrationRole }>(`/api/administration/roles/${roleId}`, data);
  }

  public deleteRole(roleId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/roles/${roleId}`);
  }

  // Appointments
  public getAppointments(): Observable<{ appointments: AdministrationAppointment[] }> {
    return this.http.get<{ appointments: AdministrationAppointment[] }>('/api/administration/appointments');
  }

  public createAppointment(data: {
    entityType: 'User' | 'Group';
    entityId: string;
    roleId: string;
  }): Observable<{ appointment: AdministrationAppointment }> {
    return this.http.post<{ appointment: AdministrationAppointment }>('/api/administration/appointments', data);
  }

  public deleteAppointment(appointmentId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/appointments/${appointmentId}`);
  }

  // Purge Sandbox & Administration Sandboxes Query
  public getAdminSandboxes(filters: AdministrationSandboxFilter = {}): Observable<AdministrationSandboxListResponse> {
    let params = new HttpParams();
    if (filters.search) params = params.set('search', filters.search);
    if (filters.user) params = params.set('user', filters.user);
    if (filters.fhirVersion) params = params.set('fhirVersion', filters.fhirVersion);
    if (filters.agePreset && filters.agePreset !== 'all') params = params.set('agePreset', filters.agePreset);
    if (filters.lastUsedPreset && filters.lastUsedPreset !== 'all') params = params.set('lastUsedPreset', filters.lastUsedPreset);
    if (filters.sortBy) params = params.set('sortBy', filters.sortBy);
    if (filters.sortOrder) params = params.set('sortOrder', filters.sortOrder);
    if (filters.page) params = params.set('page', filters.page.toString());
    if (filters.limit) params = params.set('limit', filters.limit.toString());

    return this.http.get<AdministrationSandboxListResponse>('/api/administration/sandboxes', { params });
  }

  public purgeSandbox(sandboxId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/sandboxes/${sandboxId}/purge`);
  }

  // Background Job Worker & Job Management
  public getJobs(filters: JobFilter = {}): Observable<{
    jobs: BackgroundJob[];
    total: number;
    page: number;
    limit: number;
    summary: JobSummary;
  }> {
    let params = new HttpParams();
    const statusValues = [
      ...(filters.statuses ?? []),
      ...(filters.status ? [filters.status] : []),
    ];
    if (statusValues.length > 0) {
      params = params.set('status', statusValues.join(','));
    }
    if (filters.jobType) params = params.set('jobType', filters.jobType);
    if (filters.sandboxId) params = params.set('sandboxId', filters.sandboxId);
    if (filters.search) params = params.set('search', filters.search);
    if (filters.sortBy) params = params.set('sortBy', filters.sortBy);
    if (filters.sortOrder) params = params.set('sortOrder', filters.sortOrder);
    if (filters.page) params = params.set('page', filters.page.toString());
    if (filters.limit) params = params.set('limit', filters.limit.toString());

    return this.http.get<{
      jobs: BackgroundJob[];
      total: number;
      page: number;
      limit: number;
      summary: JobSummary;
    }>('/api/administration/jobs', { params });
  }

  public getJobMetrics(): Observable<{ summary: JobSummary }> {
    return this.http.get<{ summary: JobSummary }>('/api/administration/jobs/metrics');
  }

  public getJob(jobId: string): Observable<{ job: BackgroundJob }> {
    return this.http.get<{ job: BackgroundJob }>(`/api/administration/jobs/${jobId}`);
  }

  public enqueueJob(payload: CreateJobPayload): Observable<{ job: BackgroundJob }> {
    return this.http.post<{ job: BackgroundJob }>('/api/administration/jobs', payload);
  }

  public cancelJob(jobId: string): Observable<{ message: string; job: BackgroundJob }> {
    return this.http.post<{ message: string; job: BackgroundJob }>(`/api/administration/jobs/${jobId}/cancel`, {});
  }

  public retryJob(jobId: string): Observable<{ message: string; job: BackgroundJob }> {
    return this.http.post<{ message: string; job: BackgroundJob }>(`/api/administration/jobs/${jobId}/retry`, {});
  }

  public deleteJob(jobId: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/jobs/${jobId}`);
  }

  public purgeCompletedJobs(): Observable<{ message: string; count: number }> {
    return this.http.delete<{ message: string; count: number }>('/api/administration/jobs/purge-completed');
  }

  // Implementation Guides & Package Registry Management
  public getAdminImplementationGuides(filters: ImplementationGuideFilter = {}): Observable<{
    implementationGuides: ImplementationGuideSummary[];
  }> {
    let params = new HttpParams();
    if (filters.search) params = params.set('search', filters.search);
    if (filters.category && filters.category !== 'all') params = params.set('category', filters.category);
    if (filters.fhirVersion && filters.fhirVersion !== 'all') params = params.set('fhirVersion', filters.fhirVersion);
    if (filters.recommendedForCreation !== undefined) {
      params = params.set('recommendedForCreation', filters.recommendedForCreation.toString());
    }
    if (filters.isSuggested !== undefined) {
      params = params.set('isSuggested', filters.isSuggested.toString());
    }

    return this.http.get<{ implementationGuides: ImplementationGuideSummary[] }>(
      '/api/administration/implementation-guides',
      { params },
    );
  }

  public createImplementationGuide(
    data: CreateImplementationGuidePayload,
  ): Observable<{ implementationGuide: ImplementationGuideSummary }> {
    return this.http.post<{ implementationGuide: ImplementationGuideSummary }>(
      '/api/administration/implementation-guides',
      data,
    );
  }

  public updateImplementationGuide(
    id: string,
    data: UpdateImplementationGuidePayload,
  ): Observable<{ implementationGuide: ImplementationGuideSummary }> {
    return this.http.put<{ implementationGuide: ImplementationGuideSummary }>(
      `/api/administration/implementation-guides/${id}`,
      data,
    );
  }

  public deleteImplementationGuide(id: string): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`/api/administration/implementation-guides/${id}`);
  }

  public fetchRegistryPackageMetadata(
    packageId: string,
    version?: string,
  ): Observable<{ metadata: Partial<CreateImplementationGuidePayload> }> {
    return this.http.post<{ metadata: Partial<CreateImplementationGuidePayload> }>(
      '/api/administration/implementation-guides/fetch-metadata',
      { packageId, version },
    );
  }
}
