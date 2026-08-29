// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdministrationService,
  type AdministrationUser,
} from '../../core/services/administration.service.js';

export type UserSortField = 'name' | 'email' | 'sessions' | 'status' | 'createdAt';

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-users.component.html',
})
export class AdminUsersComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly users = signal<AdministrationUser[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Search, Filter, Sort, Pagination state
  public readonly search = signal<string>('');
  public readonly statusFilter = signal<'all' | 'active' | 'suspended'>('all');
  public readonly sortBy = signal<UserSortField>('createdAt');
  public readonly sortOrder = signal<'asc' | 'desc'>('desc');
  public readonly page = signal<number>(1);
  public readonly limit = signal<number>(10);

  public readonly filteredUsers = computed(() => {
    let list = this.users();
    const query = this.search().trim().toLowerCase();
    const status = this.statusFilter();

    if (query) {
      list = list.filter((u) => {
        const name = (u.displayName || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        const sub = (u.ssoSubject || '').toLowerCase();
        const id = u.id.toLowerCase();
        return name.includes(query) || email.includes(query) || sub.includes(query) || id.includes(query);
      });
    }

    if (status === 'active') {
      list = list.filter((u) => !u.isSuspended);
    } else if (status === 'suspended') {
      list = list.filter((u) => u.isSuspended);
    }

    const field = this.sortBy();
    const order = this.sortOrder() === 'asc' ? 1 : -1;

    return [...list].sort((a, b) => {
      let valA: any = '';
      let valB: any = '';

      switch (field) {
        case 'name':
          valA = (a.displayName || a.email || '').toLowerCase();
          valB = (b.displayName || b.email || '').toLowerCase();
          break;
        case 'email':
          valA = (a.email || '').toLowerCase();
          valB = (b.email || '').toLowerCase();
          break;
        case 'sessions':
          valA = a._count?.sessions || 0;
          valB = b._count?.sessions || 0;
          break;
        case 'status':
          valA = a.isSuspended ? 1 : 0;
          valB = b.isSuspended ? 1 : 0;
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

  public readonly totalUsersCount = computed(() => this.filteredUsers().length);

  public readonly totalPages = computed(() => {
    const total = this.totalUsersCount();
    const perPage = this.limit();
    return Math.max(1, Math.ceil(total / perPage));
  });

  public readonly paginatedUsers = computed(() => {
    const list = this.filteredUsers();
    const currentPage = Math.min(this.page(), this.totalPages());
    const perPage = this.limit();
    const start = (currentPage - 1) * perPage;
    return list.slice(start, start + perPage);
  });

  ngOnInit(): void {
    this.loadUsers();
  }

  public loadUsers(): void {
    this.loading.set(true);
    this.administrationService.getUsers().subscribe({
      next: (res) => {
        this.users.set(res.users);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load users.');
        this.loading.set(false);
      },
    });
  }

  public onSearchChange(val: string): void {
    this.search.set(val);
    this.page.set(1);
  }

  public onStatusFilterChange(val: 'all' | 'active' | 'suspended'): void {
    this.statusFilter.set(val);
    this.page.set(1);
  }

  public setSort(field: UserSortField): void {
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
    this.statusFilter.set('all');
    this.sortBy.set('createdAt');
    this.sortOrder.set('desc');
    this.page.set(1);
  }

  public getShowingStart(): number {
    if (this.totalUsersCount() === 0) return 0;
    return (this.page() - 1) * this.limit() + 1;
  }

  public getShowingEnd(): number {
    return Math.min(this.page() * this.limit(), this.totalUsersCount());
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
}
