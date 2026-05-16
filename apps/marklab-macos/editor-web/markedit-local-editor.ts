import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';

type NativeMessageHandler = {
  postMessage(message: unknown): void;
};

type MarkLabWindow = Window & {
  webkit?: {
    messageHandlers?: {
      marklabLocalEditor?: NativeMessageHandler;
    };
  };
  __marklabSetMarkdown?: (markdown: string, lineSeparator: string) => void;
  __marklabSetEditable?: (editable: boolean) => void;
};

const root = document.getElementById('editor');
if (!root) throw new Error('marklab_editor_root_missing');

const editableCompartment = new Compartment();
const lineSeparatorCompartment = new Compartment();
let applyingFromNative = false;
let currentLineSeparator = '\n';
let currentLineEndings: string[] = [];

function editableExtensions(isEditable: boolean) {
  return [
    EditorView.editable.of(isEditable),
    EditorState.readOnly.of(!isEditable),
  ];
}

function lineEndingsFor(markdown: string): string[] {
  const endings: string[] = [];
  for (let index = 0; index < markdown.length; index += 1) {
    const char = markdown[index];
    if (char === '\r' && markdown[index + 1] === '\n') {
      endings.push('\r\n');
      index += 1;
    } else if (char === '\r') {
      endings.push('\r');
    } else if (char === '\n') {
      endings.push('\n');
    }
  }
  return endings;
}

function dominantLineSeparator(endings: string[]): string {
  if (endings.length === 0) return '\n';
  const counts = new Map<string, number>();
  for (const ending of endings) counts.set(ending, (counts.get(ending) ?? 0) + 1);
  return endings.reduce((best, ending) => {
    const bestCount = counts.get(best) ?? 0;
    const endingCount = counts.get(ending) ?? 0;
    return endingCount > bestCount ? ending : best;
  }, endings[0]);
}

function markdownWithStoredLineEndings(markdown: string): string {
  const normalized = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  let result = '';
  for (let index = 0; index < lines.length; index += 1) {
    result += lines[index];
    if (index < lines.length - 1) {
      result += currentLineEndings[index] ?? currentLineSeparator;
    }
  }
  return result;
}

function editorMarkdown(view: EditorView): string {
  return markdownWithStoredLineEndings(view.state.doc.toString());
}

function lineSeparatorExtension(lineSeparator: string) {
  return EditorState.lineSeparator.of(lineSeparator === '\r\n' ? '\r\n' : '\n');
}

const view = new EditorView({
  parent: root,
  state: EditorState.create({
    doc: '',
    extensions: [
      basicSetup,
      markdown(),
      editableCompartment.of(editableExtensions(true)),
      lineSeparatorCompartment.of(lineSeparatorExtension(currentLineSeparator)),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.lineWrapping,
      EditorView.theme({
        '&': {
          height: '100%',
          backgroundColor: 'transparent',
          color: 'CanvasText',
          fontSize: '14px',
        },
        '.cm-scroller': {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          lineHeight: '1.58',
        },
        '.cm-content': {
          minHeight: '100vh',
          padding: '22px 28px 48px',
        },
        '.cm-gutters': {
          backgroundColor: 'transparent',
          borderRightColor: 'color-mix(in srgb, CanvasText 12%, transparent)',
        },
        '.cm-activeLine, .cm-activeLineGutter': {
          backgroundColor: 'color-mix(in srgb, CanvasText 6%, transparent)',
        },
      }),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || applyingFromNative) return;
        (window as MarkLabWindow).webkit?.messageHandlers?.marklabLocalEditor?.postMessage({
          type: 'markdown-change',
          markdown: editorMarkdown(update.view),
          lineSeparator: currentLineSeparator,
          lineEndings: currentLineEndings,
          editor: 'codemirror',
        });
      }),
    ],
  }),
});

(window as MarkLabWindow).__marklabSetMarkdown = (markdown: string, lineSeparator: string) => {
  currentLineEndings = lineEndingsFor(markdown);
  const normalizedLineSeparator = (
    lineSeparator === '\r\n' || lineSeparator === '\r' || lineSeparator === '\n'
  ) ? lineSeparator : dominantLineSeparator(currentLineEndings);
  applyingFromNative = true;
  if (normalizedLineSeparator !== currentLineSeparator) {
    currentLineSeparator = normalizedLineSeparator;
    view.dispatch({
      effects: lineSeparatorCompartment.reconfigure(lineSeparatorExtension(currentLineSeparator)),
    });
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: markdown },
  });
  applyingFromNative = false;
};

(window as MarkLabWindow).__marklabSetEditable = (editable: boolean) => {
  view.dispatch({
    effects: editableCompartment.reconfigure(editableExtensions(editable)),
  });
};

document.body.dataset.marklabEditor = 'codemirror';
