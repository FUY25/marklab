import { describe, expect, it } from 'vitest';
import {
  evaluateHealth,
  evaluateStaticShellHtml,
  extractStaticAssetPaths,
} from '../../scripts/marklab-alpha-smoke.mjs';

describe('marklab alpha smoke helpers', () => {
  it('requires database schema and provider store readiness', () => {
    expect(evaluateHealth({
      ok: true,
      database: { ready: true },
      schema: { ready: true, missing: [] },
      provider: { ready: true, storeReady: true },
    })).toEqual({ ok: true, failures: [] });

    expect(evaluateHealth({
      ok: true,
      database: { ready: true },
      schema: { ready: false, missing: ['subscriptions.billing_mode'] },
      provider: { ready: true, storeReady: false },
    })).toEqual({
      ok: false,
      failures: [
        'schema.ready',
        'schema.missing:subscriptions.billing_mode',
        'provider.storeReady',
      ],
    });
  });

  it('requires the collab-web shell and assets instead of accepting any generic root div', () => {
    const collabHtml = `<!doctype html>
      <html>
        <head>
          <title>MarkLab Collaborator</title>
          <link rel="icon" href="/collab-web/favicon.png">
          <link rel="apple-touch-icon" href="/collab-web/apple-touch-icon.png">
          <link rel="manifest" href="/collab-web/site.webmanifest">
          <script type="module" src="/collab-web/assets/index-abc.js"></script>
          <link rel="stylesheet" href="/collab-web/assets/index-def.css">
        </head>
        <body><div id="root"></div></body>
      </html>`;

    expect(evaluateStaticShellHtml(collabHtml, {
      requiredTitle: 'MarkLab Collaborator',
      assetPrefix: '/collab-web/assets/',
      requiredHrefs: [
        '/collab-web/favicon.png',
        '/collab-web/apple-touch-icon.png',
        '/collab-web/site.webmanifest',
      ],
    })).toEqual({ ok: true, failures: [] });
    expect(extractStaticAssetPaths(collabHtml, '/collab-web/assets/')).toEqual([
      '/collab-web/assets/index-abc.js',
      '/collab-web/assets/index-def.css',
    ]);

    expect(evaluateStaticShellHtml('<div id="root"></div><script type="module" src="/assets/app.js"></script>', {
      requiredTitle: 'MarkLab Collaborator',
      assetPrefix: '/collab-web/assets/',
      requiredHrefs: ['/collab-web/favicon.png'],
    })).toEqual({
      ok: false,
      failures: [
        'html.title:MarkLab Collaborator',
        'html.moduleAssetPrefix:/collab-web/assets/',
        'html.assetPrefix:/collab-web/assets/',
        'html.href:/collab-web/favicon.png',
      ],
    });

    expect(evaluateStaticShellHtml('<title>MarkLab Collaborator</title><script type="module" src="/collab-web/assets/index.js"></script>', {
      requiredTitle: 'MarkLab Collaborator',
      assetPrefix: '/collab-web/assets/',
    })).toEqual({
      ok: false,
      failures: ['html.root'],
    });
  });
});
