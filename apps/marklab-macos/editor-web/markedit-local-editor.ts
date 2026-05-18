import { EditorState, Compartment, EditorSelection } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { runMarkdownEditorCommand, type MarkdownEditorCommand } from '@marklab/collab-editor/markdown-commands';
import { markEditMarkdownEditorExtensions } from '@marklab/collab-editor/markedit-codemirror';

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
  __marklabRunEditorCommand?: (command: MarkdownEditorCommand) => void;
};

const root = document.getElementById('editor');
if (!root) throw new Error('marklab_editor_root_missing');

const editableCompartment = new Compartment();
const lineSeparatorCompartment = new Compartment();
let applyingFromNative = false;
let currentLineSeparator = '\n';
let currentLineEndings: string[] = [];
let lastSelectionStatus = '';

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

function selectionStatus(view: EditorView): string {
  const range = view.state.selection.main;
  const headLine = view.state.doc.lineAt(range.head);
  const column = range.head - headLine.from + 1;
  const selected = Math.abs(range.to - range.from);
  const lineColumn = `Ln ${headLine.number}, Col ${column}`;
  return selected > 0 ? `${lineColumn} (${selected})` : lineColumn;
}

function postSelectionStatus(view: EditorView) {
  const status = selectionStatus(view);
  if (status === lastSelectionStatus) return;
  lastSelectionStatus = status;
  (window as MarkLabWindow).webkit?.messageHandlers?.marklabLocalEditor?.postMessage({
    type: 'selection-change',
    status,
    editor: 'codemirror',
  });
}

function lineSeparatorExtension(lineSeparator: string) {
  return EditorState.lineSeparator.of(lineSeparator === '\r\n' ? '\r\n' : '\n');
}

function mapPositionAcrossReplacement(oldText: string, newText: string, position: number): number {
  const prefixLength = commonPrefixLength(oldText, newText);
  const suffixLength = commonSuffixLength(
    oldText.slice(prefixLength),
    newText.slice(prefixLength),
  );
  if (position <= prefixLength) return position;
  if (position >= oldText.length - suffixLength) {
    return Math.max(prefixLength, Math.min(newText.length, position + newText.length - oldText.length));
  }
  return Math.min(newText.length - suffixLength, prefixLength);
}

function commonPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return length;
}

function commonSuffixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[left.length - 1 - index] !== right[right.length - 1 - index]) return index;
  }
  return length;
}

const view = new EditorView({
  parent: root,
  state: EditorState.create({
    doc: '',
    extensions: [
      ...markEditMarkdownEditorExtensions(),
      editableCompartment.of(editableExtensions(true)),
      lineSeparatorCompartment.of(lineSeparatorExtension(currentLineSeparator)),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged || update.selectionSet) postSelectionStatus(update.view);
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
  const oldText = view.state.doc.toString();
  const selection = view.state.selection.main;
  const nextAnchor = mapPositionAcrossReplacement(oldText, markdown, selection.anchor);
  const nextHead = mapPositionAcrossReplacement(oldText, markdown, selection.head);
  if (normalizedLineSeparator !== currentLineSeparator) {
    currentLineSeparator = normalizedLineSeparator;
    view.dispatch({
      effects: lineSeparatorCompartment.reconfigure(lineSeparatorExtension(currentLineSeparator)),
    });
  }
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: markdown },
    selection: EditorSelection.range(nextAnchor, nextHead),
    scrollIntoView: true,
  });
  applyingFromNative = false;
};

(window as MarkLabWindow).__marklabSetEditable = (editable: boolean) => {
  view.dispatch({
    effects: editableCompartment.reconfigure(editableExtensions(editable)),
  });
};

(window as MarkLabWindow).__marklabRunEditorCommand = (command: MarkdownEditorCommand) => {
  runMarkdownEditorCommand(view, command);
};

document.body.dataset.marklabEditor = 'codemirror';
postSelectionStatus(view);
(window as MarkLabWindow).webkit?.messageHandlers?.marklabLocalEditor?.postMessage({
  type: 'editor-ready',
  editor: 'codemirror',
});
