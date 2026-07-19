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
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { ConversationRepository } from '@invoker/data-store';
import { formatCodexPlannerStdout } from '@invoker/execution-engine';
import type { LogFn } from '../surface.js';
import {
  buildUnverifiedNotice,
  captureRepoState,
  looksLikeCompletionClaim,
  repoStateUnchanged,
} from './agent-turn-verification.js';

// ── Types ───────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ConversationMode = 'agent' | 'plan';

export type PlanningCommandBuilder = (opts: {
  tool: string;
  model?: string;
  prompt: string;
}) => { command: string; args: string[] };
export type RawPlannerOutputHandler = (chunk: string) => void;

export function defaultPlanningCommand(
  cursorCommand: string,
  opts: { model?: string; prompt: string },
): { command: string; args: string[] } {
  const args = ['--print'];
  if (opts.model) args.push('--model', opts.model);
  args.push(opts.prompt);
  return { command: cursorCommand, args };
}

const EMPTY_PLANNER_STDERR_TAIL_LIMIT = 500;

export const DEFAULT_PLANNER_RETRY_LIMIT = 2;
export const DEFAULT_PLANNER_RETRY_BASE_DELAY_MS = 500;

// Shared with slack-surface.ts so both planner spawn paths surface the same
// actionable error when the CLI exits 0 but writes nothing to stdout. The
// stderr tail is preserved because Cursor/Codex/OMP often log the real reason
// (auth expiry, permission denial, context overflow) to stderr while still
// reporting a successful exit. `attemptCount` is included when the caller
// exhausted its retry budget so the error message credits the retry loop.
export function buildEmptyPlannerOutputError(
  plannerLabel: string,
  stderr: string,
  options: { attemptCount?: number } = {},
): Error {
  const trimmed = stderr.trim();
  const tail = trimmed ? ` — stderr tail: ${trimmed.slice(-EMPTY_PLANNER_STDERR_TAIL_LIMIT)}` : '';
  const attemptSuffix = options.attemptCount && options.attemptCount > 1
    ? ` after ${options.attemptCount} attempts`
    : '';
  return new Error(`${plannerLabel} exited 0 but produced no output${attemptSuffix}${tail}`);
}

