// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderMarkdownSnapshot } from './markdown-render';

describe('renderMarkdownSnapshot', () => {
  it('preserves author-visible soft line breaks in the live preview', () => {
    render(<div className="markdown-rendered-view">{renderMarkdownSnapshot('first line\nsecond line')}</div>);

    expect(document.querySelector('.markdown-rendered-view br')).not.toBeNull();
  });
});
