import type { ReactElement } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];
const markdownComponents: Components = {
  a({ node: _node, href, children, ...props }) {
    const external = typeof href === 'string' && (/^https?:\/\//iu.test(href) || href.startsWith('//'));
    return (
      <a
        {...props}
        href={href}
        rel={external ? 'noreferrer noopener' : undefined}
        target={external ? '_blank' : undefined}
      >
        {children}
      </a>
    );
  },
  img({ node: _node, alt }) {
    return <span className="markdown-image-placeholder">{alt ? `Image: ${alt}` : 'Image omitted'}</span>;
  },
};

export function renderMarkdownSnapshot(markdown: string): ReactElement {
  return (
    <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins} skipHtml>
      {markdown}
    </ReactMarkdown>
  );
}
