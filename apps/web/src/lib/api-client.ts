import { readWebConfig } from '../config';

export interface CreatedDocument {
  docId: string;
  branchId: string;
  versionId: string;
  hash: string;
}

export interface ExportedMarkdown {
  filename: string;
  markdown: string;
}

function trimQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/gu, '"')
      .replace(/\\\\/gu, '\\');
  }
  return trimmed;
}

export function parseContentDispositionFilename(disposition: string | null): string | null {
  if (!disposition) return null;

  const filenameMatch = disposition.match(/(?:^|;)\s*filename=("[^"]*(?:\\"[^"]*)*"|[^;]+)/iu);
  if (!filenameMatch) return null;

  const [, rawFilename] = filenameMatch;
  if (!rawFilename) return null;

  const filename = trimQuotes(rawFilename);
  return filename.length > 0 ? filename : null;
}

async function requireJsonResponse<T>(response: Response, action: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;

  const body = await response.text();
  throw new Error(`${action}_failed:${response.status}:${body}`);
}

export class MarklabWebApi {
  private readonly apiUrl: string;

  constructor(apiUrl = readWebConfig().apiUrl) {
    this.apiUrl = apiUrl;
  }

  async createBlankDoc(title: string): Promise<CreatedDocument> {
    const response = await fetch(`${this.apiUrl}/api/docs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    return requireJsonResponse<CreatedDocument>(response, 'create_doc');
  }

  async importMarkdown(title: string, markdown: string): Promise<CreatedDocument> {
    const response = await fetch(`${this.apiUrl}/api/docs/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, markdown }),
    });
    return requireJsonResponse<CreatedDocument>(response, 'import_doc');
  }

  async exportMarkdown(docId: string, branchId: string): Promise<ExportedMarkdown> {
    const response = await fetch(
      `${this.apiUrl}/api/docs/${encodeURIComponent(docId)}/branches/${encodeURIComponent(branchId)}/export.md`,
    );
    const body = await response.text();
    if (!response.ok) throw new Error(`export_failed:${response.status}:${body}`);

    return {
      filename: parseContentDispositionFilename(response.headers.get('Content-Disposition')) ?? 'document.md',
      markdown: body,
    };
  }
}
