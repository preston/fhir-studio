// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdministrationService,
  type AdministrationAppointment,
  type AdministrationUser,
  type AdministrationGroup,
  type AdministrationRole,
} from '../../core/services/administration.service.js';

export type AppointmentSortField = 'entityType' | 'entityId' | 'roleName' | 'createdAt';

@Component({
  selector: 'app-admin-appointments',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-appointments.component.html',
})
export class AdminAppointmentsComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly appointments = signal<AdministrationAppointment[]>([]);
  public readonly users = signal<AdministrationUser[]>([]);
  public readonly groups = signal<AdministrationGroup[]>([]);
  public readonly roles = signal<AdministrationRole[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Search, Sort, Pagination state
  public readonly search = signal<string>('');
  public readonly entityTypeFilter = signal<'all' | 'User' | 'Group'>('all');
  public readonly sortBy = signal<AppointmentSortField>('createdAt');
  public readonly sortOrder = signal<'asc' | 'desc'>('desc');
  public readonly page = signal<number>(1);
  public readonly limit = signal<number>(10);

  // Modals & Forms
  public readonly showAppointmentModal = signal<boolean>(false);
  public appointmentForm = {
    entityType: 'User' as 'User' | 'Group',
    entityId: '',
    roleId: '',
  };

  public readonly filteredAppointments = computed(() => {
    let list = this.appointments();
    const query = this.search().trim().toLowerCase();
    const entityType = this.entityTypeFilter();

    if (query) {
      list = list.filter((a) => {
        const id = a.entityId.toLowerCase();
        const role = (a.role?.name || '').toLowerCase();
        const type = a.entityType.toLowerCase();
        return id.includes(query) || role.includes(query) || type.includes(query);
      });
    }

    if (entityType !== 'all') {
      list = list.filter((a) => a.entityType === entityType);
    }

    const field = this.sortBy();
    const order = this.sortOrder() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA: any = '';
      let valB: any = '';

      switch (field) {
        case 'entityType':
          valA = a.entityType.toLowerCase();
          valB = b.entityType.toLowerCase();
          break;
        case 'entityId':
          valA = a.entityId.toLowerCase();
          valB = b.entityId.toLowerCase();
          break;
        case 'roleName':
          valA = (a.role?.name || '').toLowerCase();
          valB = (b.role?.name || '').toLowerCase();
          break;
        case 'createdAt':
          valA = new Date(a.createdAt).getTime();
          valB = new Date(b.createdAt).getTime();
          break;
      }

      if (valA < valB) return -1 * order;
      if (valA > valB) return 1 * order;
      return 0;
    });
  });

  public readonly totalAppointmentsCount = computed(() => this.filteredAppointments().length);

  public readonly totalPages = computed(() => {
    const total = this.totalAppointmentsCount();
    const perPage = this.limit();
    return Math.max(1, Math.ceil(total / perPage));
  });

  public readonly paginatedAppointments = computed(() => {
    const list = this.filteredAppointments();
    const currentPage = Math.min(this.page(), this.totalPages());
    const perPage = this.limit();
    const start = (currentPage - 1) * perPage;
    return list.slice(start, start + perPage);
  });

  ngOnInit(): void {
    this.loadData();
  }

  public loadData(): void {
    this.loading.set(true);
    this.administrationService.getAppointments().subscribe({
      next: (res) => {
        this.appointments.set(res.appointments);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load appointments.');
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
  }

  public onSearchChange(val: string): void {
    this.search.set(val);
    this.page.set(1);
  }

  public onEntityTypeFilterChange(val: 'all' | 'User' | 'Group'): void {
    this.entityTypeFilter.set(val);
    this.page.set(1);
  }

  public setSort(field: AppointmentSortField): void {
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
    this.entityTypeFilter.set('all');
    this.sortBy.set('createdAt');
    this.sortOrder.set('desc');
    this.page.set(1);
  }

  public getShowingStart(): number {
    if (this.totalAppointmentsCount() === 0) return 0;
    return (this.page() - 1) * this.limit() + 1;
  }

  public getShowingEnd(): number {
    return Math.min(this.page() * this.limit(), this.totalAppointmentsCount());
  }

  public openNewAppointmentModal(): void {
    const firstUser = this.users()[0];
    const firstRole = this.roles()[0];
    this.appointmentForm = {
      entityType: 'User',
      entityId: firstUser ? firstUser.id : '',
      roleId: firstRole ? firstRole.id : '',
    };
    this.showAppointmentModal.set(true);
  }

  public saveAppointment(): void {
    if (!this.appointmentForm.entityId || !this.appointmentForm.roleId) return;
    this.administrationService.createAppointment(this.appointmentForm).subscribe({
      next: () => {
        this.showAppointmentModal.set(false);
        this.successMessage.set('Appointment created.');
        this.loadData();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to create appointment.');
      },
    });
  }

  public deleteAppointment(id: string): void {
    if (confirm('Delete this appointment?')) {
      this.administrationService.deleteAppointment(id).subscribe({
        next: () => {
          this.successMessage.set('Appointment deleted.');
          this.loadData();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete appointment.');
        },
      });
    }
  }
}
