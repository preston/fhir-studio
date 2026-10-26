// Author: Preston Lee

import { Component, OnInit, inject, signal } from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { Router } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { HostingService } from "../core/services/hosting.service.js";
import { AuthService } from "../core/services/auth.service.js";
import {
  integrationSignInUrl,
  verifiedLauncherPath,
} from "./integration-ui.js";

@Component({
  selector: "app-integration-handoff",
  standalone: true,
  templateUrl: "./integration-handoff.component.html",
  styleUrl: "./integration-handoff.component.scss",
})
export class IntegrationHandoffComponent implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(HostingService);
  private readonly router = inject(Router);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly accountMismatch = signal(false);
  readonly loginUrl = integrationSignInUrl(
    window.location.pathname,
    window.location.search,
  );
  readonly switchAccountUrl = integrationSignInUrl(
    window.location.pathname,
    window.location.search,
    true,
  );
  async ngOnInit(): Promise<void> {
    if (!this.auth.isInitialized())
      await firstValueFrom(this.auth.loadSession());
    if (this.auth.isAuthenticated()) await this.open();
  }
  async open(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    this.accountMismatch.set(false);
    try {
      const response = await this.api.get<{ launch_url: string }>(
        `/api/integration/handoff${window.location.search}`,
      );
      const path = verifiedLauncherPath(
        response.launch_url,
        window.location.origin,
      );
      if (!path)
        throw new Error("Studio returned an invalid launcher destination.");
      await this.router.navigateByUrl(path);
    } catch (error) {
      this.accountMismatch.set(
        error instanceof HttpErrorResponse && error.status === 409,
      );
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error ||
              error.error?.message ||
              "The application or sandbox is unavailable for this account."
          : error instanceof Error
            ? error.message
            : "Unable to open the application.",
      );
    } finally {
      this.busy.set(false);
    }
  }
}
