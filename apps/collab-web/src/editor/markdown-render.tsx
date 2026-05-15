import { createElement, type ReactElement } from 'react';

function flushParagraph(nodes: ReactElement[], paragraphLines: string[], key: () => string): void {
  if (paragraphLines.length === 0) return;
  nodes.push(<p key={key()}>{paragraphLines.join(' ')}</p>);
  paragraphLines.length = 0;
}

export function renderMarkdownSnapshot(markdown: string): ReactElement[] {
  const nodes: ReactElement[] = [];
  const paragraphLines: string[] = [];
  const lines = markdown.split(/\r?\n/u);
  let lineIndex = 0;
  let nodeIndex = 0;
  const nextKey = () => `md-${nodeIndex++}`;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph(nodes, paragraphLines, nextKey);
      lineIndex += 1;
      continue;
    }

    const fence = /^```(.*)$/u.exec(trimmed);
    if (fence) {
      flushParagraph(nodes, paragraphLines, nextKey);
      const language = fence[1]?.trim() ?? '';
      const codeLines: string[] = [];
      lineIndex += 1;
      while (lineIndex < lines.length && !/^```/u.test((lines[lineIndex] ?? '').trim())) {
        codeLines.push(lines[lineIndex] ?? '');
        lineIndex += 1;
      }
      if (lineIndex < lines.length) lineIndex += 1;
      nodes.push(
        <pre key={nextKey()} className="markdown-code-block">
          <code className={language ? `language-${language}` : undefined}>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(trimmed);
    if (heading?.[1] && heading[2]) {
      flushParagraph(nodes, paragraphLines, nextKey);
      nodes.push(createElement(`h${heading[1].length}`, { key: nextKey() }, heading[2]));
      lineIndex += 1;
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/u.exec(trimmed);
    if (listItem) {
      flushParagraph(nodes, paragraphLines, nextKey);
      const items: string[] = [];
      while (lineIndex < lines.length) {
        const item = /^[-*]\s+(.+)$/u.exec((lines[lineIndex] ?? '').trim());
        if (!item?.[1]) break;
        items.push(item[1]);
        lineIndex += 1;
      }
      nodes.push(<ul key={nextKey()}>{items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>);
      continue;
    }

    const quote = /^>\s?(.+)$/u.exec(trimmed);
    if (quote?.[1]) {
      flushParagraph(nodes, paragraphLines, nextKey);
      const quotes: string[] = [];
      while (lineIndex < lines.length) {
        const quotedLine = /^>\s?(.+)$/u.exec((lines[lineIndex] ?? '').trim());
        if (!quotedLine?.[1]) break;
        quotes.push(quotedLine[1]);
        lineIndex += 1;
      }
      nodes.push(<blockquote key={nextKey()}>{quotes.join(' ')}</blockquote>);
      continue;
    }

    paragraphLines.push(trimmed);
    lineIndex += 1;
  }

  flushParagraph(nodes, paragraphLines, nextKey);
  return nodes;
}
