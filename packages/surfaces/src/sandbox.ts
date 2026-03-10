#!/usr/bin/env npx tsx
/**
 * Sandbox CLI for testing PlanConversation without Slack.
 *
 * Usage:
 *   cd packages/surfaces
 *   npx tsx src/sandbox.ts "how many lines of code are we at?"
 *   npx tsx src/sandbox.ts "refactor the auth module"
 *
 * Requires ANTHROPIC_API_KEY in .env or environment.
 */

import { resolve, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { PlanConversation } from './slack/plan-conversation.js';

const __dir = typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));

// Load .env from repo root (no dotenv dependency)
const envPath = resolve(__dir, '../../../.env');
try {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
} catch { /* no .env file */ }

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Missing ANTHROPIC_API_KEY in .env or environment');
  process.exit(1);
}

const repoRoot = resolve(__dir, '../../..');

const log = (src: string, lvl: string, msg: string) => {
  const color = lvl === 'error' ? '\x1b[31m' : lvl === 'warn' ? '\x1b[33m' : '\x1b[2m';
  console.log(`${color}[${src}]\x1b[0m ${msg}`);
};

const conversation = new PlanConversation({
  apiKey,
  workingDir: repoRoot,
  maxToolIterations: 12,
  log,
});

async function send(message: string) {
  console.log(`\n\x1b[1m> ${message}\x1b[0m\n`);
  const reply = await conversation.sendMessage(message);
  console.log(`\n\x1b[36m${reply}\x1b[0m`);

  if (conversation.planSubmitted && conversation.submittedPlan) {
    console.log(`\n\x1b[33m[sandbox] Plan submitted: "${conversation.submittedPlan.name}" (${conversation.submittedPlan.tasks?.length ?? 0} tasks)\x1b[0m`);
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
