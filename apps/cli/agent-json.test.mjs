import { describe, expect, it } from 'vitest';
import {
  AgentCommandError,
  agentErrorResponse,
  agentExitCodes,
  agentSuccess,
  exitCodeForAgentError,
} from './agent-json.mjs';

describe('agent JSON contract', () => {
  it('emits stable success and error shapes', () => {
    expect(agentSuccess({ files: [] })).toEqual({ ok: true, files: [] });
    expect(agentErrorResponse('sync_timeout', 'Timed out.')).toEqual({
      ok: false,
      code: 'sync_timeout',
      message: 'Timed out.',
    });
  });

  it('maps stable agent error codes to stable exit codes', () => {
    expect(exitCodeForAgentError('daemon_not_running')).toBe(agentExitCodes.daemonNotRunning);
    expect(exitCodeForAgentError('sync_paused')).toBe(agentExitCodes.syncPausedOrConflictRequired);
    expect(exitCodeForAgentError('host_offline')).toBe(agentExitCodes.hostOffline);
    expect(exitCodeForAgentError('sync_timeout')).toBe(agentExitCodes.timeout);
    expect(exitCodeForAgentError('doctor_failed')).toBe(agentExitCodes.doctorFailure);
    expect(exitCodeForAgentError('relay_unavailable')).toBe(agentExitCodes.featureUnavailable);
    expect(exitCodeForAgentError('invalid_conflict_action')).toBe(agentExitCodes.invalidCommandOrTarget);
    expect(exitCodeForAgentError('conflict_resolution_failed')).toBe(agentExitCodes.featureUnavailable);
  });

  it('rejects unknown error codes instead of inventing unstable codes', () => {
    expect(() => new AgentCommandError('unknown_code', 'bad')).toThrow('invalid_agent_error_code:unknown_code');
  });
});
