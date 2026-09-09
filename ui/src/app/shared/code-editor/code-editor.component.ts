// Author: Preston Lee

import {
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { basicSetup } from 'codemirror';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { json } from '@codemirror/lang-json';

export type CodeEditorLanguage = 'json';

@Component({
  selector: 'app-code-editor',
  standalone: true,
  templateUrl: './code-editor.component.html',
  styleUrl: './code-editor.component.scss',
  host: {
    class: 'code-editor-host',
  },
})
export class CodeEditorComponent implements OnDestroy {
  public readonly value = input<string>('');
  public readonly language = input<CodeEditorLanguage>('json');
  public readonly readonly = input<boolean>(false);
  public readonly valueChange = output<string>();

  private readonly host = viewChild.required<ElementRef<HTMLDivElement>>('editorHost');
  private readonly languageCompartment = new Compartment();
  private readonly editableCompartment = new Compartment();
  private readonly ready = signal(false);
  private view: EditorView | null = null;
  private updatingFromParent = false;

  constructor() {
    afterNextRender(() => {
      this.createEditor();
    });

    effect(() => {
      const nextValue = this.value();
      if (!this.ready()) {
        return;
      }
      const view = this.view;
      if (!view) {
        return;
      }
      const current = view.state.doc.toString();
      if (nextValue === current) {
        return;
      }
      this.updatingFromParent = true;
      view.dispatch({
        changes: { from: 0, to: current.length, insert: nextValue },
      });
      this.updatingFromParent = false;
    });

    effect(() => {
      const language = this.language();
      if (!this.ready()) {
        return;
      }
      this.view?.dispatch({
        effects: this.languageCompartment.reconfigure(this.languageExtension(language)),
      });
    });

    effect(() => {
      const readonly = this.readonly();
      if (!this.ready()) {
        return;
      }
      this.view?.dispatch({
        effects: this.editableCompartment.reconfigure(EditorView.editable.of(!readonly)),
      });
    });
  }

  public ngOnDestroy(): void {
    this.ready.set(false);
    this.view?.destroy();
    this.view = null;
  }

  private createEditor(): void {
    if (this.view) {
      return;
    }

    const parent = this.host().nativeElement;
    const startState = EditorState.create({
      doc: this.value(),
      extensions: [
        basicSetup,
        this.languageCompartment.of(this.languageExtension(this.language())),
        this.editableCompartment.of(EditorView.editable.of(!this.readonly())),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || this.updatingFromParent) {
            return;
          }
          this.valueChange.emit(update.state.doc.toString());
        }),
        EditorView.theme({
          '&': {
            height: 'auto',
            fontSize: '0.85rem',
            border: '1px solid #dee2e6',
            borderRadius: '0.375rem',
            backgroundColor: '#f8f9fa',
          },
          '.cm-scroller': {
            overflow: 'visible',
            fontFamily:
              'SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          },
          '.cm-content': {
            minHeight: '320px',
          },
          '&.cm-focused': {
            outline: '0',
            borderColor: '#80bdff',
            boxShadow: '0 0 0 0.2rem rgba(0, 123, 255, 0.25)',
          },
        }),
      ],
    });

    this.view = new EditorView({
      state: startState,
      parent,
    });
    this.ready.set(true);
  }

  private languageExtension(language: CodeEditorLanguage): Extension {
    switch (language) {
      case 'json':
        return json();
      default: {
        const _exhaustive: never = language;
        return _exhaustive;
      }
    }
  }
}
