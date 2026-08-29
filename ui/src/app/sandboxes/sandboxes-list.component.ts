// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { SandboxService, type Sandbox, type SandboxCollaborator } from '../core/services/sandbox.service.js';
import { AuthService } from '../core/services/auth.service.js';

export interface SelectableIgOption {
  id: string;
  name: string;
  title: string;
  version: string;
  description: string;
  category: string;
  selected: boolean;
}

@Component({
  selector: 'app-sandboxes-list',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './sandboxes-list.component.html',
  styleUrls: ['./sandboxes-list.component.scss'],
})
export class SandboxesListComponent implements OnInit {
  public readonly sandboxService = inject(SandboxService);
  public readonly auth = inject(AuthService);

  public readonly sandboxes = this.sandboxService.sandboxes;
  public readonly loading = signal<boolean>(false);
  public readonly errorMessage = signal<string | null>(null);
  public readonly successMessage = signal<string | null>(null);

  // New Sandbox Form
  public readonly showCreateModal = signal<boolean>(false);
  public newSandbox = {
    name: '',
    sandboxId: '',
    description: '',
    fhirVersion: 'R4' as 'R4' | 'R4B' | 'R5',
    allowOpenAccess: false,
    visibility: 'PRIVATE' as 'PUBLIC' | 'PRIVATE',
    isShared: false,
    seedData: true,
  };

  // Notable IGs for creation wizard
  public igOptions: SelectableIgOption[] = [
    {
      id: 'us-core-7',
      name: 'hl7.fhir.us.core',
      title: 'US Core v7.0.0 (Latest Final)',
      version: '7.0.0',
      description: 'ONC HTI-1 & USCDI v3/v4 compliance profiles',
      category: 'US Core',
      selected: true,
    },
    {
      id: 'us-core-6',
      name: 'hl7.fhir.us.core',
      title: 'US Core v6.1.0',
      version: '6.1.0',
      description: 'USCDI v3 compliant profiles',
      category: 'US Core',
      selected: false,
    },
    {
      id: 'us-core-8',
      name: 'hl7.fhir.us.core',
      title: 'US Core v8.0.0',
      version: '8.0.0',
      description: 'USCDI v4/v5 advanced profiles',
      category: 'US Core',
      selected: false,
    },
    {
      id: 'smart-app-launch',
      name: 'hl7.fhir.uv.smart-app-launch',
      title: 'SMART App Launch v2.2.0',
      version: '2.2.0',
      description: 'SMART on FHIR v2 authentication profiles',
      category: 'SMART',
      selected: true,
    },
    {
      id: 'mcode',
      name: 'hl7.fhir.us.mcode',
      title: 'mCODE v3.0.0',
      version: '3.0.0',
      description: 'Minimal Common Oncology Data Elements',
      category: 'Clinical',
      selected: false,
    },
    {
      id: 'carin-bb',
      name: 'hl7.fhir.us.carin-bb',
      title: 'CARIN Blue Button v2.0.0',
      version: '2.0.0',
      description: 'Consumer directed payer & claim data exchange',
      category: 'Financial',
      selected: false,
    },
    {
      id: 'davinci-crd',
      name: 'hl7.fhir.us.davinci-crd',
      title: 'Da Vinci CRD v2.0.1',
      version: '2.0.1',
      description: 'Coverage Requirements Discovery',
      category: 'Da Vinci',
      selected: false,
    },
    {
      id: 'davinci-dtr',
      name: 'hl7.fhir.us.davinci-dtr',
      title: 'Da Vinci DTR v2.0.0',
      version: '2.0.0',
      description: 'Documentation Templates and Rules',
      category: 'Da Vinci',
      selected: false,
    },
  ];

  // Collaborator Modal
  public readonly showCollaboratorModal = signal<boolean>(false);
  public readonly selectedSandboxForCollab = signal<Sandbox | null>(null);
  public newCollaboratorEmail = '';
  public newCollaboratorRole = 'READ_WRITE';

