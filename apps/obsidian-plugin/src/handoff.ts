import { splitCommandLine } from './cli-adapter';

export interface AiHandoffInput {
  filePath: string;
  cliCommand: string;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

function commandPrefix(cliCommand: string): string[] {
  try {
    const parts = splitCommandLine(cliCommand);
    return parts.length > 0 ? parts : ['marklab'];
  } catch {
    return ['marklab'];
  }
}

function formatCommand(cliCommand: string, args: string[]): string {
  return [...commandPrefix(cliCommand), ...args].map(shellQuote).join(' ');
}

export function buildAiHandoffInstructions(input: AiHandoffInput): string {
  const { filePath, cliCommand } = input;
  const quotedFilePath = shellQuote(filePath);
  const statusCommand = formatCommand(cliCommand, ['status', filePath, '--json']);
  const saveVersionCommand = formatCommand(cliCommand, ['save-version', filePath, '--message', 'Before AI edit: <reason>', '--json']);
  const waitCommand = formatCommand(cliCommand, ['wait', filePath, '--synced', '--timeout', '10000', '--json']);
  const conflictCommand = formatCommand(cliCommand, ['conflict', filePath, '--json']);

  return [
    '# MarkLab AI handoff',
    '',
    `Work on this local Markdown file: ${quotedFilePath}`,
    '',
    'The local `.md` file is the canonical document; edit that file directly. Do not use a hosted write API.',
    '',
    'Before broad edits, create a local MarkLab checkpoint:',
    '',
    `\`\`\`sh\n${saveVersionCommand}\n\`\`\``,
    '',
    'Check coordination state before editing:',
    '',
    `\`\`\`sh\n${statusCommand}\n\`\`\``,
    '',
    'After editing, wait for MarkLab sync:',
    '',
    `\`\`\`sh\n${waitCommand}\n\`\`\``,
    '',
    'If MarkLab reports `paused`, `hasConflict`, `host_offline`, `sync_paused`, or a conflict-required state, stop editing and inspect the conflict:',
    '',
    `\`\`\`sh\n${conflictCommand}\n\`\`\``,
    '',
    'Do not mutate hosted relay state, Yjs state, Postgres rows, Fly/Neon infrastructure, or any hosted AI write/edit endpoint directly.',
  ].join('\n');
}
