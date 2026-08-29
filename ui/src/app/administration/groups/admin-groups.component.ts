// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  AdministrationService,
  type AdministrationGroup,
} from '../../core/services/administration.service.js';

export type GroupSortField = 'name' | 'description' | 'ssoRoleMapping' | 'membersCount';

@Component({
  selector: 'app-admin-groups',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-groups.component.html',
})
export class AdminGroupsComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly groups = signal<AdministrationGroup[]>([]);
  public readonly loading = signal<boolean>(false);
  public readonly successMessage = signal<string | null>(null);
  public readonly errorMessage = signal<string | null>(null);

  // Search, Sort, Pagination state
  public readonly search = signal<string>('');
  public readonly sortBy = signal<GroupSortField>('name');
  public readonly sortOrder = signal<'asc' | 'desc'>('asc');
  public readonly page = signal<number>(1);
  public readonly limit = signal<number>(10);

  // Modals & Forms
  public readonly showGroupModal = signal<boolean>(false);
  public groupForm = { id: '', name: '', description: '', ssoRoleMapping: '' };

  public readonly filteredGroups = computed(() => {
    let list = this.groups();
    const query = this.search().trim().toLowerCase();

    if (query) {
      list = list.filter((g) => {
        const name = g.name.toLowerCase();
        const desc = (g.description || '').toLowerCase();
        const sso = (g.ssoRoleMapping || '').toLowerCase();
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
        case 'description':
          valA = (a.description || '').toLowerCase();
          valB = (b.description || '').toLowerCase();
          break;
        case 'ssoRoleMapping':
          valA = (a.ssoRoleMapping || '').toLowerCase();
          valB = (b.ssoRoleMapping || '').toLowerCase();
          break;
        case 'membersCount':
          valA = a.members?.length || 0;
          valB = b.members?.length || 0;
          break;
      }

      if (valA < valB) return -1 * order;
      if (valA > valB) return 1 * order;
      return 0;
    });
  });

  public readonly totalGroupsCount = computed(() => this.filteredGroups().length);

  public readonly totalPages = computed(() => {
    const total = this.totalGroupsCount();
    const perPage = this.limit();
    return Math.max(1, Math.ceil(total / perPage));
  });

  public readonly paginatedGroups = computed(() => {
    const list = this.filteredGroups();
    const currentPage = Math.min(this.page(), this.totalPages());
    const perPage = this.limit();
    const start = (currentPage - 1) * perPage;
    return list.slice(start, start + perPage);
  });

  ngOnInit(): void {
    this.loadGroups();
  }

  public loadGroups(): void {
    this.loading.set(true);
    this.administrationService.getGroups().subscribe({
      next: (res) => {
        this.groups.set(res.groups);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load groups.');
        this.loading.set(false);
      },
    });
  }

  public onSearchChange(val: string): void {
    this.search.set(val);
    this.page.set(1);
  }

  public setSort(field: GroupSortField): void {
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
    if (this.totalGroupsCount() === 0) return 0;
    return (this.page() - 1) * this.limit() + 1;
  }

  public getShowingEnd(): number {
    return Math.min(this.page() * this.limit(), this.totalGroupsCount());
  }

  public openNewGroupModal(): void {
    this.groupForm = { id: '', name: '', description: '', ssoRoleMapping: '' };
    this.showGroupModal.set(true);
  }

  public saveGroup(): void {
    if (!this.groupForm.name) return;
    if (this.groupForm.id) {
      this.administrationService.updateGroup(this.groupForm.id, this.groupForm).subscribe({
        next: () => {
          this.showGroupModal.set(false);
          this.successMessage.set('Group updated.');
          this.loadGroups();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to update group.');
        },
      });
    } else {
      this.administrationService.createGroup(this.groupForm).subscribe({
        next: () => {
          this.showGroupModal.set(false);
          this.successMessage.set('Group created.');
          this.loadGroups();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to create group.');
        },
      });
    }
  }

  public deleteGroup(groupId: string): void {
    if (confirm('Delete this group?')) {
      this.administrationService.deleteGroup(groupId).subscribe({
        next: () => {
          this.successMessage.set('Group deleted.');
          this.loadGroups();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to delete group.');
        },
      });
    }
  }
}
