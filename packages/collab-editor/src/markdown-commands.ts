import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export type MarkdownEditorCommand =
  | { type: 'gotoLine'; line: number }
  | { type: 'heading'; level: number }
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'unorderedList' }
  | { type: 'orderedList' }
  | { type: 'taskList' };

function selectedLineNumbers(view: EditorView): number[] {
  const numbers: number[] = [];
  view.state.selection.ranges.forEach((range) => {
    const start = view.state.doc.lineAt(range.from).number;
    const adjustedTo = range.to > range.from && range.to === view.state.doc.lineAt(range.to).from
      ? range.to - 1
      : range.to;
    const end = view.state.doc.lineAt(Math.max(range.from, adjustedTo)).number;
    for (let line = start; line <= end; line += 1) {
      if (!numbers.includes(line)) numbers.push(line);
    }
  });
  return numbers;
}

function replaceSelectedLines(view: EditorView, replacement: (lineText: string, ordinal: number) => string): void {
  const lineNumbers = selectedLineNumbers(view);
  const changes = lineNumbers.map((lineNumber, index) => {
    const line = view.state.doc.line(lineNumber);
    return {
      from: line.from,
      to: line.to,
      insert: replacement(line.text, index + 1),
    };
  });
  view.dispatch({ changes, scrollIntoView: true });
  view.focus();
}

function setHeading(view: EditorView, level: number): void {
  const normalizedLevel = Math.max(1, Math.min(6, Math.trunc(level)));
  const headingRegex = /^( *)(#{1,6})( +)/;
  const lineNumbers = selectedLineNumbers(view);
  const removeMarks = lineNumbers.every((lineNumber) => {
    const match = view.state.doc.line(lineNumber).text.match(headingRegex);
    return match?.[2]?.length === normalizedLevel;
  });
  replaceSelectedLines(view, (lineText) => {
    const match = lineText.match(headingRegex);
    if (match) {
      const indent = match[1] ?? '';
      const marker = match[2] ?? '';
      if (removeMarks) return indent + lineText.slice(match[0].length);
      return lineText.slice(0, indent.length) + '#'.repeat(normalizedLevel) + lineText.slice(indent.length + marker.length);
    }
    return lineText.length > 0 || lineNumbers.length === 1
      ? `${'#'.repeat(normalizedLevel)} ${lineText}`
      : lineText;
  });
}

type MarkLabListStyle = 'unordered' | 'ordered' | 'task';

type ParsedListLine = {
  indent: string;
  marker: string;
  content: string;
  taskState?: ' ' | 'x' | 'X';
};

function lineIndentAndContent(lineText: string): { indent: string; content: string } {
  const match = lineText.match(/^([ \t]*)(.*)$/);
  return {
    indent: match?.[1] ?? '',
    content: match?.[2] ?? lineText,
  };
}

function removeListMarkers(lineText: string): { indent: string; content: string } {
  const match = lineText.match(/^([ \t]*)(?:[-*+] +\[[ xX]\] +|[-*+] +|\d+\. +)(.*)$/);
  if (match) {
    return {
      indent: match[1] ?? '',
      content: match[2] ?? '',
    };
  }
  return lineIndentAndContent(lineText);
}

function parseListLine(lineText: string, style: MarkLabListStyle, ordinal: number): ParsedListLine | undefined {
  let match: RegExpMatchArray | null = null;
  switch (style) {
    case 'unordered':
      match = lineText.match(/^([ \t]*)([-*+] )(?! *\[[ xX]\]) */);
      break;
    case 'ordered':
      match = lineText.match(new RegExp(`^([ \\t]*)(${ordinal}\\. )`));
      break;
    case 'task':
      match = lineText.match(/^([ \t]*)([-*+] +\[([ xX])\] +)/);
      break;
  }
  if (!match) return undefined;
  const parsed: ParsedListLine = {
    indent: match[1] ?? '',
    marker: match[2] ?? '',
    content: lineText.slice(match[0].length),
  };
  if (match[3] === ' ' || match[3] === 'x' || match[3] === 'X') {
    parsed.taskState = match[3];
  }
  return parsed;
}

function createListMarker(style: MarkLabListStyle, ordinal: number, suggested?: string): string {
  switch (style) {
    case 'unordered':
      return suggested ?? '-';
    case 'ordered':
      return `${ordinal}.`;
    case 'task':
      return '- [ ]';
  }
}

function toggleListStyle(view: EditorView, style: MarkLabListStyle): void {
  const lineNumbers = selectedLineNumbers(view);
  const parsedLines = lineNumbers.map((lineNumber, index) => {
    const line = view.state.doc.line(lineNumber);
    const empty = lineNumbers.length > 1 && line.text.length === 0;
    return {
      empty,
      parsed: parseListLine(line.text, style, index + 1),
    };
  });
  const removeMarks = parsedLines.every(({ empty, parsed }) => empty || parsed !== undefined);
  const suggested = parsedLines
    .map(({ parsed }) => parsed?.marker.trim().slice(0, 1))
    .find(Boolean);

  replaceSelectedLines(view, (lineText, ordinal) => {
    const empty = lineNumbers.length > 1 && lineText.length === 0;
    const parsed = parseListLine(lineText, style, ordinal);
    if (parsed && removeMarks) {
      if (style === 'task' && parsed.taskState === ' ') {
        return lineText.replace(/([-*+] +\[) (\].*)/, '$1x$2');
      }
      return parsed.indent + parsed.content;
    }
    if (parsed || empty) return lineText;
    const unlisted = removeListMarkers(lineText);
    return `${unlisted.indent}${createListMarker(style, ordinal, suggested)} ${unlisted.content}`;
  });
}

function wrapSelection(view: EditorView, marker: string): void {
  const range = view.state.selection.main;
  if (range.empty) {
    const line = view.state.doc.lineAt(range.from);
    const offset = range.from - line.from;
    const markerBefore = findMarkerBefore(line.text, offset, marker);
    const markerAfter = findMarkerAfter(line.text, offset, marker);
    if (markerBefore !== undefined && markerAfter !== undefined && markerBefore < offset && markerAfter >= offset) {
      view.dispatch({
        changes: [
          { from: line.from + markerBefore, to: line.from + markerBefore + marker.length },
          { from: line.from + markerAfter, to: line.from + markerAfter + marker.length },
        ],
        selection: EditorSelection.cursor(range.from - marker.length),
        scrollIntoView: true,
      });
      view.focus();
      return;
    }
    view.dispatch({
      changes: { from: range.from, insert: marker + marker },
      selection: EditorSelection.cursor(range.from + marker.length),
      scrollIntoView: true,
    });
  } else {
    const selected = view.state.sliceDoc(range.from, range.to);
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= marker.length * 2) {
      const unwrapped = selected.slice(marker.length, selected.length - marker.length);
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: unwrapped },
        selection: EditorSelection.range(range.from, range.from + unwrapped.length),
        scrollIntoView: true,
      });
    } else if (
      range.from >= marker.length
        && range.to + marker.length <= view.state.doc.length
        && view.state.sliceDoc(range.from - marker.length, range.from) === marker
        && view.state.sliceDoc(range.to, range.to + marker.length) === marker
    ) {
      view.dispatch({
        changes: [
          { from: range.from - marker.length, to: range.from },
          { from: range.to, to: range.to + marker.length },
        ],
        selection: EditorSelection.range(range.from - marker.length, range.to - marker.length),
        scrollIntoView: true,
      });
    } else {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: marker + selected + marker },
        selection: EditorSelection.range(range.from + marker.length, range.to + marker.length),
        scrollIntoView: true,
      });
    }
  }
  view.focus();
}

