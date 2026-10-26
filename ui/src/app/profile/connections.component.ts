import { Component, inject, signal, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import type { GitHubConnectionStatus } from '@fhir-studio/core';
import { ConnectedApplicationsComponent } from './connected-applications.component.js';
import { HostingService } from '../core/services/hosting.service.js';

@Component({
  selector: 'app-connections',
  standalone: true,
  imports: [RouterLink, ConnectedApplicationsComponent],
  template: `
    <h2>Profile connections</h2>
    <p><a id="profile-connected-applications" routerLink="/profile/connected-applications">Manage connected catalog applications</a></p>
    <p class="text-muted">
      Manage your personal GitHub authorization and repository installations.
    </p>
    @if (error()) {
      <div class="alert alert-danger">{{ error() }}</div>
    }
    <div class="card">
      <div class="card-body">
        <h4><i class="bi bi-github me-2"></i>GitHub</h4>
        @if (connection(); as connection) {
          <p>
            Account:
            <strong>{{ connection.login || 'Not connected' }}</strong> ·
            {{ connection.status }}
          </p>
          <p class="text-muted">
            Token renewal is automatic. Repository installation access is
            managed separately from your personal connection.
          </p>
          <a
            class="btn btn-primary me-2"
            href="/api/github/connect?returnTo=/profile/connections"
            >{{ connection.login ? 'Reconnect' : 'Connect GitHub' }}</a
          >
          @if (connection.installUrl) {
            <a
              class="btn btn-outline-primary me-2"
              [href]="connection.installUrl"
              target="_blank"
              rel="noopener"
              >Manage repository access</a
            >
          }
          @if (connection.login) {
            <button
              class="btn btn-outline-danger"
              (click)="disconnect()"
              [disabled]="busy()"
            >
              Disconnect
            </button>
          }
          <ul class="list-group list-group-flush mt-3">
            @for (
              installation of connection.installations || [];
              track installation.id
            ) {
              <li class="list-group-item">
                {{ installation.account.login }} ·
                {{
                  installation.suspended_at
                    ? 'Installation suspended'
                    : 'Installation available'
                }}
                <a
                  class="ms-2"
                  [href]="
                    'https://github.com/settings/installations/' +
                    installation.id
                  "
                  target="_blank"
                  rel="noopener"
                  >Configure</a
                >
              </li>
            }
          </ul>
          <h5 class="mt-3">Affected applications</h5>
          @for (app of apps(); track app.id) {
            <p class="mb-1">
              <a
                routerLink="/applications/hosted"
                [queryParams]="{ app: app.id }"
                >{{ app.name }}</a
              >
              — {{ app.repository }}
            </p>
          }
        } @else {
          <p>Loading connection status…</p>
        }
      </div>
    </div>
    <p class="mt-3 text-muted">
      Disconnecting removes your personal authorization. It does not uninstall a
      shared repository integration or remove deployed applications.
    </p>
    <app-connected-applications />
  `,
})
export class ConnectionsComponent implements OnInit {
  readonly api = inject(HostingService);
  readonly connection = signal<GitHubConnectionStatus | null>(null);
  readonly apps = signal<
    Array<{ id: string; name: string; repository: string }>
  >([]);
  readonly error = signal('');
  readonly busy = signal(false);
  ngOnInit(): void {
    void this.load();
  }
  async load(): Promise<void> {
    try {
      this.connection.set(await this.api.connection());
      this.apps.set((await this.api.list()).applications);
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error || error.message
          : 'Unable to load connection.',
      );
    }
  }
  async disconnect(): Promise<void> {
    if (
      !confirm(
        'Disconnect your GitHub authorization? Hosted files will remain available.',
      )
    )
      return;
    this.busy.set(true);
    try {
      const result = (await this.api.delete('/api/github/connection')) as {
        remoteRevocationConfirmed?: boolean;
      };
      await this.load();
      if (result.remoteRevocationConfirmed === false)
        this.error.set(
          'Local credentials were removed. GitHub was unavailable: also revoke this app in GitHub Settings → Applications.',
        );
    } catch {
      this.error.set('Disconnect failed. Try again.');
    } finally {
      this.busy.set(false);
    }
  }
}