// Internal marker for the specific "success with empty stdout" case so the
// retry wrapper can distinguish transient silent-success from user-actionable
// failures (non-zero exit, spawn error, timeout) that must not be retried.
class RetryableEmptyPlannerOutputError extends Error {
  constructor(public readonly stderrTail: string) {
    super('planner exited 0 with no output');
    this.name = 'RetryableEmptyPlannerOutputError';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PlanConversationConfig {
  /** Command to invoke the agent CLI. Default: 'agent'. */
  cursorCommand?: string;
  /** Planning tool name (e.g. 'cursor', 'omp', 'codex') passed to the builder. */
  tool?: string;
  /** Model to use (e.g. 'auto', 'sonnet-4'). Omit to use the CLI default. */
  model?: string;
  /** Agent prompt mode. `agent` is a normal coding session; `plan` drafts Invoker YAML. */
  mode?: ConversationMode;
  /** Injected builder that maps {tool, model, prompt} → CLI command + args. */
  planningCommandBuilder?: PlanningCommandBuilder;
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
  /** Default repo URL (e.g. "git@github.com:user/repo.git"). Used when plan YAML omits repoUrl. */
  repoUrl?: string;
  /** EXPERIMENTAL_PLANNER: when true, steer the agent to order the plan via the
   * experimental planner MCP tool (`plan`). The redirect server enforces the gate. */
  experimentalPlanner?: boolean;
  /** Prefer top-level `workflows:` stack plans for multi-slice reviewable work. */
  preferStackedWorkflows?: boolean;
  /** Optional callback for raw stdout chunks emitted by the planner subprocess. */
  onRawPlannerOutput?: RawPlannerOutputHandler;
  /** Logging callback. Defaults to console.log/console.error. */
  log?: LogFn;
  /**
   * How many additional attempts to make when the planner exits 0 with empty
   * stdout. Only retries the empty-output case; non-zero exit, spawn error,
   * and timeout are not retried. Default: 2 (so 3 attempts total).
   */
  plannerRetryLimit?: number;
  /**
   * Base delay in milliseconds between empty-output retry attempts. Each
   * subsequent retry doubles this value. Default: 500ms (waits 500ms before
   * attempt 2, 1000ms before attempt 3, and so on).
   */
  plannerRetryBaseDelayMs?: number;
}

// ── Confirmation Detection ──────────────────────────────────

const CONFIRMATION_PATTERNS = [
  /^yes$/i,
  /^y$/i,
  /^yes please$/i,
  /^ok$/i,
  /^okay$/i,
  /^approve$/i,
  /^go$/i,
  /^go ahead$/i,
  /^execute$/i,
  /^run it$/i,
  /^start$/i,
  /^proceed$/i,
  /^do it$/i,
  /^confirm$/i,
  /^submit$/i,
  /^lgtm$/i,
  /^ship it$/i,
  /^approved$/i,
  /^sounds good$/i,
];

export function isConfirmation(text: string): boolean {
  const trimmed = text.trim().replace(/[.!]+$/, '');
  return CONFIRMATION_PATTERNS.some((re) => re.test(trimmed));
}

const NEGATION_PATTERNS = [
  /^no$/i,
  /^n$/i,
  /^nope$/i,
  /^cancel$/i,
  /^stop$/i,
  /^abort$/i,
  /^nvm$/i,
  /^never ?mind$/i,
];

export function isNegation(text: string): boolean {
  const trimmed = text.trim().replace(/[.?!]+$/, '');
  return NEGATION_PATTERNS.some((re) => re.test(trimmed));
}

// ── System Prompt ───────────────────────────────────────────

function buildAgentSystemPrompt(): string {
  return `You are a normal coding agent running in a git worktree for a Slack thread.

Default behavior:
- Treat the thread like an ordinary OMP/Codex coding session.
- Answer questions, run local commands, inspect files, edit code, and run focused verification when useful.
- Do NOT generate Invoker YAML in this thread. If the user asks for an Invoker plan, tell them to start a new plan thread with \`plan: <request>\` — plan drafts from an agent thread cannot be submitted.
- Do NOT submit or start an Invoker workflow. Do NOT invoke \`invoker-cli\`, \`invoker_submit_plan\`, \`invoker_validate_plan\`, \`submit-plan.sh\`, or the \`plan-to-invoker\` skill's Harness handoff mode to do so. Agent threads reject \`submit\`; only a \`plan:\` thread can be submitted.
- Keep Slack replies short and concrete: changed files, verification, and any remaining risk.
- To share a generated file (screenshot, diagram, report), write it inside your worktree and link it by absolute path as a markdown link, e.g. \`[chart](/abs/path/in/worktree/chart.png)\`. Files linked that way are uploaded to the thread. Files written outside your worktree cannot be shared, so do not put artifacts in /tmp.`;
}

function buildStackedWorkflowPrompt(repoUrlLine: string, defaultBranch: string): string {
  return `For reviewable multi-slice implementation work, prefer a workflow stack over one workflow with many independent implementation tasks:
\`\`\`yaml
name: "Stack Name"
${repoUrlLine}
onFinish: pull_request
mergeMode: external_review
baseBranch: ${defaultBranch}
workflows:
  - name: "Stack Name Step 1"
    featureBranch: plan/stack-name-step-1
    tasks:
      - id: implement-step-1
        description: "Build the first reviewable slice"
        prompt: "Specific implementation instructions"
        dependencies: []
      - id: verify-step-1
        description: "Verify the first slice"
        command: "discovered test command"
        dependencies: [implement-step-1]
  - name: "Stack Name Step 2"
    featureBranch: plan/stack-name-step-2
    tasks:
      - id: implement-step-2
        description: "Build the next reviewable slice"
        prompt: "Specific implementation instructions"
        dependencies: []
      - id: verify-step-2
        description: "Verify the next slice"
        command: "discovered test command"
        dependencies: [implement-step-2]
\`\`\`

When submitted, Invoker creates one workflow per child in listed order. Each downstream workflow is based on the previous workflow's feature branch and waits on the previous merge gate.`;
}

function buildPlanSystemPrompt(
  defaultBranch: string,
  repoUrl?: string,
  preferStackedWorkflows = false,
  planFilePath?: string,
): string {
  const repoUrlLine = repoUrl
    ? `repoUrl: "${repoUrl}"          # git clone URL for the repository`
    : 'repoUrl: "<ask the user for this>"  # no repo is configured for this thread';
  const stackedWorkflowSection = preferStackedWorkflows
    ? `\n${buildStackedWorkflowPrompt(repoUrlLine, defaultBranch)}\n`
    : '';
  const outputInstruction = planFilePath
    ? `This is the delivery rule stated at the top. Write the COMPLETE YAML plan to the file at \`${planFilePath}\`, and reply in chat with only a one-or-two-sentence summary. Never paste the YAML into chat.`
    : 'When ready, output the plan inside a \`\`\`yaml code block.';
  const deliveryDirective = planFilePath
    ? `HOW TO DELIVER THE PLAN (read first): write the COMPLETE YAML plan to the file at \`${planFilePath}\` using your file-writing tool, then reply in chat with ONLY a short summary — one or two sentences. NEVER paste the YAML plan into your chat reply; Invoker reads it from the file and shows the user a per-task summary. Every YAML block below is the format for that file, not for your chat reply. A pasted plan gets cut off at your output limit, which is the exact problem the file avoids.\n\n`
    : '';
  const repoUrlDirective = repoUrl
    ? ''
    : 'NO REPO CONFIGURED (read first): this thread has no target repository configured — not via a `[repo:]` tag and not via a default. Before drafting any YAML, ask the user which repository this plan targets (a `[repo:<alias>]` tag, or a full git clone URL) and wait for their reply. Never invent, guess, or copy the `repoUrl` placeholder shown below literally into a plan.\n\n';
  return `You are an assistant for the Invoker orchestrator. The user explicitly requested an Invoker plan.

${repoUrlDirective}${deliveryDirective}Generate a YAML task plan as described below. Answer simple follow-up questions directly only when they are about the plan being drafted.

A plan has this structure:
\`\`\`yaml
name: "Plan Name"
${repoUrlLine}
onFinish: pull_request  # "pull_request" (default), "merge", or "none"
mergeMode: external_review  # "external_review" = GitHub-backed review gate for reviewable implementation work; "manual" (default) = verification-only, no review; "automatic" = merge without review
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

\`\`\`
${stackedWorkflowSection}
Rules:
1. Explore the codebase first (list directories, read key files). Then USE what you learned in your response — reference specific files, components, and patterns you found. Do NOT give generic responses that ignore the code you read.
2. For ambiguous implementation requests, tiny nits, or broad "make this better" requests, do a brief scoping pass before YAML:
   - State concise assumptions based on the repository evidence you found.
   - Show a short plan preview with the likely review slice(s) and verification commands.
   - Ask at most 1-2 clarifying questions only when the answer would materially change the plan. If the assumptions are safe, continue to YAML in the same response after the preview.
3. Keep plans focused. ${preferStackedWorkflows ? 'For reviewable multi-slice implementation work, prefer 2-6 stacked child workflows with one local implementation-and-verification slice each, instead of one workflow with many independent implementation tasks. ' : ''}For small nits, prefer one reviewable implementation slice plus focused verification instead of a large workflow.
4. File-count guidance is a soft heuristic, not a hard validator gate. Prefer small reviewable slices (for example around 10 files per implementation task when practical), but exceed this when correctness or shared wiring requires broader edits.
5. Each task should have either a \`command\` or a \`prompt\`, not both. Do not include legacy \`autoFix\` or \`autoFixRetries\` fields anywhere in the YAML; auto-fix retries are configured only in ~/.invoker/config.json.
6. Every step MUST be testable. Every implementation task MUST have a corresponding test task that verifies it works using a concrete, executable \`command\` discovered from the target repo (e.g. that repo's package scripts, build commands, or focused checks such as \`git diff --name-only\`). The test command must produce a clear pass/fail exit code. Do NOT skip tests for any step. Do NOT use prompts for test tasks — use commands only.
   Test command rules:
   - Inspect repo manifests and existing docs/scripts before choosing commands.
   - Use the package manager and test runner the target repo already uses; do not impose Invoker-specific commands on external repos.
   - For focused package tests in a monorepo, run from the relevant package/workspace directory or use the repo's documented workspace filter.
   - To target a specific test file, use the syntax supported by the discovered test script.
   - Prefer focused verification during iteration and reserve broad/full-suite commands for the final gate only when the target repo documents such a command.
   - If Invoker config auto-routes heavyweight commands, keep discovered test/build commands as normal command tasks unless the task must name a specific remote target
   - NEVER invent test file names. Verify the test file exists before referencing it in a command.
7. Use meaningful task IDs (kebab-case).
8. ${outputInstruction}
9. Always include \`dependencies\` (even if empty array).
10. After generating a plan, include a short post-plan summary that tells the user they can confirm execution. The confirmation instruction MUST be exactly this standalone line:
Reply \`submit\` to submit it.
Do NOT place that line inline in a sentence.
11. NEVER submit, validate, or execute this plan yourself. Do NOT invoke \`invoker-cli\` (with any flags), \`invoker_submit_plan\`, \`invoker_validate_plan\`, \`submit-plan.sh\`, or the \`plan-to-invoker\` skill's Harness handoff mode. This rule overrides that skill's handoff instructions in this Slack thread. The Slack orchestrator validates and executes the plan after the user replies \`submit\` and approves it. If the user instead says \`execute\`, \`run it\`, \`yes\`, or \`go\` before submitting, remind them to reply with \`submit\`; never run it yourself.
12. Choose \`mergeMode\` deliberately. For reviewable implementation plans, set \`mergeMode: external_review\` so changes land through the canonical GitHub-backed review gate. Keep \`mergeMode: manual\` (the default) for verification-only plans that should not open a review, and use \`mergeMode: automatic\` only when the user explicitly wants changes merged without review.`;
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
  private tool?: string;
  private model?: string;
  private mode: ConversationMode;
  private planningCommandBuilder?: PlanningCommandBuilder;
  private messages: ConversationMessage[] = [];
  private _submittedPlanText: string | null = null;
  private _planSubmitted = false;
  readonly workingDir?: string;
  private timeoutMs: number;
  private threadTs?: string;
  private conversationRepo?: ConversationRepository;
  private defaultBranch?: string;
  private repoUrl?: string;
  private experimentalPlanner?: boolean;
  private preferStackedWorkflows?: boolean;
  private log: LogFn;
  private onRawPlannerOutput?: RawPlannerOutputHandler;
  private plannerRetryLimit: number;
  private plannerRetryBaseDelayMs: number;
  private _initialized = false;
  private _lastTurnReasoning: string[] = [];

  constructor(config: PlanConversationConfig) {
    this.cursorCommand = config.cursorCommand ?? 'agent';
    this.tool = config.tool;
    this.model = config.model;
    this.mode = config.mode ?? 'plan';
    this.planningCommandBuilder = config.planningCommandBuilder;
    this.workingDir = config.workingDir;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.threadTs = config.threadTs;
    this.conversationRepo = config.conversationRepo;
    this.defaultBranch = config.defaultBranch;
    this.repoUrl = config.repoUrl;
    this.experimentalPlanner = config.experimentalPlanner;
    this.preferStackedWorkflows = config.preferStackedWorkflows;
    this.onRawPlannerOutput = config.onRawPlannerOutput;
    this.plannerRetryLimit = Math.max(0, config.plannerRetryLimit ?? DEFAULT_PLANNER_RETRY_LIMIT);
    this.plannerRetryBaseDelayMs = Math.max(0, config.plannerRetryBaseDelayMs ?? DEFAULT_PLANNER_RETRY_BASE_DELAY_MS);
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
      this.mode = saved.mode ?? this.mode;

      this.log('plan-conversation', 'info', `Restored conversation ${this.threadTs}: ${saved.messages.length} messages`);
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to load conversation ${this.threadTs}: ${err}`);
    }
  }

  /**
   * Send a user message to the planner and return its reply. Pure conversation:
   * drafting a plan never auto-submits it — submission is an explicit step
   * driven by the surface (the `submit` verb), so a stray "yes" can't ship a plan.
   */
  async sendMessage(userMessage: string): Promise<string> {
    const t0 = Date.now();
    const turn = this.messages.filter(m => m.role === 'user').length + 1;
    this.log('plan-conversation', 'info', `[TRACE] sendMessage() start (threadTs=${this.threadTs}, initialized=${this._initialized}, msgCount=${this.messages.length}, turn=${turn})`);

    if (!this._initialized) await this.init();
    const tInit = Date.now();

    this.resetPlanDraftFile();
    this.messages.push({ role: 'user', content: userMessage });

    const prompt = this.buildCursorPrompt();
    const tPrompt = Date.now();
    this.log('plan-conversation', 'info', `[CONV] Turn ${turn}: promptLen=${prompt.length}, historyMsgs=${this.messages.length - 1}, promptPreview="${prompt.slice(0, 500).replace(/\n/g, '\\n')}"`);

    const repoStateBefore = this.mode === 'agent'
      ? await captureRepoState(this.workingDir)
      : null;
    const response = await this.spawnPlanner(prompt);
    const tCursor = Date.now();
    const formatted = formatCodexPlannerStdout(response);
    let message = formatted.message;
    const repoStateAfter = this.mode === 'agent'
      ? await captureRepoState(this.workingDir)
      : null;
    if (looksLikeCompletionClaim(message) && repoStateUnchanged(repoStateBefore, repoStateAfter)) {
      message = `${message}\n\n${buildUnverifiedNotice()}`;
    }
    this._lastTurnReasoning = formatted.reasoning;
    this.log('plan-conversation', 'info', `[CONV] Turn ${turn}: responseLen=${response.length}, messageLen=${message.length}, reasoningParts=${formatted.reasoning.length}, responsePreview="${message.slice(0, 500).replace(/\n/g, '\\n')}"`);

    this.messages.push({ role: 'assistant', content: message });
    this.saveState();
    const tSave = Date.now();

    this.log('plan-conversation', 'info', `[PERF] sendMessage: init=${tInit - t0}ms, buildPrompt=${tPrompt - tInit}ms, cursor=${tCursor - tPrompt}ms, saveState=${tSave - tCursor}ms, total=${tSave - t0}ms`);
    return message;
  }

  /** Reasoning summaries from the most recent planner turn (Codex JSONL), if any. */
  get lastTurnReasoning(): string[] {
    return this._lastTurnReasoning;
  }

  /** Returns the raw plan text that was submitted via confirmation, or null. */
  get submittedPlanText(): string | null {
    return this._submittedPlanText;
  }

  /** Returns true if the user confirmed and a plan was extracted. */
  get planSubmitted(): boolean {
    return this._planSubmitted;
  }

  get conversationMode(): ConversationMode {
    return this.mode;
  }

  /** Returns the last complete YAML plan drafted in this conversation, or null. */
  getDraftedPlan(): string | null {
    return this.readPlanDraftFile() ?? this.extractLastPlanFromMessages();
  }

  // The planner writes the full YAML plan here so its chat reply can stay a
  // short summary instead of an inline block that truncates when the model hits
  // its output limit. Gated on workingDir + threadTs; without both, planning
  // falls back to inline extraction unchanged. `.invoker/` is gitignored.
  planDraftFilePath(): string | null {
    if (!this.workingDir || !this.threadTs) return null;
    const safeId = this.threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.workingDir, '.invoker', 'plan-drafts', `${safeId}.yaml`);
  }

  private readPlanDraftFile(): string | null {
    const path = this.planDraftFilePath();
    if (!path) return null;
    try {
      if (!existsSync(path)) return null;
      const content = readFileSync(path, 'utf8').trim();
      return content.length > 0 ? content : null;
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to read plan draft file ${path}: ${err}`);
      return null;
    }
  }

