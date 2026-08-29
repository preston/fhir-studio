// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdministrationService,
  type AdministrationRole,
} from '../../core/services/administration.service.js';

export type RoleSortField = 'name' | 'ssoRoleMapping' | 'default';

@Component({
  selector: 'app-admin-roles',
  standalone: true,
  imports: [CommonModule, FormsModule],
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
      let valA: any = '';
      let valB: any = '';

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
    this.roleForm = {
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
    this.showRoleModal.set(true);
  }

  public saveRole(): void {
    if (!this.roleForm.name) return;
    if (this.roleForm.id) {
      this.administrationService.updateRole(this.roleForm.id, this.roleForm).subscribe({
        next: () => {
          this.showRoleModal.set(false);
          this.successMessage.set('Role updated.');
          this.loadRoles();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to update role.');
        },
      });
    } else {
      this.administrationService.createRole(this.roleForm).subscribe({
        next: () => {
          this.showRoleModal.set(false);
          this.successMessage.set('Role created.');
          this.loadRoles();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create role.');
        },
      });
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