function findMarkerBefore(lineText: string, offset: number, marker: string): number | undefined {
  for (let index = offset - marker.length; index >= 0; index -= 1) {
    if (isStandaloneMarkerAt(lineText, index, marker)) return index;
  }
  return undefined;
}

function findMarkerAfter(lineText: string, offset: number, marker: string): number | undefined {
  for (let index = offset; index <= lineText.length - marker.length; index += 1) {
    if (isStandaloneMarkerAt(lineText, index, marker)) return index;
  }
  return undefined;
}

function isStandaloneMarkerAt(lineText: string, index: number, marker: string): boolean {
  if (lineText.slice(index, index + marker.length) !== marker) return false;
  if (marker !== '*') return true;
  return lineText[index - 1] !== '*' && lineText[index + 1] !== '*';
}

function gotoLine(view: EditorView, lineNumber: number): void {
  const normalizedLine = Math.max(1, Math.min(view.state.doc.lines, Math.trunc(lineNumber)));
  const line = view.state.doc.line(normalizedLine);
  view.dispatch({
    selection: EditorSelection.cursor(line.from),
    scrollIntoView: true,
  });
  view.focus();
}

export function runMarkdownEditorCommand(view: EditorView, command: MarkdownEditorCommand): void {
  switch (command.type) {
    case 'gotoLine':
      gotoLine(view, command.line);
      break;
    case 'heading':
      setHeading(view, command.level);
      break;
    case 'bold':
      wrapSelection(view, '**');
      break;
    case 'italic':
      wrapSelection(view, '*');
      break;
    case 'unorderedList':
      toggleListStyle(view, 'unordered');
      break;
    case 'orderedList':
      toggleListStyle(view, 'ordered');
      break;
    case 'taskList':
      toggleListStyle(view, 'task');
      break;
  }
}
