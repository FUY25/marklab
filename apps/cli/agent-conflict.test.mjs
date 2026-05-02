import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './marklab.mjs';
import { syncStateForDaemon } from './recent-files.mjs';

describe('agent conflict command', () => {
  it('parses conflict as a JSON-capable agent command', () => {
    expect(parseCliArgs(['conflict', 'README.md', '--json'])).toEqual({
      command: 'conflict',
      file: 'README.md',
      json: true,
    });
  });

  it('maps open conflict packages to paused sync state', () => {
    expect(
      syncStateForDaemon(
        { hash: 'sha256:local', conflict: null, historyLoadError: null },
        { relayRoomId: 'relay_1', hostOnline: true },
        { conflict: { status: 'open' } },
      ),
    ).toBe('paused');
  });
});
