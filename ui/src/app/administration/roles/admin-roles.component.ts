// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { form, FormField, required, submit } from '@angular/forms/signals';
import {
  AdministrationService,
  type AdministrationRole,
} from '../../core/services/administration.service.js';

export type RoleSortField = 'name' | 'ssoRoleMapping' | 'default';

interface RoleFormModel {
  name: string;
  description: string;
  default: boolean;
  ssoRoleMapping: string;
  permission_sandboxes_create: boolean;
  permission_sandboxes_shared: boolean;
  permission_ehr_simulator: boolean;
  permission_data_manager: boolean;
  permission_applications_register: boolean;
  permission_package_import: boolean;
  permission_global_manage: boolean;
}

const EMPTY_ROLE_FORM: RoleFormModel = {
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

@Component({
  selector: 'app-admin-roles',
  standalone: true,
  imports: [CommonModule, FormsModule, FormField],
  templateUrl: './admin-roles.component.html',
})
export class AdminRolesComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly roles = signal<AdministrationRole[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Search, Sort, Pagination state
  public readonly search = signal<string>('');
  public readonly sortBy = signal<RoleSortField>('name');
  public readonly sortOrder = signal<'asc' | 'desc'>('asc');
  public readonly page = signal<number>(1);
  public readonly limit = signal<number>(10);

  // Modals & Forms
  public readonly showRoleModal = signal<boolean>(false);
  public readonly isEditing = signal<boolean>(false);
  public currentRoleId: string | null = null;

  public readonly roleModel = signal<RoleFormModel>({ ...EMPTY_ROLE_FORM });
  public readonly roleForm = form(this.roleModel, (s) => {
    required(s.name, { message: 'Role name is required' });
  });

  public readonly filteredRoles = computed(() => {
    let list = this.roles();
    const query = this.search().trim().toLowerCase();

    if (query) {
      list = list.filter((r) => {
        const name = r.name.toLowerCase();
        const desc = (r.description || '').toLowerCase();
        const sso = (r.ssoRoleMapping || '').toLowerCase();
        return name.includes(query) || desc.includes(query) || sso.includes(query);
      });
    }

    const field = this.sortBy();
    const order = this.sortOrder() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA: string | number = '';
      let valB: string | number = '';

      switch (field) {
        case 'name':
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
          break;
        case 'ssoRoleMapping':
          valA = (a.ssoRoleMapping || '').toLowerCase();
          valB = (b.ssoRoleMapping || '').toLowerCase();
          break;
        case 'default':
          valA = a.default ? 1 : 0;
          valB = b.default ? 1 : 0;
          break;
      }

      if (valA < valB) return -1 * order;
      if (valA > valB) return 1 * order;
      return 0;
    });
  });

  public readonly totalRolesCount = computed(() => this.filteredRoles().length);

  public readonly totalPages = computed(() => {
    const total = this.totalRolesCount();
    const perPage = this.limit();
    return Math.max(1, Math.ceil(total / perPage));
  });

  public readonly paginatedRoles = computed(() => {
    const list = this.filteredRoles();
    const currentPage = Math.min(this.page(), this.totalPages());
    const perPage = this.limit();
    const start = (currentPage - 1) * perPage;
    return list.slice(start, start + perPage);
  });

  ngOnInit(): void {
    this.loadRoles();
  }

  public loadRoles(): void {
    this.loading.set(true);
    this.administrationService.getRoles().subscribe({
      next: (res) => {
        this.roles.set(res.roles);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load roles.');
        this.loading.set(false);
      },
    });
  }

  public onSearchChange(val: string): void {
    this.search.set(val);
    this.page.set(1);
  }

  public setSort(field: RoleSortField): void {
    if (this.sortBy() === field) {
      this.sortOrder.update((o) => (o === 'asc' ? 'desc' : 'asc'));
    } else {
      this.sortBy.set(field);
      this.sortOrder.set('asc');
    }
    this.page.set(1);
  }

  public setPage(p: number): void {
    if (p < 1 || p > this.totalPages()) return;
    this.page.set(p);
  }

  public setLimit(l: number): void {
    this.limit.set(Number(l));
    this.page.set(1);
  }

  public resetFilters(): void {
    this.search.set('');
    this.sortBy.set('name');
    this.sortOrder.set('asc');
    this.page.set(1);
  }

  public getShowingStart(): number {
    if (this.totalRolesCount() === 0) return 0;
    return (this.page() - 1) * this.limit() + 1;
  }

  public getShowingEnd(): number {
    return Math.min(this.page() * this.limit(), this.totalRolesCount());
  }

  public openNewRoleModal(): void {
    this.isEditing.set(false);
    this.currentRoleId = null;
    this.roleModel.set({ ...EMPTY_ROLE_FORM });
    this.showRoleModal.set(true);
  }

  public openEditRoleModal(role: AdministrationRole): void {
    this.isEditing.set(true);
    this.currentRoleId = role.id;
    this.roleModel.set({
      name: role.name,
      description: role.description || '',
      default: role.default,
      ssoRoleMapping: role.ssoRoleMapping || '',
      permission_sandboxes_create: role.permission_sandboxes_create,
      permission_sandboxes_shared: role.permission_sandboxes_shared,
      permission_ehr_simulator: role.permission_ehr_simulator,
      permission_data_manager: role.permission_data_manager,
      permission_applications_register: role.permission_applications_register,
      permission_package_import: role.permission_package_import,
      permission_global_manage: role.permission_global_manage,
    });
    this.showRoleModal.set(true);
  }

  public async saveRole(): Promise<void> {
    try {
      const ok = await submit(this.roleForm, async () => {
        const payload = this.roleModel();
        if (this.isEditing() && this.currentRoleId) {
          await new Promise<void>((resolve, reject) => {
            this.administrationService.updateRole(this.currentRoleId!, payload).subscribe({
              next: () => {
                this.showRoleModal.set(false);
                this.successMessage.set('Role updated.');
                this.loadRoles();
                resolve();
              },
              error: (err) => {
                this.errorMessage.set(err?.error?.error || 'Failed to update role.');
                reject(err);
              },
            });
          });
        } else {
          await new Promise<void>((resolve, reject) => {
            this.administrationService.createRole(payload).subscribe({
              next: () => {
                this.showRoleModal.set(false);
                this.successMessage.set('Role created.');
                this.loadRoles();
                resolve();
              },
              error: (err) => {
                this.errorMessage.set(err?.error?.error || 'Failed to create role.');
                reject(err);
              },
            });
          });
        }
      });

      if (!ok) {
        this.errorMessage.set('Role name is required.');
      }
    } catch {
      // Error message already set in subscribe handler.
    }
  }

  public deleteRole(roleId: string): void {
    if (confirm('Delete this role?')) {
      this.administrationService.deleteRole(roleId).subscribe({
        next: () => {
          this.successMessage.set('Role deleted.');
          this.loadRoles();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete role.');
        },
      });
    }
  }
}
