// Author: Preston Lee

export type ToastTone =
  | 'primary'
  | 'secondary'
  | 'success'
  | 'danger'
  | 'warning'
  | 'info'
  | 'light'
  | 'dark';

export interface ToastOptions {
  id?: string;
  title?: string;
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss duration in milliseconds. Set to 0 to keep the toast open. */
  durationMs?: number;
  dismissible?: boolean;
}

export interface ToastItem extends ToastOptions {
  id: string;
  tone: ToastTone;
  durationMs: number;
  dismissible: boolean;
}

export type ToastOverrides = Omit<ToastOptions, 'message' | 'title' | 'tone'>;
