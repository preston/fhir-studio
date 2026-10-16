import { test } from "node:test";
import assert from "node:assert/strict";
import { HostedEditorState } from "../src/app/applications/hosted-editor-state.ts";

const snapshot = (branch = "main", commit = "main-head") => ({
  branch,
  commit,
  files: [{ path: "app.ts", size: 3 }],
});

test("loading a new source identity clears stale text and its recovery baseline", () => {
  const editor = new HostedEditorState();
  editor.load(snapshot());
  editor.selectedFile.set("app.ts");
  editor.editor.set("main branch content");
  editor.baseline["app.ts"] = "main branch content";
  editor.load(snapshot("feature", "feature-head"));
  assert.equal(editor.snapshot()?.commit, "feature-head");
  assert.equal(editor.selectedFile(), "");
  assert.equal(editor.editor(), "");
  assert.deepEqual(editor.baseline, {});
});

test("source reload preserves pending edits and refuses to rebase them silently", () => {
  const editor = new HostedEditorState();
  editor.load(snapshot());
  editor.selectedFile.set("app.ts");
  editor.edit("unsaved");
  assert.throws(
    () => editor.load(snapshot("feature", "feature-head")),
    /pending edits/,
  );
  assert.equal(editor.snapshot()?.branch, "main");
  assert.equal(editor.drafts()["app.ts"], "unsaved");
});

test("save acknowledgement retains edits made while a request is in flight", () => {
  const editor = new HostedEditorState();
  editor.load(snapshot());
  editor.selectedFile.set("app.ts");
  editor.edit("submitted");
  const submitted = Object.entries(editor.drafts()).map(([path, content]) => ({
    path,
    content,
  }));
  editor.edit("typed during save");
  editor.drafts.update((drafts) => ({
    ...drafts,
    "new.ts": "new file during save",
  }));
  editor.saved("saved-head", submitted);
  assert.equal(editor.editor(), "typed during save");
  assert.deepEqual(editor.drafts(), {
    "app.ts": "typed during save",
    "new.ts": "new file during save",
  });
  assert.equal(editor.baseline["app.ts"], "submitted");
  assert.equal(editor.snapshot()?.commit, "saved-head");
});

test("saving a new file updates the recovery snapshot and removes only saved drafts", () => {
  const editor = new HostedEditorState();
  editor.load(snapshot());
  editor.selectedFile.set("new.ts");
  editor.edit("new content");
  editor.saved("saved-head", [{ path: "new.ts", content: "new content" }]);
  assert.deepEqual(editor.drafts(), {});
  assert.ok(editor.snapshot()?.files.some((file) => file.path === "new.ts"));
  assert.equal(editor.baseline["new.ts"], "new content");
});
