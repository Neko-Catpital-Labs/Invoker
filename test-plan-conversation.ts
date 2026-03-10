/**
 * Quick local test — calls PlanConversation.sendMessage() directly, no Slack.
 * Run: npx tsx test-plan-conversation.ts
 */
import { PlanConversation } from './packages/surfaces/src/slack/plan-conversation.js';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY first');
  process.exit(1);
}

const conversation = new PlanConversation({
  apiKey,
  workingDir: process.cwd(),
  maxToolIterations: 12,
});

async function main() {
  console.log('Sending message...\n');
  const start = Date.now();

  try {
    const reply = await conversation.sendMessage(
      'Help me develop a plan for this: Make changes to the UI so that I can right click on a task and restart it in the DAG for the invoker codebase'
    );
    console.log(`\n--- Reply (${((Date.now() - start) / 1000).toFixed(1)}s) ---`);
    console.log(reply);

    if (conversation.extractedPlan) {
      console.log('\n--- Extracted Plan ---');
      console.log(JSON.stringify(conversation.extractedPlan, null, 2));
    }
  } catch (err) {
    console.error(`\n--- Error (${((Date.now() - start) / 1000).toFixed(1)}s) ---`);
    console.error(err);
  }
}

main();
