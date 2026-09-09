// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { form, FormField, submit } from '@angular/forms/signals';
import {
  AdministrationService,
  type AdministrationUser,
  type AdministrationGroup,
  type AdministrationRole,
} from '../../core/services/administration.service.js';

export type UserSortField = 'name' | 'email' | 'sessions' | 'status' | 'createdAt';

interface UserProfileFormModel {
  displayName: string;
  email: string;
  isSuspended: boolean;
}

@Component({
  selector: 'app-admin-users',
  standalone: true,
  imports: [CommonModule, FormsModule, FormField],
  templateUrl: './admin-users.component.html',
})
export class AdminUsersComponent implements OnInit {
  public readonly administrationService = inject(AdministrationService);

  public readonly users = signal<AdministrationUser[]>([]);
  public readonly allGroups = signal<AdministrationGroup[]>([]);
  public readonly allRoles = signal<AdministrationRole[]>([]);
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

  // Modal state
  public readonly showUserModal = signal<boolean>(false);
  public readonly editingUser = signal<AdministrationUser | null>(null);
  public readonly selectedGroupId = signal<string>('');
  public readonly selectedRoleId = signal<string>('');
  public readonly savingProfile = signal<boolean>(false);
  public readonly mutatingMembership = signal<boolean>(false);
  public readonly mutatingAppointment = signal<boolean>(false);

  public readonly userModel = signal<UserProfileFormModel>({
    displayName: '',
    email: '',
    isSuspended: false,
  });
  public readonly userForm = form(this.userModel);

  public readonly availableGroups = computed(() => {
    const user = this.editingUser();
    const memberGroupIds = new Set((user?.memberships || []).map((m) => m.group.id));
    return this.allGroups().filter((g) => !memberGroupIds.has(g.id));
  });

  public readonly availableRoles = computed(() => {
    const user = this.editingUser();
    const appointedRoleIds = new Set((user?.appointments || []).map((a) => a.role.id));
    return this.allRoles().filter((r) => !appointedRoleIds.has(r.id));
  });

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
      let valA: string | number = '';
      let valB: string | number = '';

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
    this.loadGroupsAndRoles();
  }

  public loadUsers(): void {
    this.loading.set(true);
    this.administrationService.getUsers().subscribe({
      next: (res) => {
        this.users.set(res.users);
        const editingId = this.editingUser()?.id;
        if (editingId) {
          const refreshed = res.users.find((u) => u.id === editingId) || null;
          this.editingUser.set(refreshed);
          if (refreshed) {
            this.userModel.set({
              displayName: refreshed.displayName || '',
              email: refreshed.email || '',
              isSuspended: refreshed.isSuspended,
            });
          } else {
            this.showUserModal.set(false);
          }
        }
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to load users.');
        this.loading.set(false);
      },
    });
  }

  public loadGroupsAndRoles(): void {
    this.administrationService.getGroups().subscribe({
      next: (res) => this.allGroups.set(res.groups),
      error: (err) => this.errorMessage.set(err?.error?.error || 'Failed to load groups.'),
    });
    this.administrationService.getRoles().subscribe({
      next: (res) => this.allRoles.set(res.roles),
      error: (err) => this.errorMessage.set(err?.error?.error || 'Failed to load roles.'),
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

  public openEditUserModal(user: AdministrationUser): void {
    this.editingUser.set(user);
    this.userModel.set({
      displayName: user.displayName || '',
      email: user.email || '',
      isSuspended: user.isSuspended,
    });
    this.selectedGroupId.set('');
    this.selectedRoleId.set('');
    this.showUserModal.set(true);
  }

  public closeUserModal(): void {
    this.showUserModal.set(false);
    this.editingUser.set(null);
  }

  public async saveUserProfile(): Promise<void> {
    const user = this.editingUser();
    if (!user) return;

    this.savingProfile.set(true);
    try {
      await submit(this.userForm, async () => {
        const payload = this.userModel();
        await new Promise<void>((resolve, reject) => {
          this.administrationService
            .updateUser(user.id, {
              displayName: payload.displayName || null,
              email: payload.email || null,
              isSuspended: payload.isSuspended,
            })
            .subscribe({
              next: () => {
                this.successMessage.set('User profile updated.');
                this.loadUsers();
                resolve();
              },
              error: (err) => {
                this.errorMessage.set(err?.error?.error || 'Failed to update user.');
                reject(err);
              },
            });
        });
      });
    } catch {
      // Error message already set in subscribe handler.
    } finally {
      this.savingProfile.set(false);
    }
  }

  public addGroupMembership(): void {
    const user = this.editingUser();
    const groupId = this.selectedGroupId();
    if (!user || !groupId) return;

    this.mutatingMembership.set(true);
    this.administrationService.addGroupMember(groupId, user.id).subscribe({
      next: () => {
        this.successMessage.set('User added to group.');
        this.selectedGroupId.set('');
        this.mutatingMembership.set(false);
        this.loadUsers();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to add group membership.');
        this.mutatingMembership.set(false);
      },
    });
  }

  public removeGroupMembership(groupId: string): void {
    const user = this.editingUser();
    if (!user) return;

    this.mutatingMembership.set(true);
    this.administrationService.removeGroupMember(groupId, user.id).subscribe({
      next: () => {
        this.successMessage.set('User removed from group.');
        this.mutatingMembership.set(false);
        this.loadUsers();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to remove group membership.');
        this.mutatingMembership.set(false);
      },
    });
  }

  public addRoleAppointment(): void {
    const user = this.editingUser();
    const roleId = this.selectedRoleId();
    if (!user || !roleId) return;

    this.mutatingAppointment.set(true);
    this.administrationService
      .createAppointment({
        entityType: 'User',
        entityId: user.id,
        roleId,
      })
      .subscribe({
        next: () => {
          this.successMessage.set('Role appointed to user.');
          this.selectedRoleId.set('');
          this.mutatingAppointment.set(false);
          this.loadUsers();
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || 'Failed to appoint role.');
          this.mutatingAppointment.set(false);
        },
      });
  }

  public removeRoleAppointment(appointmentId: string): void {
    this.mutatingAppointment.set(true);
    this.administrationService.deleteAppointment(appointmentId).subscribe({
      next: () => {
        this.successMessage.set('Role appointment removed.');
        this.mutatingAppointment.set(false);
        this.loadUsers();
      },
      error: (err) => {
        this.errorMessage.set(err?.error?.error || 'Failed to remove role appointment.');
        this.mutatingAppointment.set(false);
      },
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
          const editing = this.editingUser();
          if (editing?.id === user.id) {
            this.editingUser.set({ ...editing, isSuspended: nextState });
            this.userModel.update((m) => ({ ...m, isSuspended: nextState }));
          }
          this.successMessage.set(`User account ${action}ed successfully.`);
        },
        error: (err) => {
          this.errorMessage.set(err?.error?.error || `Failed to ${action} user.`);
        },
      });
    }
  }
}
