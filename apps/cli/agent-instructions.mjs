import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentCommandError, agentSuccess } from './agent-json.mjs';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const packagedTemplatesRoot = resolve(moduleRoot, 'agent-templates');
const repoDocsRoot = resolve(moduleRoot, '../../docs/agent');

const instructionFiles = Object.freeze({
  codex: 'marklab-codex-instructions.md',
  claude: 'marklab-claude-code-instructions.md',
  cursor: 'marklab-cursor-instructions.md',
});

export function normalizeAgentTarget(target) {
  const normalized = String(target ?? '').trim().toLowerCase();
  if (normalized === 'claude-code') return 'claude';
  if (Object.hasOwn(instructionFiles, normalized)) return normalized;
  throw new AgentCommandError('invalid_target', '--target must be codex, claude, or cursor.', { target: target ?? null });
}

export function instructionPathForTarget(target) {
  const normalized = normalizeAgentTarget(target);
  const filename = instructionFiles[normalized];
  const packagedPath = resolve(packagedTemplatesRoot, filename);
  if (existsSync(packagedPath)) return packagedPath;
  return resolve(repoDocsRoot, filename);
}

export async function readAgentInstructions(target) {
  const normalized = normalizeAgentTarget(target);
  const instructions = await readFile(instructionPathForTarget(normalized), 'utf8');
  return { target: normalized, instructions };
}

export async function installAgentInstructions(input) {
  const target = normalizeAgentTarget(input.target);
  if (target !== 'codex') {
    throw new AgentCommandError('invalid_target', 'agent install currently supports --target codex.', { target });
  }
  if (!input.writePath) {
    throw new AgentCommandError('invalid_target', 'agent install requires an explicit --write <path>.');
  }

  const outputPath = resolve(input.writePath);
  const existedBefore = existsSync(outputPath);
  if (existedBefore && !input.force) {
    throw new AgentCommandError('invalid_target', 'Instruction file already exists. Re-run with --force to overwrite.', {
      path: outputPath,
    });
  }

  const { instructions } = await readAgentInstructions(target);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, instructions, 'utf8');
  return agentSuccess({
    target,
    path: outputPath,
    wrote: true,
    overwritten: existedBefore && Boolean(input.force),
  });
}