  // Remove any prior turn's plan file and ensure the directory exists, so a fresh
  // write is required each turn (getDraftedPlan must never return a stale plan)
  // and the planner's write into it succeeds.
  private resetPlanDraftFile(): void {
    const path = this.planDraftFilePath();
    if (!path) return;
    try {
      rmSync(path, { force: true });
      mkdirSync(dirname(path), { recursive: true });
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to reset plan draft file ${path}: ${err}`);
    }
  }

  /** Returns the conversation history. */
  get history(): readonly ConversationMessage[] {
    return this.messages.filter((m) => m.content.length > 0);
  }

  /** Reset the conversation. */
  reset(): void {
    this.messages = [];
    this._submittedPlanText = null;
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
    const systemPrompt = this.mode === 'plan'
      ? buildPlanSystemPrompt(this.defaultBranch ?? 'main', this.repoUrl, this.preferStackedWorkflows, this.planDraftFilePath() ?? undefined)
      : buildAgentSystemPrompt();
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
      parts.push(this.mode === 'plan'
        ? '\nRespond to the latest message. If it requires a plan, explore the codebase and generate one.'
        : '\nRespond to the latest message as a normal coding agent in this worktree.');
    }

    if (this.experimentalPlanner) {
      parts.push(
        '\n[EXPERIMENTAL_PLANNER] Before finalizing the order, call the `plan` MCP ' +
        'tool with the conversation to get the experimental planner\'s ordered ' +
        'features/tasks + dependency edges, and base your plan\'s ordering on it. ' +
        'If the tool is unavailable, order the plan yourself as usual.');
    }

    return parts.join('\n');
  }

  // ── Planner CLI Subprocess ─────────────────────────────

  async spawnPlanner(prompt: string): Promise<string> {
    const { command, args } = this.planningCommandBuilder
      ? this.planningCommandBuilder({ tool: this.tool ?? 'cursor', model: this.model, prompt })
      : defaultPlanningCommand(this.cursorCommand, { model: this.model, prompt });
    const plannerLabel = this.tool ?? command;
    const totalAttempts = this.plannerRetryLimit + 1;
    let lastStderrTail = '';

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
      if (attempt > 0) {
        const backoffMs = this.plannerRetryBaseDelayMs * (2 ** (attempt - 1));
        this.log('plan-conversation', 'warn',
          `[PLANNER_RETRY] backing off ${backoffMs}ms before attempt=${attempt + 1}/${totalAttempts} (planner=${plannerLabel})`);
        await delay(backoffMs);
      }
      try {
        return await this.spawnPlannerAttempt(prompt, command, args, plannerLabel, attempt + 1, totalAttempts);
      } catch (err) {
        if (err instanceof RetryableEmptyPlannerOutputError) {
          lastStderrTail = err.stderrTail;
          const isLast = attempt >= totalAttempts - 1;
          this.log('plan-conversation', 'warn',
            `[PLANNER_RETRY] attempt=${attempt + 1}/${totalAttempts} produced no output (planner=${plannerLabel}, willRetry=${!isLast}, stderrBytes=${err.stderrTail.length}, stderrTail="${err.stderrTail.slice(-200).replace(/\n/g, '\\n')}")`);
          if (!isLast) continue;
          throw buildEmptyPlannerOutputError(plannerLabel, lastStderrTail, { attemptCount: totalAttempts });
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns, continues, or throws on every path above.
    throw buildEmptyPlannerOutputError(plannerLabel, lastStderrTail, { attemptCount: totalAttempts });
  }

  private spawnPlannerAttempt(
    prompt: string,
    command: string,
    args: string[],
    plannerLabel: string,
    attemptNumber: number,
    totalAttempts: number,
  ): Promise<string> {
    const spawnStart = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: this.workingDir ?? process.cwd(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';
      let stdoutChunks = 0;
      let stderrChunks = 0;

      this.log('plan-conversation', 'info', `[PERF] cursor_spawn: pid=${child.pid ?? 'none'}, cmd="${command} ${args.slice(0, -1).join(' ')} <prompt>", promptLen=${prompt.length}, cwd=${this.workingDir ?? process.cwd()}, attempt=${attemptNumber}/${totalAttempts}`);

      child.stdout?.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString();
        stdout += chunkStr;
        stdoutChunks++;
        if (this.onRawPlannerOutput) {
          try {
            this.onRawPlannerOutput(chunkStr);
          } catch (err) {
            this.log('plan-conversation', 'error', `Raw planner output handler failed: ${err}`);
          }
        }
        this.log('plan-conversation', 'info', `[PERF] cursor_stdout chunk #${stdoutChunks}: +${chunkStr.length} bytes (total=${stdout.length}, elapsed=${Date.now() - spawnStart}ms)`);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const chunkStr = chunk.toString();
        stderr += chunkStr;
        stderrChunks++;
        this.log('plan-conversation', 'info', `[PERF] cursor_stderr chunk #${stderrChunks}: +${chunkStr.length} bytes (total=${stderr.length}, elapsed=${Date.now() - spawnStart}ms), preview="${chunkStr.slice(0, 200).replace(/\n/g, '\\n')}"`);
      });

