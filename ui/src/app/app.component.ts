// Author: Preston Lee

import { Component, OnInit, inject, computed } from '@angular/core';
import { Router, RouterOutlet, RouterLink, RouterLinkActive, NavigationEnd } from '@angular/router';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthService } from './core/services/auth.service.js';
import { SandboxService, type Sandbox } from './core/services/sandbox.service.js';
import { LandingComponent } from './landing/landing.component.js';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, LandingComponent],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent implements OnInit {
  public readonly auth = inject(AuthService);
  public readonly sandboxService = inject(SandboxService);
  public readonly router = inject(Router);

  private readonly navUrl = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  public readonly isIsolatedApp = computed(() => {
    const url = this.navUrl();
    return url.startsWith('/example-application');
  });

  public readonly isSandboxesActive = computed(() => {
    const url = this.navUrl();
    return url === '/' || url.startsWith('/sandboxes');
  });

  public readonly isSmartApplicationsActive = computed(() => {
    const url = this.navUrl();
    return (
      url.startsWith('/ehr-simulator') ||
      url.startsWith('/applications') ||
      url.startsWith('/apps') ||
      url.startsWith('/example-application') ||
      url.startsWith('/scenarios') ||
      url.startsWith('/personas')
    );
  });

  public readonly isFhirDataActive = computed(() => {
    const url = this.navUrl();
    return url.startsWith('/data-manager') || url.startsWith('/registry-importer');
  });

  ngOnInit(): void {
    this.auth.loadSession().subscribe((res) => {
      if (res.authenticated) {
        this.sandboxService.getSandboxes().subscribe();
      } else {
        const url = this.router.url;
        const isIsolated = url.startsWith('/example-application');
        if (!isIsolated && url !== '/' && !url.startsWith('/?')) {
          this.router.navigate(['/']);
        }
      }
    });
  }

  public selectSandbox(sandbox: Sandbox): void {
    this.sandboxService.selectSandbox(sandbox);
  }
}
