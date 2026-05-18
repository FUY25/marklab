import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';

const markEditBaseFontSize = 14;
const markEditHeadingDiffs = [5, 3, 1];

function markEditHeadingFontSize(level: number): string {
  return `${markEditBaseFontSize + (markEditHeadingDiffs[level - 1] ?? 0)}px`;
}

export const markEditMarkdownHighlightStyle = HighlightStyle.define([
  {
    tag: tags.heading1,
    color: '#0550ae',
    fontWeight: '700',
    textDecoration: 'none',
    fontSize: markEditHeadingFontSize(1),
  },
  {
    tag: tags.heading2,
    color: '#0550ae',
    fontWeight: '700',
    textDecoration: 'none',
    fontSize: markEditHeadingFontSize(2),
  },
  {
    tag: tags.heading3,
    color: '#0550ae',
    fontWeight: '700',
    textDecoration: 'none',
    fontSize: markEditHeadingFontSize(3),
  },
  {
    tag: [tags.heading4, tags.heading5, tags.heading6, tags.heading],
    color: '#0550ae',
    fontWeight: '700',
    textDecoration: 'none',
  },
  { tag: tags.quote, color: '#1a7f37', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#0a3069', textDecoration: 'underline' },
  { tag: tags.url, color: '#24292f', textDecoration: 'none' },
]);

export const markEditMarkdownEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: '#ffffff',
    color: '#24292f',
    fontSize: `${markEditBaseFontSize}px`,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: '#add6ff !important',
  },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    lineHeight: '1.58',
  },
  '.cm-content': {
    minHeight: '100vh',
    paddingTop: '2px',
    paddingRight: '12px',
    paddingBottom: '50vh',
  },
  '.cm-gutters': {
    color: '#8c959f',
    backgroundColor: '#ffffff',
    borderRight: 'none',
    fontFamily: 'SF Mono, ui-monospace, monospace',
  },
  '.cm-lineNumbers > .cm-activeLineGutter': {
    color: '#24292f',
  },
  '.cm-foldGutter': {
    padding: '0 4px',
    opacity: '0',
  },
  '.cm-foldGutter, .cm-foldPlaceholder': {
    color: '#24292f66',
    fontFamily: 'monospace !important',
    transform: 'translateY(-0.1em)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: '#eaeef27f',
  },
});

export function markEditMarkdownEditorExtensions(): Extension[] {
  return [
    basicSetup,
    markdown(),
    EditorView.lineWrapping,
    syntaxHighlighting(markEditMarkdownHighlightStyle),
    markEditMarkdownEditorTheme,
  ];
}
