/**
 * PlanConversation — Thread-based planning via Cursor CLI.
 *
 * Manages a multi-turn conversation in a Slack thread where a user
 * describes what they want, Cursor explores the codebase, and
 * eventually generates a validated YAML plan.
 *
 * Each turn spawns the Cursor CLI as a subprocess with the full
 * conversation history in the prompt. Plan submission is detected
 * client-side when the user sends a confirmation message.
 */

import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { PlanDefinition } from '@invoker/core';
import type { ConversationRepository } from '@invoker/persistence';
import type { LogFn } from '../surface.js';

// ── Types ───────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanConversationConfig {
  /** Command to invoke the Cursor CLI. Default: 'cursor'. */
  cursorCommand?: string;
  /** Root directory for codebase exploration. */
  workingDir?: string;
  /** Subprocess timeout in milliseconds. Default: 300000 (5 minutes). */
  timeoutMs?: number;
  /** Slack thread timestamp. Required for persistence. */
  threadTs?: string;
  /** Repository for persisting conversation state across restarts. */
  conversationRepo?: ConversationRepository;
  /** Default branch name (e.g. "master"). Used when plan YAML omits baseBranch. */
  defaultBranch?: string;
  /** Logging callback. Defaults to console.log/console.error. */
  log?: LogFn;
}

// ── Confirmation Detection ──────────────────────────────────

const CONFIRMATION_PATTERNS = [
  /^yes$/i,
  /^y$/i,
  /^go$/i,
  /^go ahead$/i,
  /^execute$/i,
  /^run it$/i,
  /^start$/i,
  /^proceed$/i,
  /^do it$/i,
  /^confirm$/i,
  /^lgtm$/i,
  /^ship it$/i,
  /^approved$/i,
];

export function isConfirmation(text: string): boolean {
  const trimmed = text.trim().replace(/[.!]+$/, '');
  return CONFIRMATION_PATTERNS.some((re) => re.test(trimmed));
}

// ── System Prompt ───────────────────────────────────────────

function buildSystemPrompt(defaultBranch: string): string {
  return `You are an assistant for the Invoker orchestrator. You have two modes:

**Direct answer mode** — For simple, self-contained requests (counting lines of code, checking versions, running a quick command, answering questions about the codebase). Explore the codebase as needed and report the result directly. Do NOT generate a YAML plan for these.

**Plan mode** — For multi-step implementation tasks (adding features, fixing bugs, refactoring code). Generate a YAML task plan as described below.

Use your judgment: if the request can be answered with 1-2 commands or a short explanation, use direct answer mode. If it requires coordinated changes across multiple files, use plan mode.

A plan has this structure:
\`\`\`yaml
name: "Plan Name"
onFinish: merge         # "merge" (default), "none", or "pull_request"
mergeMode: manual       # "manual" (default) or "automatic"
baseBranch: ${defaultBranch}        # base git branch
featureBranch: plan/my-feature  # auto-generated from plan name if omitted
tasks:
  - id: task-1
    description: "What this task does"
    command: "shell command"     # for command tasks
    prompt: "instructions"       # for AI/Claude tasks
    dependencies: []             # task IDs this depends on
    pivot: false                 # true to spawn experiment variants
    experimentVariants:          # only if pivot: true
      - id: variant-a
        description: "Approach A"
        prompt: "Try approach A"
    requiresManualApproval: false
    autoFix: false               # auto-retry with experiments on failure
    maxFixAttempts: 3
\`\`\`

Rules:
1. Explore the codebase first (list directories, read key files). Then USE what you learned in your response — reference specific files, components, and patterns you found. Do NOT give generic responses that ignore the code you read.
2. After exploring, generate the YAML plan directly. Do NOT ask clarifying questions unless absolutely necessary — prefer making reasonable assumptions based on the code you read.
3. Keep plans focused — 3-8 tasks maximum.
4. Each task should have either a \`command\` or a \`prompt\`, not both.
5. Every step MUST be testable. Every implementation task MUST have a corresponding test task that verifies it works using a concrete, executable \`command\` (e.g. \`cd packages/protocol && pnpm test\`, \`git diff --name-only\`). The test command must produce a clear pass/fail exit code. Do NOT skip tests for any step. Do NOT use prompts for test tasks — use commands only.
   Test command rules:
   - ALWAYS cd into the package directory first: \`cd packages/<pkg> && pnpm test\`
   - To target a specific test file: \`cd packages/<pkg> && pnpm test -- src/__tests__/file.test.ts\`
   - NEVER run \`pnpm test <path>\` from the repo root — it runs \`pnpm -r test\` across all packages and the path will be wrong
   - NEVER use \`npx vitest run\` — always use \`pnpm test\` which runs through electron-vitest with the correct native module ABI
   - NEVER invent test file names. Verify the test file exists before referencing it in a command.
6. Use meaningful task IDs (kebab-case).
7. When ready, output the plan inside a \`\`\`yaml code block.
8. Always include \`dependencies\` (even if empty array).
9. After generating a plan, tell the user they can confirm execution by replying with "yes", "go", "execute", etc.
10. NEVER generate bash commands or shell scripts to execute plans. The orchestrator handles plan execution automatically when the user confirms.`;
}

