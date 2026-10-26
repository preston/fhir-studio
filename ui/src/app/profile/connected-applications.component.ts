// Author: Preston Lee

import { Component, OnInit, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { HttpErrorResponse } from "@angular/common/http";
import { HostingService } from "../core/services/hosting.service.js";
import { integrationScopeLabels } from "../integration/integration-ui.js";

interface ConnectedApplication {
  id: string;
  client: { id: string; name: string };
  scopes: string[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}
@Component({
  selector: "app-connected-applications",
  standalone: true,
  imports: [DatePipe],
  templateUrl: "./connected-applications.component.html",
  styleUrl: "./connected-applications.component.scss",
})
export class ConnectedApplicationsComponent implements OnInit {
  private readonly api = inject(HostingService);
  readonly connections = signal<ConnectedApplication[]>([]);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly notice = signal("");
  readonly scopeLabels = integrationScopeLabels;
  ngOnInit(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      this.connections.set(
        (
          await this.api.get<{ connections: ConnectedApplication[] }>(
            "/api/integration/connections",
          )
        ).connections,
      );
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error ||
              error.error?.message ||
              "Unable to load connected applications."
          : "Unable to load connected applications.",
      );
    } finally {
      this.busy.set(false);
    }
  }
  async revoke(connection: ConnectedApplication): Promise<void> {
    if (
      !confirm(
        `Revoke ${connection.client.name} access? Future operations and queued activation will stop. Hosted applications remain available.`,
      )
    )
      return;
    this.busy.set(true);
    this.error.set("");
    this.notice.set("");
    try {
      await this.api.delete(
        `/api/integration/connections/${encodeURIComponent(connection.id)}`,
      );
      await this.load();
      this.notice.set(
        "Access revoked. Existing hosted applications remain in Studio.",
      );
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error ||
              error.error?.message ||
              "Unable to revoke access. Retry."
          : "Unable to revoke access. Retry.",
      );
    } finally {
      this.busy.set(false);
    }
  }
}