      const timer = setTimeout(() => {
        this.log('plan-conversation', 'error', `[PERF] cursor_timeout: pid=${child.pid ?? 'none'}, stdoutBytes=${stdout.length}, stderrBytes=${stderr.length}, stdoutChunks=${stdoutChunks}, stderrChunks=${stderrChunks}, elapsed=${Date.now() - spawnStart}ms, stderrTail="${stderr.slice(-500).replace(/\n/g, '\\n')}"`);
        try { child.kill('SIGTERM'); } catch { /* already dead */ }
        reject(new Error(`${plannerLabel} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timer);
        this.log('plan-conversation', 'info', `[PERF] cursor_exit: code=${code}, stdoutBytes=${stdout.length}, stderrBytes=${stderr.length}, stdoutChunks=${stdoutChunks}, stderrChunks=${stderrChunks}, elapsed=${Date.now() - spawnStart}ms, attempt=${attemptNumber}/${totalAttempts}`);
        if (code === 0) {
          const trimmed = stdout.trim();
          if (trimmed) {
            resolve(trimmed);
          } else {
            reject(new RetryableEmptyPlannerOutputError(stderr));
          }
        } else {
          const errMsg = stderr.trim() || stdout.trim() || 'Unknown error';
          reject(new Error(`${plannerLabel} exited with code ${code}: ${errMsg}`));
        }
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Failed to spawn ${plannerLabel}: ${err.message}`));
      });
    });
  }

  // ── Plan Extraction ────────────────────────────────────

  private extractLastPlanFromMessages(): string | null {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role !== 'assistant') continue;
      if (!msg.content) continue;
      return extractYamlPlan(msg.content);
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
        undefined,
        undefined,
        this.mode,
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

function isExtractedPlanRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateExtractedPlanTasks(tasks: unknown, ownerLabel: string): boolean {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    console.warn(`extractYamlPlan: ${ownerLabel} "tasks" missing or empty (got ${typeof tasks})`);
    return false;
  }

  for (const task of tasks) {
    if (!isExtractedPlanRecord(task) || !task.id || !task.description) {
      console.warn(`extractYamlPlan: ${ownerLabel} task missing id or description: ${JSON.stringify(task).slice(0, 120)}`);
      return false;
    }
  }

  return true;
}

function stripPlannerOnlyFields(plan: Record<string, any>): void {
  delete plan.autoFix;
  delete plan.autoFixRetries;
  for (const task of Array.isArray(plan.tasks) ? plan.tasks : []) {
    if (!isExtractedPlanRecord(task)) continue;
    delete task.autoFix;
    delete task.autoFixRetries;
  }
  for (const workflow of Array.isArray(plan.workflows) ? plan.workflows : []) {
    if (!isExtractedPlanRecord(workflow)) continue;
    stripPlannerOnlyFields(workflow);
  }
}

// ── YAML Extraction ─────────────────────────────────────────

/**
 * Extract and validate a YAML plan from a message containing ```yaml blocks.
 * Returns the raw YAML string or null if invalid.
 * Defaulting (onFinish, baseBranch, mergeMode, etc.) is NOT applied here —
 * callers should pass the returned string through parsePlan() for that.
 */