// ── Dangerous Command Detection ─────────────────────────────

export const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)/,
  /\bgit\s+push\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+\.\b/,
  /\bmv\s+\//,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bchmod\s+-R\s+777\b/,
  /\bcurl\b.*\|\s*(ba)?sh\b/,
  /\bwget\b.*\|\s*(ba)?sh\b/,
  />\s*\/dev\//,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((re) => re.test(cmd));
}

// ── Constants ───────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── PlanConversation ────────────────────────────────────────

export class PlanConversation {
  private cursorCommand: string;
  private messages: ConversationMessage[] = [];
  private _submittedPlan: PlanDefinition | null = null;
  private _planSubmitted = false;
  private workingDir?: string;
  private timeoutMs: number;
  private threadTs?: string;
  private conversationRepo?: ConversationRepository;
  private defaultBranch?: string;
  private log: LogFn;
  private _initialized = false;

  constructor(config: PlanConversationConfig) {
    this.cursorCommand = config.cursorCommand ?? 'cursor';
    this.workingDir = config.workingDir;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.threadTs = config.threadTs;
    this.conversationRepo = config.conversationRepo;
    this.defaultBranch = config.defaultBranch;
    this.log = config.log ?? ((src, lvl, msg) => {
      (lvl === 'error' ? console.error : console.log)(`[${src}] ${msg}`);
    });
  }

