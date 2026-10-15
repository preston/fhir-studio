// Author: Preston Lee

import { Component, OnInit, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import type {
  PersonalAccessTokenListItem,
  PersonalAccessTokenMintResponse,
} from '@fhir-studio/core';
import { firstValueFrom } from 'rxjs';
import { DeployConfigKeys, readDeployConfigUrl } from '../core/deploy-config.lib.js';
import { ToastService } from '../core/services/toast.service.js';

@Component({
  selector: 'app-developer-personal-access-tokens',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './developer-personal-access-tokens.component.html',
})
export class DeveloperPersonalAccessTokensComponent implements OnInit {
  private readonly toast = inject(ToastService);
  private readonly http = inject(HttpClient);

  readonly tokens = signal<PersonalAccessTokenListItem[]>([]);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly formError = signal<string | null>(null);
  readonly mintedToken = signal<string | null>(null);

  readonly mintName = signal('');
  readonly mintExpiresAt = signal('');
  readonly showMintModal = signal(false);

  readonly renameTarget = signal<PersonalAccessTokenListItem | null>(null);
  readonly renameName = signal('');
  readonly showRenameModal = signal(false);

  readonly revokeTarget = signal<PersonalAccessTokenListItem | null>(null);
  readonly showRevokeModal = signal(false);

  readonly publicApiBaseUrl = computed(() =>
    readDeployConfigUrl(DeployConfigKeys.PUBLIC_API_BASE_URL),
  );

  readonly curlExample = computed(() => {
    const base = this.publicApiBaseUrl() || 'https://fhir-studio.example.com';
    const token = this.mintedToken() || 'fs_…';
    return [
      `curl -sS \\`,
      `  -H "Authorization: Bearer ${token}" \\`,
      `  -H "Accept: application/json" \\`,
      `  "${base}/api/knowledge/capabilities?fhirVersion=R4"`,
    ].join('\n');
  });

  ngOnInit(): void {
    void this.loadTokens();
  }

  async loadTokens(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      const res = await firstValueFrom(
        this.http.get<{ tokens: PersonalAccessTokenListItem[] }>('/api/personal-access-tokens'),
      );
      this.tokens.set(res.tokens || []);
    } catch (err: any) {
      this.errorMessage.set(err?.error?.error || 'Failed to load personal access tokens.');
    } finally {
      this.loading.set(false);
    }
  }

  openMintModal(): void {
    this.mintName.set('');
    this.mintExpiresAt.set('');
    this.formError.set(null);
    this.showMintModal.set(true);
  }

  closeMintModal(): void {
    this.showMintModal.set(false);
  }

  async confirmMint(): Promise<void> {
    this.formError.set(null);
    const name = this.mintName().trim();
    if (!name) {
      this.formError.set('Name is required.');
      return;
    }
    try {
      const expiresRaw = this.mintExpiresAt().trim();
      const body: { name: string; expiresAt?: string } = { name };
      if (expiresRaw) {
        body.expiresAt = new Date(expiresRaw).toISOString();
      }
      const res = await firstValueFrom(
        this.http.post<PersonalAccessTokenMintResponse>('/api/personal-access-tokens', body),
      );
      this.mintedToken.set(res.token);
      this.toast.success('Personal access token created. Copy it now — it will not be shown again.');
      this.showMintModal.set(false);
      await this.loadTokens();
    } catch (err: any) {
      this.toast.error(err?.error?.error || 'Failed to create personal access token.');
    }
  }

  openRenameModal(token: PersonalAccessTokenListItem): void {
    this.renameTarget.set(token);
    this.renameName.set(token.name);
    this.formError.set(null);
    this.showRenameModal.set(true);
  }

  closeRenameModal(): void {
    this.showRenameModal.set(false);
    this.renameTarget.set(null);
  }

  async confirmRename(): Promise<void> {
    this.formError.set(null);
    const target = this.renameTarget();
    const name = this.renameName().trim();
    if (!target || !name) {
      this.formError.set('Name is required.');
      return;
    }
    try {
      await firstValueFrom(
        this.http.patch(`/api/personal-access-tokens/${target.id}`, { name }),
      );
      this.toast.success('Token name updated.');
      this.closeRenameModal();
      await this.loadTokens();
    } catch (err: any) {
      this.toast.error(err?.error?.error || 'Failed to rename personal access token.');
    }
  }

  openRevokeModal(token: PersonalAccessTokenListItem): void {
    this.revokeTarget.set(token);
    this.showRevokeModal.set(true);
  }

  closeRevokeModal(): void {
    this.showRevokeModal.set(false);
    this.revokeTarget.set(null);
  }

  async confirmRevoke(): Promise<void> {
    const target = this.revokeTarget();
    if (!target) {
      return;
    }
    try {
      await firstValueFrom(this.http.delete(`/api/personal-access-tokens/${target.id}`));
      this.toast.success('Personal access token revoked.');
      const minted = this.mintedToken();
      this.closeRevokeModal();
      await this.loadTokens();
      if (minted && !this.tokens().some((t) => t.id === target.id)) {
        // Keep minted secret visible unless the revoked token was the only context; clear if list empty of that mint.
        this.mintedToken.set(null);
      }
    } catch (err: any) {
      this.toast.error(err?.error?.error || 'Failed to revoke personal access token.');
    }
  }

  copyMintedToken(): void {
    const token = this.mintedToken();
    if (!token) return;
    void this.copyToClipboard(token, 'Token copied to clipboard.');
  }

  copyCurlExample(): void {
    void this.copyToClipboard(this.curlExample(), 'curl example copied to clipboard.');
  }

  private async copyToClipboard(value: string, message: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.toast.success(message);
    } catch {
      this.toast.error('Could not copy to clipboard. Select and copy the text manually.');
    }
  }

  expiryLabel(token: PersonalAccessTokenListItem): string {
    if (!token.expiresAt) {
      return 'Never';
    }
    const expires = new Date(token.expiresAt);
    if (expires.getTime() <= Date.now()) {
      return `Expired ${expires.toLocaleString()}`;
    }
    return expires.toLocaleString();
  }
}
