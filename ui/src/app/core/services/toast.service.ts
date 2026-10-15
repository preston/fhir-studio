// Author: Preston Lee

import { Injectable, type OnDestroy, signal } from '@angular/core';
import { timer, type Subscription } from 'rxjs';
import type { ToastItem, ToastOptions, ToastOverrides } from '../models/toast.model.js';

@Injectable({ providedIn: 'root' })
export class ToastService implements OnDestroy {
  private nextId = 1;
  private readonly items = signal<ToastItem[]>([]);
  private readonly timers = new Map<string, Subscription>();

  public readonly toasts = this.items.asReadonly();

  public show(options: ToastOptions): string {
    const id = options.id ?? `toast-${this.nextId++}`;
    const toast: ToastItem = {
      ...options,
      id,
      tone: options.tone ?? 'info',
      durationMs: options.durationMs ?? 5000,
      dismissible: options.dismissible ?? true,
    };

    this.dismiss(id);
    this.items.update((items) => [...items, toast]);
    if (toast.durationMs > 0) {
      this.timers.set(id, timer(toast.durationMs).subscribe(() => this.dismiss(id)));
    }
    return id;
  }

  public success(message: string, title?: string, options?: ToastOverrides): string {
    return this.show({ ...options, message, title, tone: 'success' });
  }

  public info(message: string, title?: string, options?: ToastOverrides): string {
    return this.show({ ...options, message, title, tone: 'info' });
  }

  public warning(message: string, title?: string, options?: ToastOverrides): string {
    return this.show({ ...options, message, title, tone: 'warning' });
  }

  public danger(message: string, title?: string, options?: ToastOverrides): string {
    return this.show({ ...options, message, title, tone: 'danger' });
  }

  public error(message: string, title?: string, options?: ToastOverrides): string {
    return this.danger(message, title, options);
  }

  public dismiss(id: string): void {
    this.timers.get(id)?.unsubscribe();
    this.timers.delete(id);
    this.items.update((items) => items.filter((toast) => toast.id !== id));
  }

  public clear(): void {
    for (const subscription of this.timers.values()) {
      subscription.unsubscribe();
    }
    this.timers.clear();
    this.items.set([]);
  }

  public ngOnDestroy(): void {
    this.clear();
  }
}