  // Count computed signals for summary analytics
  public readonly r4Count = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R4').length);
  public readonly r4bCount = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R4B').length);
  public readonly r5Count = computed(() => this.sandboxes().filter((s) => s.fhirVersion === 'R5').length);
  public readonly securedCount = computed(() => this.sandboxes().filter((s) => !s.allowOpenAccess).length);
  public readonly openCount = computed(() => this.sandboxes().filter((s) => s.allowOpenAccess).length);

  ngOnInit(): void {
    this.loadSandboxes();
  }

  public loadSandboxes(): void {
    this.loading.set(true);
    this.sandboxService.getSandboxes().subscribe({
      next: () => {
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load sandboxes.');
        this.loading.set(false);
      },
    });
  }

  public onNameChange(): void {
    if (!this.newSandbox.sandboxId || this.newSandbox.sandboxId.length === 0) {
      this.newSandbox.sandboxId = this.newSandbox.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-');
    }
  }

  public openCreateModal(): void {
    this.newSandbox = {
      name: '',
      sandboxId: '',
      description: '',
      fhirVersion: 'R4',
      allowOpenAccess: false,
      visibility: 'PRIVATE',
      isShared: false,
      seedData: true,
    };
    this.showCreateModal.set(true);
  }

  public createSandbox(): void {
    if (!this.newSandbox.name || !this.newSandbox.sandboxId) {
      this.errorMessage.set('Name and Sandbox ID slug are required.');
      return;
    }

    const selectedIgs = this.igOptions
      .filter((ig) => ig.selected)
      .map((ig) => `${ig.name}@${ig.version}`);

    this.loading.set(true);
    this.sandboxService
      .createSandbox({
        ...this.newSandbox,
        initialIgs: selectedIgs,
      })
      .subscribe({
        next: () => {
          this.showCreateModal.set(false);
          this.successMessage.set(`Sandbox '${this.newSandbox.name}' created with ${selectedIgs.length} selected IG packages.`);
          this.loadSandboxes();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create sandbox.');
          this.loading.set(false);
        },
      });
  }

  public resetPartition(sandbox: Sandbox): void {
    if (confirm(`Are you sure you want to reset all FHIR data in sandbox '${sandbox.name}'?`)) {
      this.sandboxService.resetSandbox(sandbox.sandboxId).subscribe({
        next: (res) => {
          this.successMessage.set(res.message);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to reset partition.');
        },
      });
    }
  }

  public deleteSandbox(sandbox: Sandbox): void {
    if (confirm(`Are you sure you want to permanently delete sandbox '${sandbox.name}'?`)) {
      this.sandboxService.deleteSandbox(sandbox.sandboxId).subscribe({
        next: () => {
          this.successMessage.set(`Sandbox '${sandbox.name}' deleted.`);
          this.loadSandboxes();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete sandbox.');
        },
      });
    }
  }

  public openCollaboratorsModal(sandbox: Sandbox): void {
    this.selectedSandboxForCollab.set(sandbox);
    this.newCollaboratorEmail = '';
    this.showCollaboratorModal.set(true);
  }

  public addCollaborator(): void {
    const selected = this.selectedSandboxForCollab();
    if (!selected || !this.newCollaboratorEmail) return;
    this.sandboxService
      .addCollaborator(
        selected.sandboxId,
        this.newCollaboratorEmail,
        this.newCollaboratorRole,
      )
      .subscribe({
        next: () => {
          this.successMessage.set(`Collaborator ${this.newCollaboratorEmail} added.`);
          this.newCollaboratorEmail = '';
          this.loadSandboxes();
          this.showCollaboratorModal.set(false);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to add collaborator.');
        },
      });
  }

  public removeCollaborator(sandbox: Sandbox, userId: string): void {
    this.sandboxService.removeCollaborator(sandbox.sandboxId, userId).subscribe({
      next: () => {
        this.loadSandboxes();
        this.showCollaboratorModal.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to remove collaborator.');
      },
    });
  }
}
