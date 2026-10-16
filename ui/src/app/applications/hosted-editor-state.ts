import { signal } from "@angular/core";
import type { RepositoryFile, RepositorySnapshot } from "@fhir-studio/core";

/** Source identity and recovery drafts move together, independently of network timing. */
export class HostedEditorState {
  readonly snapshot = signal<RepositorySnapshot | null>(null);
  readonly drafts = signal<Record<string, string>>({});
  readonly selectedFile = signal("");
  readonly editor = signal("");
  baseline: Record<string, string> = {};

  load(snapshot: RepositorySnapshot): void {
    const changed =
      this.snapshot()?.commit !== snapshot.commit ||
      this.snapshot()?.branch !== snapshot.branch;
    if (changed && Object.keys(this.drafts()).length)
      throw new Error(
        "The branch changed while you had pending edits. Download the recovery patch, then discard the draft and refresh to resolve the conflict.",
      );
    if (changed) {
      this.selectedFile.set("");
      this.editor.set("");
      this.baseline = {};
    }
    this.snapshot.set(snapshot);
  }

  edit(content: string): void {
    if (!this.selectedFile()) return;
    this.editor.set(content);
    this.drafts.update((drafts) => ({
      ...drafts,
      [this.selectedFile()]: content,
    }));
  }

  saved(commit: string, files: RepositoryFile[]): void {
    this.snapshot.update((snapshot) =>
      snapshot
        ? {
            ...snapshot,
            commit,
            files: [
              ...snapshot.files.filter(
                (file) => !files.some((saved) => saved.path === file.path),
              ),
              ...files.map((file) => ({
                path: file.path,
                size: new TextEncoder().encode(file.content).length,
              })),
            ],
          }
        : null,
    );
    const remaining = { ...this.drafts() };
    for (const file of files) {
      this.baseline[file.path] = file.content;
      if (remaining[file.path] === file.content) delete remaining[file.path];
    }
    this.drafts.set(remaining);
  }
}