export function extractYamlPlan(text: string): string | null {
  // Find the last ```yaml opening fence
  const fenceStart = text.lastIndexOf('```yaml\n');
  if (fenceStart === -1) {
    if (text.length > 100) {
      console.warn(`extractYamlPlan: no \`\`\`yaml fence found in text of length ${text.length}`);
    }
    return null;
  }
  const contentStart = fenceStart + '```yaml\n'.length;
  const rest = text.slice(contentStart);
  // Find closing ``` at start of a line (not indented = not inside YAML block scalar).
  // If the message ends before the closing fence, still try the rest of the
  // message: the parse/shape checks below keep malformed and partial plans out.
  const closeMatch = rest.match(/^```\s*$/m);
  const yamlContent = closeMatch && closeMatch.index !== undefined
    ? rest.slice(0, closeMatch.index)
    : rest;

  try {
    const raw = parseYaml(yamlContent);
    if (!raw || typeof raw !== 'object') {
      console.warn('extractYamlPlan: parsed YAML is not an object');
      return null;
    }

    const plan = raw as Record<string, any>;
    if (!plan.name || typeof plan.name !== 'string') {
      console.warn('extractYamlPlan: missing or non-string "name" field');
      return null;
    }

    if (Array.isArray(plan.workflows)) {
      if (plan.workflows.length === 0) {
        console.warn('extractYamlPlan: "workflows" is empty');
        return null;
      }
      for (const [index, workflow] of plan.workflows.entries()) {
        if (!isExtractedPlanRecord(workflow) || !workflow.name || typeof workflow.name !== 'string') {
          console.warn(`extractYamlPlan: workflow ${index} missing name`);
          return null;
        }
        if (!validateExtractedPlanTasks(workflow.tasks, `workflow ${index}`)) return null;
      }
    } else if (!validateExtractedPlanTasks(plan.tasks, 'plan')) {
      return null;
    }

    stripPlannerOnlyFields(plan);
    return stringifyYaml(plan);
  } catch (err) {
    console.warn(`extractYamlPlan: YAML parse error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
