// Author: Preston Lee

import { Component, OnInit, inject, signal } from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { firstValueFrom } from "rxjs";
import { HostingService } from "../core/services/hosting.service.js";
import { AuthService } from "../core/services/auth.service.js";
import {
  integrationScopeLabels,
  integrationSignInUrl,
} from "./integration-ui.js";

interface ConsentRequest {
  request_id: string;
  client: { id: string; name: string };
  scopes: string[];
  account: { subject: string; display_name: string; email?: string | null };
}

@Component({
  selector: "app-integration-consent",
  standalone: true,
  templateUrl: "./integration-consent.component.html",
  styleUrl: "./integration-consent.component.scss",
})
export class IntegrationConsentComponent implements OnInit {
  readonly auth = inject(AuthService);
  private readonly api = inject(HostingService);
  readonly request = signal<ConsentRequest | null>(null);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly scopeLabels = integrationScopeLabels;
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
    if (this.auth.isAuthenticated()) await this.load();
  }
  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      this.request.set(
        await this.api.get<ConsentRequest>(
          `/api/integration/authorization${window.location.search}`,
        ),
      );
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error ||
              error.error?.message ||
              "This authorization request is invalid or expired. Return to Skycapp and connect again."
          : "Unable to load authorization. Retry to continue.",
      );
    } finally {
      this.busy.set(false);
    }
  }
  async decide(approve: boolean): Promise<void> {
    const request = this.request();
    if (!request || this.busy()) return;
    this.busy.set(true);
    this.error.set("");
    try {
      const response = await this.api.post<{ redirect_url: string }>(
        `/api/integration/authorization/${encodeURIComponent(request.request_id)}`,
        { approve },
      );
      const redirect = new URL(response.redirect_url);
      if (
        !["http:", "https:"].includes(redirect.protocol) ||
        redirect.username ||
        redirect.password
      )
        throw new Error("Invalid authorization callback.");
      window.location.assign(redirect.toString());
    } catch (error) {
      this.error.set(
        error instanceof HttpErrorResponse
          ? error.error?.error ||
              error.error?.message ||
              "Authorization could not be completed. Try connecting again."
          : "Authorization could not be completed. Try connecting again.",
      );
      this.busy.set(false);
    }
  }
}
