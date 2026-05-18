export const agentErrorCodes = Object.freeze([
  'file_not_watched',
  'daemon_not_running',
  'sync_timeout',
  'sync_paused',
  'host_offline',
  'conflict_required',
  'conflict_unavailable',
  'invalid_conflict_action',
  'conflict_resolution_failed',
  'relay_unavailable',
  'share_not_started',
  'legacy_cli_disabled',
  'forbidden_agent_write',
  'doctor_failed',
  'invalid_target',
  'invalid_config',
  'native_launch_failed',
]);

export const agentExitCodes = Object.freeze({
  success: 0,
  general: 1,
  invalidCommandOrTarget: 2,
  daemonNotRunning: 3,
  syncPausedOrConflictRequired: 4,
  hostOffline: 5,
  timeout: 6,
  doctorFailure: 7,
  featureUnavailable: 8,
});

const errorExitCode = Object.freeze({
  file_not_watched: agentExitCodes.daemonNotRunning,
  daemon_not_running: agentExitCodes.daemonNotRunning,
  sync_timeout: agentExitCodes.timeout,
  sync_paused: agentExitCodes.syncPausedOrConflictRequired,
  host_offline: agentExitCodes.hostOffline,
  conflict_required: agentExitCodes.syncPausedOrConflictRequired,
  conflict_unavailable: agentExitCodes.featureUnavailable,
  invalid_conflict_action: agentExitCodes.invalidCommandOrTarget,
  conflict_resolution_failed: agentExitCodes.featureUnavailable,
  relay_unavailable: agentExitCodes.featureUnavailable,
  share_not_started: agentExitCodes.featureUnavailable,
  legacy_cli_disabled: agentExitCodes.featureUnavailable,
  forbidden_agent_write: agentExitCodes.invalidCommandOrTarget,
  doctor_failed: agentExitCodes.doctorFailure,
  invalid_target: agentExitCodes.invalidCommandOrTarget,
  invalid_config: agentExitCodes.invalidCommandOrTarget,
  native_launch_failed: agentExitCodes.featureUnavailable,
});

export class AgentCommandError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AgentCommandError';
    this.code = validateAgentErrorCode(code);
    this.details = details;
    this.exitCode = exitCodeForAgentError(this.code);
  }
}

export function validateAgentErrorCode(code) {
  if (agentErrorCodes.includes(code)) return code;
  throw new Error(`invalid_agent_error_code:${code}`);
}

export function exitCodeForAgentError(code) {
  return errorExitCode[validateAgentErrorCode(code)] ?? agentExitCodes.general;
}

export function agentSuccess(payload = {}) {
  return { ok: true, ...payload };
}

export function agentErrorResponse(code, message, details = undefined) {
  const response = { ok: false, code: validateAgentErrorCode(code), message };
  if (details !== undefined) response.details = details;
  return response;
}

export function writeAgentJson(response, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

export function toAgentCommandError(error, fallbackCode = 'invalid_target') {
  if (error instanceof AgentCommandError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new AgentCommandError(fallbackCode, message);
}

export function writeAgentError(error, options = {}) {
  const agentError = toAgentCommandError(error, options.fallbackCode);
  const stderr = options.stderr ?? process.stderr;
  if (options.json) {
    writeAgentJson(agentErrorResponse(agentError.code, agentError.message, agentError.details), options.stdout);
  } else {
    stderr.write(`${agentError.message}\n`);
  }
  return agentError.exitCode;
}
