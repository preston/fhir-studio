// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SandboxService } from '../core/services/sandbox.service.js';
import { ApplicationsService, type SmartApplication } from '../core/services/applications.service.js';
import { AuthService } from '../core/services/auth.service.js';
import { ToastService } from '../core/services/toast.service.js';

@Component({
  selector: 'app-applications-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './applications-manager.component.html',
})
export class ApplicationsManagerComponent implements OnInit {
  private readonly toast = inject(ToastService);
  public readonly sandboxService = inject(SandboxService);
  public readonly applicationsService = inject(ApplicationsService);
  public readonly auth = inject(AuthService);

  public readonly applications = signal<SmartApplication[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly formError = signal<string | null>(null);

  public readonly showApplicationModal = signal<boolean>(false);
  public readonly editingApplicationId = signal<string | null>(null);
  public readonly saving = signal<boolean>(false);
  public applicationForm = this.emptyApplicationForm();

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      untracked(() => {
        this.closeApplicationModal();
        if (active) {
          this.loadApplications(active.sandboxId);
        }
      });
    });
  }

  ngOnInit(): void {
    if (this.sandboxService.sandboxes().length === 0) {
      this.sandboxService.getSandboxes().subscribe();
    }
  }

  public loadApplications(sandboxId?: string): void {
    const targetId = sandboxId || this.sandboxService.activeSandbox()?.sandboxId;
    if (!targetId) return;

    this.loading.set(true);
    this.applicationsService.getSandboxApplications(targetId).subscribe({
      next: (res) => {
        this.applications.set(res?.applications || []);
        this.errorMessage.set(null);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load applications.');
        this.loading.set(false);
      },
    });
  }

  public builtInApplicationPath(application: SmartApplication): string | null {
    switch (application.clientId) {
      case 'example-application':
      case 'example-app':
        return '/example-application';
      case 'cql-with-fhir-example':
        return '/example-cql-with-fhir';
      default:
        return null;
    }
  }

  public canEditApplication(application: SmartApplication): boolean {
    const sandbox = this.sandboxService.activeSandbox();
    const user = this.auth.currentUser();
    if (!sandbox || !user || application.sandboxId !== sandbox.id || application.hostedApplicationId ||
        application.isSample || this.builtInApplicationPath(application)) return false;

    const role = sandbox.collaborators?.find((collaborator) => collaborator.userId === user.id)?.role;
    return this.auth.isGlobalAdmin() || sandbox.createdByUserId === user.id || role === 'MANAGE' || role === 'OWNER';
  }

  private emptyApplicationForm() {
    return {
      clientName: '',
      launchUri: '',
      redirectUrisText: '',
      scope: 'launch/patient patient/*.read openid profile',
      briefDescription: '',
      author: '',
      clientUri: '',
      logoUri: '',
    };
  }

  public openRegisterApplication(): void {
    if (this.saving()) return;
    this.applicationForm = this.emptyApplicationForm();
    this.editingApplicationId.set(null);
    this.formError.set(null);
    this.showApplicationModal.set(true);
  }

  public openEditApplication(application: SmartApplication): void {
    if (this.saving() || !this.canEditApplication(application)) return;
    this.applicationForm = {
      clientName: application.clientName,
      launchUri: application.launchUri,
      redirectUrisText: application.redirectUris.join('\n'),
      scope: application.scope,
      briefDescription: application.briefDescription ?? '',
      author: application.author ?? '',
      clientUri: application.clientUri ?? '',
      logoUri: application.logoUri ?? '',
    };
    this.editingApplicationId.set(application.id);
    this.formError.set(null);
    this.showApplicationModal.set(true);
  }

  public closeApplicationModal(): void {
    this.showApplicationModal.set(false);
    this.editingApplicationId.set(null);
    this.formError.set(null);
  }

  public saveApplication(): void {
    if (this.saving()) return;
    this.formError.set(null);
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    const clientName = this.applicationForm.clientName.trim();
    const launchUri = this.applicationForm.launchUri.trim();
    if (!clientName || !launchUri) {
      this.formError.set('Application Name and Launch URI are required.');
      return;
    }

    const redirectUris = this.applicationForm.redirectUrisText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const applicationId = this.editingApplicationId();
    const data = {
      clientName,
      launchUri,
      redirectUris: redirectUris.length > 0 ? redirectUris : [launchUri],
      scope: this.applicationForm.scope,
      briefDescription: this.applicationForm.briefDescription,
      author: this.applicationForm.author,
      clientUri: this.applicationForm.clientUri,
      logoUri: this.applicationForm.logoUri,
    };
    const request = applicationId
      ? this.applicationsService.updateApplication(current.sandboxId, applicationId, data)
      : this.applicationsService.registerApplication(current.sandboxId, { ...data, isCustom: true });

    this.saving.set(true);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.toast.success(`Application '${clientName}' ${applicationId ? 'updated' : 'registered'} successfully.`);
        if (this.sandboxService.activeSandbox()?.sandboxId === current.sandboxId) {
          this.closeApplicationModal();
          this.loadApplications(current.sandboxId);
        }
      },
      error: (err) => {
        this.saving.set(false);
        if (this.sandboxService.activeSandbox()?.sandboxId === current.sandboxId) {
          this.formError.set(err?.error?.error || `Failed to ${applicationId ? 'update' : 'register'} application.`);
        }
      },
    });
  }

  public deleteApplication(application: SmartApplication): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete application '${application.clientName}'?`)) {
      this.applicationsService.deleteApplication(current.sandboxId, application.id).subscribe({
        next: () => {
          this.toast.success(`Application '${application.clientName}' deleted.`);
          this.loadApplications(current.sandboxId);
        },
        error: (err) => {
          this.toast.error(err?.error?.error || 'Failed to delete application.');
        },
      });
    }
  }
}
