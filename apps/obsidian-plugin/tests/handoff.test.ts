import { describe, expect, it } from 'vitest';
import { buildAiHandoffInstructions } from '../src/handoff';

describe('buildAiHandoffInstructions', () => {
  it('creates file-specific local-first AI instructions', () => {
    const handoff = buildAiHandoffInstructions({
      filePath: '/Users/pan/Vault/My Note.md',
      cliCommand: 'npx -y @marklab/cli',
    });

    expect(handoff).toContain("'/Users/pan/Vault/My Note.md'");
    expect(handoff).toContain('edit that file directly');
    expect(handoff).toContain("npx -y @marklab/cli save-version '/Users/pan/Vault/My Note.md'");
    expect(handoff).toContain("npx -y @marklab/cli status '/Users/pan/Vault/My Note.md' --json");
    expect(handoff).toContain("npx -y @marklab/cli wait '/Users/pan/Vault/My Note.md' --synced --timeout 10000 --json");
    expect(handoff).toContain("npx -y @marklab/cli conflict '/Users/pan/Vault/My Note.md' --json");
    expect(handoff).toContain('paused');
    expect(handoff).toContain('hasConflict');
    expect(handoff).toContain('host_offline');
    expect(handoff).toContain('sync_paused');
    expect(handoff).toContain('Do not mutate hosted relay state, Yjs state, Postgres rows');
  });
});
