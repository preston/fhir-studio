// Author: Preston Lee

import { Component, OnInit, inject, signal, effect, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SandboxService } from '../core/services/sandbox.service.js';
import { ApplicationsService, type SmartApplication } from '../core/services/applications.service.js';
import { AuthService } from '../core/services/auth.service.js';

@Component({
  selector: 'app-applications-manager',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './applications-manager.component.html',
})
export class ApplicationsManagerComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  public readonly applicationsService = inject(ApplicationsService);
  public readonly auth = inject(AuthService);

  public readonly applications = signal<SmartApplication[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  public readonly showRegisterModal = signal<boolean>(false);
  public newApplication = {
    clientName: '',
    launchUri: '',
    redirectUrisText: '',
    scope: 'launch/patient patient/*.read openid profile',
    briefDescription: '',
    author: '',
    clientUri: '',
    logoUri: '',
  };

  constructor() {
    effect(() => {
      const active = this.sandboxService.activeSandbox();
      if (active) {
        untracked(() => {
          this.loadApplications(active.sandboxId);
        });
      }
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
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load applications.');
        this.loading.set(false);
      },
    });
  }

  public registerApplication(): void {
    const current = this.sandboxService.activeSandbox();
    if (!current || !this.newApplication.clientName || !this.newApplication.launchUri) {
      this.errorMessage.set('Application Name and Launch URI are required.');
      return;
    }

    const redirectUris = this.newApplication.redirectUrisText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    this.applicationsService
      .registerApplication(current.sandboxId, {
        clientName: this.newApplication.clientName,
        launchUri: this.newApplication.launchUri,
        redirectUris: redirectUris.length > 0 ? redirectUris : [this.newApplication.launchUri],
        scope: this.newApplication.scope,
        briefDescription: this.newApplication.briefDescription,
        author: this.newApplication.author,
        clientUri: this.newApplication.clientUri,
        logoUri: this.newApplication.logoUri,
        isCustom: true,
      })
      .subscribe({
        next: () => {
          this.showRegisterModal.set(false);
          this.successMessage.set(`Application '${this.newApplication.clientName}' registered successfully.`);
          this.loadApplications(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to register application.');
        },
      });
  }

  public deleteApplication(application: SmartApplication): void {
    const current = this.sandboxService.activeSandbox();
    if (!current) return;
    if (confirm(`Are you sure you want to delete application '${application.clientName}'?`)) {
      this.applicationsService.deleteApplication(current.sandboxId, application.id).subscribe({
        next: () => {
          this.successMessage.set(`Application '${application.clientName}' deleted.`);
          this.loadApplications(current.sandboxId);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete application.');
        },
      });
    }
  }
}
