// Author: Preston Lee

import { Component, OnInit, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HttpErrorResponse } from "@angular/common/http";
import { HostingService } from "../../core/services/hosting.service.js";
import { integrationScopeLabels } from "../../integration/integration-ui.js";

interface IntegrationClient {
  id: string;
  name: string;
  redirect_uris: string[];
  scopes: string[];
  enabled: boolean;
  created_at: string;
}
interface ClientDraft {
  id?: string;
  name: string;
  redirect_uris: string;
  scopes: string[];
  enabled: boolean;
}
const empty = (): ClientDraft => ({
  name: "",
  redirect_uris: "",
  scopes: [
    "account:read",
    "sandbox:read",
    "applications:read",
    "applications:write",
    "applications:publish",
  ],
  enabled: false,
});
@Component({
  selector: "app-admin-integration-clients",
  standalone: true,
  imports: [FormsModule],
  templateUrl: "./admin-integration-clients.component.html",
  styleUrl: "./admin-integration-clients.component.scss",
  host: { "(window:beforeunload)": "beforeUnload($event)" },
})
export class AdminIntegrationClientsComponent implements OnInit {
  private readonly api = inject(HostingService);
  readonly clients = signal<IntegrationClient[]>([]);
  readonly draft = signal<ClientDraft>(empty());
  readonly editing = signal(false);
  readonly busy = signal(false);
  readonly error = signal("");
  readonly secret = signal("");
  readonly secretClientId = signal("");
  readonly notice = signal("");
  readonly scopeLabels = integrationScopeLabels;
  readonly scopes = Object.keys(integrationScopeLabels);
  private readonly baseline = signal(JSON.stringify(empty()));
  readonly dirty = computed(
    () => JSON.stringify(this.draft()) !== this.baseline(),
  );
  ngOnInit(): void {
    void this.load();
  }
  canDeactivate(): boolean {
    return (
      !this.dirty() || confirm("Discard unsaved integration client changes?")
    );
  }
  beforeUnload(event: BeforeUnloadEvent): void {
    if (this.dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  }
  async load(): Promise<void> {
    this.busy.set(true);
    this.error.set("");
    try {
      this.clients.set(
        (
          await this.api.get<{ clients: IntegrationClient[] }>(
            "/api/admin/integration-clients",
          )
        ).clients,
      );
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy.set(false);
    }
  }
  select(client?: IntegrationClient): void {
    if (this.dirty() && !confirm("Discard unsaved client changes?")) return;
    const value = client
      ? {
          id: client.id,
          name: client.name,
          redirect_uris: client.redirect_uris.join("\n"),
          scopes: [...client.scopes],
          enabled: client.enabled,
        }
      : empty();
    this.draft.set(value);
    this.baseline.set(JSON.stringify(value));
    this.editing.set(true);
    this.error.set("");
  }
  update<K extends keyof ClientDraft>(key: K, value: ClientDraft[K]): void {
    this.draft.update((draft) => ({ ...draft, [key]: value }));
  }
  setScope(scope: string, enabled: boolean): void {
    this.update(
      "scopes",
      enabled
        ? [...new Set([...this.draft().scopes, scope])]
        : this.draft().scopes.filter((value) => value !== scope),
    );
  }
  revert(): void {
    this.draft.set(JSON.parse(this.baseline()) as ClientDraft);
    this.error.set("");
  }
  async save(): Promise<void> {
    const draft = this.draft();
    const value = {
      name: draft.name.trim(),
      redirect_uris: draft.redirect_uris
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
      scopes: draft.scopes,
      enabled: draft.enabled,
    };
    if (!value.name || !value.redirect_uris.length || !value.scopes.length) {
      this.error.set(
        "Provide a name, exact callback URI, and allowed permissions.",
      );
      return;
    }
    this.busy.set(true);
    this.error.set("");
    this.secret.set("");
    try {
      if (draft.id) {
        await this.api.patch(
          `/api/admin/integration-clients/${encodeURIComponent(draft.id)}`,
          value,
        );
        this.baseline.set(JSON.stringify(draft));
        await this.load();
        this.select(this.clients().find((client) => client.id === draft.id));
      } else {
        const response = await this.api.post<
          IntegrationClient & { client_secret: string }
        >("/api/admin/integration-clients", value);
        this.secret.set(response.client_secret);
        this.secretClientId.set(response.id);
        this.baseline.set(JSON.stringify(this.draft()));
        await this.load();
        this.select(this.clients().find((client) => client.id === response.id));
      }
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy.set(false);
    }
  }
  async rotate(client: IntegrationClient): Promise<void> {
    if (
      !confirm(
        `Rotate the credential for ${client.name}? Existing connections will be revoked. Replace the credential in Skycapp, then reconnect each account.`,
      )
    )
      return;
    this.busy.set(true);
    this.error.set("");
    this.secret.set("");
    try {
      const response = await this.api.post<{ client_secret: string }>(
        `/api/admin/integration-clients/${encodeURIComponent(client.id)}/rotate`,
      );
      this.secret.set(response.client_secret);
      this.secretClientId.set(client.id);
    } catch (error) {
      this.failed(error);
    } finally {
      this.busy.set(false);
    }
  }
  async copySecret(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.secret());
      this.notice.set("Credential copied.");
    } catch {
      this.notice.set("Select and copy the credential below.");
    }
  }
  private failed(error: unknown): void {
    this.error.set(
      error instanceof HttpErrorResponse
        ? error.error?.error ||
            error.error?.message ||
            "Integration client operation failed. Your changes are still here."
        : "Integration client operation failed. Your changes are still here.",
    );
  }
}
