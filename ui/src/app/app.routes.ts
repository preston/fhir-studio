// Author: Preston Lee

import type { Routes } from '@angular/router';
import { SandboxesListComponent } from './sandboxes/sandboxes-list.component.js';
import { EhrSimulatorComponent } from './ehr-simulator/ehr-simulator.component.js';
import { DataManagerComponent } from './data-manager/data-manager.component.js';
import { ApplicationsManagerComponent } from './applications/applications-manager.component.js';
import { ScenariosManagerComponent } from './scenarios/scenarios-manager.component.js';
import { PersonasManagerComponent } from './personas/personas-manager.component.js';
import { RegistryImporterComponent } from './registry-importer/registry-importer.component.js';
import { AdministrationDashboardComponent } from './administration/administration-dashboard.component.js';
import { AdminMetricsComponent } from './administration/metrics/admin-metrics.component.js';
import { AdminUsersComponent } from './administration/users/admin-users.component.js';
import { AdminGroupsComponent } from './administration/groups/admin-groups.component.js';
import { AdminRolesComponent } from './administration/roles/admin-roles.component.js';
import { AdminAppointmentsComponent } from './administration/appointments/admin-appointments.component.js';
import { AdminJobsComponent } from './administration/jobs/admin-jobs.component.js';
import { AdminPurgeComponent } from './administration/purge/admin-purge.component.js';
import { AdministrationImplementationGuidesComponent } from './administration/implementation-guides/administration-implementation-guides.component.js';
import { ExampleApplicationComponent } from './example-application/example-application.component.js';
import { permissionGuard } from './core/guards/permission.guard.js';

export const routes: Routes = [
  { path: '', component: SandboxesListComponent },
  { path: 'sandboxes', component: SandboxesListComponent },
  {
    path: 'ehr-simulator',
    component: EhrSimulatorComponent,
    canActivate: [permissionGuard('ehr_simulator')],
  },
  {
    path: 'data-manager',
    component: DataManagerComponent,
    canActivate: [permissionGuard('data_manager')],
  },
  { path: 'applications', component: ApplicationsManagerComponent },
  { path: 'apps', redirectTo: 'applications', pathMatch: 'full' },
  { path: 'example-application', component: ExampleApplicationComponent },
  { path: 'example-application/launch', component: ExampleApplicationComponent },
  { path: 'scenarios', component: ScenariosManagerComponent },
  { path: 'personas', component: PersonasManagerComponent },
  {
    path: 'registry-importer',
    component: RegistryImporterComponent,
    canActivate: [permissionGuard('package_import')],
  },
  {
    path: 'administration',
    component: AdministrationDashboardComponent,
    canActivate: [permissionGuard('global_manage')],
    children: [
      { path: '', redirectTo: 'metrics', pathMatch: 'full' },
      { path: 'metrics', component: AdminMetricsComponent },
      { path: 'users', component: AdminUsersComponent },
      { path: 'groups', component: AdminGroupsComponent },
      { path: 'roles', component: AdminRolesComponent },
      { path: 'appointments', component: AdminAppointmentsComponent },
      { path: 'jobs', component: AdminJobsComponent },
      { path: 'implementation-guides', component: AdministrationImplementationGuidesComponent },
      { path: 'igs', redirectTo: 'implementation-guides', pathMatch: 'full' },
      { path: 'purge', component: AdminPurgeComponent },
    ],
  },
  { path: '**', redirectTo: '' },
];
