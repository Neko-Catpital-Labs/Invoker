#!/usr/bin/env npx tsx
/**
 * Sandbox CLI for testing PlanConversation without Slack.
 *
 * Usage:
 *   cd packages/surfaces
 *   npx tsx src/sandbox.ts "how many lines of code are we at?"
 *   npx tsx src/sandbox.ts "refactor the auth module"
 *
 * Requires `cursor` CLI to be available on PATH (or set CURSOR_COMMAND).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { PlanConversation } from './slack/plan-conversation.js';

const __dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dir, '../../..');

const log = (src: string, lvl: string, msg: string) => {
  const color = lvl === 'error' ? '\x1b[31m' : lvl === 'warn' ? '\x1b[33m' : '\x1b[2m';
  console.log(`${color}[${src}]\x1b[0m ${msg}`);
};

let repoUrl = process.env.INVOKER_REPO_URL;
if (!repoUrl) {
  try {
    repoUrl = execSync('git remote get-url origin', { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    // Not a git repo or no remote — repoUrl will be undefined
  }
}

const conversation = new PlanConversation({
  cursorCommand: process.env.CURSOR_COMMAND ?? 'agent',
  model: process.env.CURSOR_MODEL,
  workingDir: repoRoot,
  repoUrl,
  log,
});

async function send(message: string) {
  console.log(`\n\x1b[1m> ${message}\x1b[0m\n`);
  const reply = await conversation.sendMessage(message);
  console.log(`\n\x1b[36m${reply}\x1b[0m`);

  if (conversation.planSubmitted && conversation.submittedPlanText) {
    console.log(`\n\x1b[33m[sandbox] Plan submitted (raw text):\n${conversation.submittedPlanText}\x1b[0m`);
  }
}

async function main() {
  const initialMessage = process.argv.slice(2).join(' ');
  if (!initialMessage) {
    console.log('Usage: npx tsx src/sandbox.ts "your message here"');
    return;
  }

  await send(initialMessage);

  // Interactive follow-up
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => {
    rl.question('\n\x1b[1m> \x1b[0m', async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        rl.close();
        return;
      }
      await send(trimmed);
      prompt();
    });
  };
  prompt();
}

main().catch((err) => { console.error(err); process.exit(1); });
