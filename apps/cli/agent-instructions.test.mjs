import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installAgentInstructions, readAgentInstructions } from './agent-instructions.mjs';

describe('agent instruction commands', () => {
  it('renders target-specific instructions that keep edits local-file-first', async () => {
    const codex = await readAgentInstructions('codex');
    expect(codex.target).toBe('codex');
    expect(codex.instructions).toContain('Edit the local `.md` file on disk');
    expect(codex.instructions).toContain('marklab status <file.md> --json');
    expect(codex.instructions).toContain('read MarkLab.app support files');
    expect(codex.instructions).toContain("marklab join 'https://<host>/collab?docId=...&branchId=...&token=...&mode=edit'");
    expect(codex.instructions).toContain('Archived local-daemon commands');
    expect(codex.instructions).not.toMatch(/direct Yjs|direct Postgres/u);
  });

  it('requires explicit write and refuses to overwrite without force', async () => {
    await expect(installAgentInstructions({ target: 'codex' })).rejects.toMatchObject({
      code: 'invalid_target',
    });

    const directory = await mkdtemp(join(tmpdir(), 'marklab-agent-install-'));
    const targetPath = join(directory, 'AGENTS.md');
    const installed = await installAgentInstructions({ target: 'codex', writePath: targetPath });
    expect(installed).toMatchObject({ ok: true, wrote: true, overwritten: false });
    await expect(readFile(targetPath, 'utf8')).resolves.toContain('MarkLab Local Agent Rules');

    await expect(installAgentInstructions({ target: 'codex', writePath: targetPath })).rejects.toMatchObject({
      code: 'invalid_target',
    });

    await writeFile(targetPath, '# Existing\n', 'utf8');
    const overwritten = await installAgentInstructions({ target: 'codex', writePath: targetPath, force: true });
    expect(overwritten).toMatchObject({ ok: true, overwritten: true });
    await expect(readFile(targetPath, 'utf8')).resolves.toContain('MarkLab Local Agent Rules');
  });
});