  /**
   * Load existing conversation state from the database.
   * Call once after construction. Safe to call multiple times (no-ops after first).
   */
  async init(): Promise<void> {
    if (this._initialized) {
      this.log('plan-conversation', 'info', `[TRACE] init() skipped — already initialized (threadTs=${this.threadTs})`);
      return;
    }
    this._initialized = true;

    if (!this.conversationRepo || !this.threadTs) {
      this.log('plan-conversation', 'info', `[TRACE] init() early return — no conversationRepo=${!!this.conversationRepo} or threadTs=${this.threadTs}`);
      return;
    }

    try {
      const saved = this.conversationRepo.loadConversation(this.threadTs);
      if (!saved) return;

      this.messages = saved.messages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: typeof m.content === 'string'
          ? m.content
          : (m.content as any[])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join(''),
      })).filter((m) => m.content.length > 0);
      this._planSubmitted = saved.planSubmitted;

      this.log('plan-conversation', 'info', `Restored conversation ${this.threadTs}: ${saved.messages.length} messages`);
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to load conversation ${this.threadTs}: ${err}`);
    }
  }

  /**
   * Send a user message and get Cursor's response.
   * If the message is a confirmation (e.g. "yes", "go"), extracts the last
   * YAML plan from history and submits it. Otherwise spawns the Cursor CLI.
   */
  async sendMessage(userMessage: string): Promise<string> {
    this.log('plan-conversation', 'info', `[TRACE] sendMessage() start (threadTs=${this.threadTs}, initialized=${this._initialized}, msgCount=${this.messages.length})`);
    if (!this._initialized) await this.init();

    this.messages.push({ role: 'user', content: userMessage });

    if (isConfirmation(userMessage)) {
      const plan = this.extractLastPlanFromMessages();
      if (plan) {
        this._submittedPlan = plan;
        this._planSubmitted = true;
        const reply = `Plan "${plan.name}" submitted for execution.`;
        this.messages.push({ role: 'assistant', content: reply });
        this.saveState();
        return reply;
      }
    }

    const prompt = this.buildCursorPrompt();
    this.log('plan-conversation', 'info', `Spawning Cursor CLI (promptLen=${prompt.length})...`);
    const response = await this.spawnCursor(prompt);
    this.log('plan-conversation', 'info', `Cursor responded (responseLen=${response.length})`);

    this.messages.push({ role: 'assistant', content: response });
    this.saveState();
    return response;
  }

  /** Returns the plan that was submitted via confirmation, or null. */
  get submittedPlan(): PlanDefinition | null {
    return this._submittedPlan;
  }

  /** Returns true if the user confirmed and a plan was extracted. */
  get planSubmitted(): boolean {
    return this._planSubmitted;
  }

  /** Returns the conversation history. */
  get history(): readonly ConversationMessage[] {
    return this.messages.filter((m) => m.content.length > 0);
  }

  /** Reset the conversation. */
  reset(): void {
    this.messages = [];
    this._submittedPlan = null;
    this._planSubmitted = false;
    if (this.conversationRepo && this.threadTs) {
      this.conversationRepo.deleteConversation(this.threadTs);
    }
  }

  // ── Prompt Construction ────────────────────────────────

  /**
   * Build the full prompt for Cursor, including system instructions
   * and the complete conversation history.
   */
  buildCursorPrompt(): string {
    const systemPrompt = buildSystemPrompt(this.defaultBranch ?? 'main');
    const parts: string[] = [systemPrompt];

    if (this.messages.length > 1) {
      parts.push('\n=== Conversation History ===');
      for (const msg of this.messages.slice(0, -1)) {
        const label = msg.role === 'user' ? 'User' : 'Assistant';
        parts.push(`\n${label}:\n${msg.content}`);
      }
      parts.push('\n=== End History ===');
    }

    const lastMessage = this.messages[this.messages.length - 1];
    if (lastMessage) {
      parts.push(`\nUser's latest message:\n${lastMessage.content}`);
      parts.push('\nRespond to the latest message. If it requires a plan, explore the codebase and generate one.');
    }

    return parts.join('\n');
  }

  // ── Cursor CLI Subprocess ─────────────────────────────

  spawnCursor(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.cursorCommand, ['-p', prompt], {
        cwd: this.workingDir ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        reject(new Error(`Cursor CLI timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim() || '(no output)');
        } else {
          const errMsg = stderr.trim() || stdout.trim() || 'Unknown error';
          reject(new Error(`Cursor CLI exited with code ${code}: ${errMsg}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn Cursor CLI: ${err.message}`));
      });
    });
  }

  // ── Plan Extraction ────────────────────────────────────

  private extractLastPlanFromMessages(): PlanDefinition | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'assistant') continue;
      if (!msg.content) continue;

      const plan = extractYamlPlan(msg.content, this.defaultBranch);
      if (plan) return plan;
    }
    return null;
  }

  // ── Persistence ────────────────────────────────────────

  private saveState(): void {
    if (!this.conversationRepo || !this.threadTs) return;

    try {
      const messages = this.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      this.conversationRepo.saveConversation(
        this.threadTs,
        messages,
        null,
        this._planSubmitted,
      );
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to save conversation ${this.threadTs}: ${err}`);
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Convert a simple glob pattern (e.g. "*.ts") to a RegExp. */
export function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ── Command Rewriting ────────────────────────────────────────

/**
 * Rewrite `pnpm test packages/<pkg>/...` (run from repo root, incorrect)
 * into `cd packages/<pkg> && pnpm test -- <relative-path>` (correct).
 */
export function rewritePnpmTestCommand(cmd: string): string {
  const withFile = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)\/(\S+)(.*)/);
  if (withFile) {
    const [, , pkg, rest, suffix] = withFile;
    return `cd packages/${pkg} && pnpm test -- ${rest}${suffix}`;
  }
  const pkgOnly = cmd.match(/^(pnpm test)\s+(?:--\s+)?packages\/([^/\s]+)(.*)/);
  if (pkgOnly) {
    const [, , pkg, suffix] = pkgOnly;
    return `cd packages/${pkg} && pnpm test${suffix}`;
  }
  return cmd;
}

// ── YAML Extraction ─────────────────────────────────────────

/**
 * Extract and validate a YAML plan from a message containing ```yaml blocks.
 * Returns null if no valid plan is found.
 */
export function extractYamlPlan(text: string, defaultBranch?: string): PlanDefinition | null {
  const yamlMatch = text.match(/```yaml\n([\s\S]*?)```/);
  if (!yamlMatch) {
    if (text.length > 100) {
      console.warn(`extractYamlPlan: no \`\`\`yaml fence found in text of length ${text.length}`);
    }
    return null;
  }

  try {
    const raw = parseYaml(yamlMatch[1]);
    if (!raw || typeof raw !== 'object') {
      console.warn('extractYamlPlan: parsed YAML is not an object');
      return null;
    }

    const plan = raw as Record<string, unknown>;
    if (!plan.name || typeof plan.name !== 'string') {
      console.warn('extractYamlPlan: missing or non-string "name" field');
      return null;
    }
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      console.warn(`extractYamlPlan: "tasks" missing or empty (got ${typeof plan.tasks})`);
      return null;
    }

    for (const task of plan.tasks) {
      if (!task.id || !task.description) {
        console.warn(`extractYamlPlan: task missing id or description: ${JSON.stringify(task).slice(0, 120)}`);
        return null;
      }
      if (task.command && /\bnpx vitest run\b/.test(task.command)) {
        console.warn(`extractYamlPlan: task "${task.id}" uses 'npx vitest run' — rewriting to 'pnpm test'`);
        task.command = task.command.replace(/\bnpx vitest run\b/, 'pnpm test');
      }
      if (task.command && /\bpnpm test\b.*\bpackages\//.test(task.command)) {
        const rewritten = rewritePnpmTestCommand(task.command);
        if (rewritten !== task.command) {
          console.warn(`extractYamlPlan: task "${task.id}" uses root-level 'pnpm test packages/...' — rewriting to '${rewritten}'`);
          task.command = rewritten;
        }
      }
    }

    const onFinish = (plan.onFinish as PlanDefinition['onFinish']) ?? 'merge';
    const mergeMode = (plan.mergeMode as PlanDefinition['mergeMode']) ?? 'manual';
    let featureBranch = plan.featureBranch as string | undefined;
    if ((onFinish === 'merge' || onFinish === 'pull_request') && !featureBranch) {
      const slug = (plan.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      featureBranch = `plan/${slug}`;
    }
    return {
      name: plan.name,
      onFinish,
      mergeMode,
      baseBranch: (plan.baseBranch as string) ?? defaultBranch ?? 'main',
      featureBranch,
      tasks: (plan.tasks as any[]).map((t) => ({
        id: t.id,
        description: t.description,
        command: t.command,
        prompt: t.prompt,
        dependencies: t.dependencies ?? [],
        familiarType: t.familiarType ?? t.familiar_type,
        pivot: t.pivot,
        experimentVariants: t.experimentVariants,
        requiresManualApproval: t.requiresManualApproval,
        autoFix: t.autoFix,
        maxFixAttempts: t.maxFixAttempts,
      })),
    };
  } catch (err) {
    console.warn(`extractYamlPlan: YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
