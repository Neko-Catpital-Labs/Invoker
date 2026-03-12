/**
 * PlanConversation — Thread-based planning via Claude API.
 *
 * Manages a multi-turn conversation in a Slack thread where a user
 * describes what they want, Claude explores the codebase using tools,
 * and eventually generates a validated YAML plan.
 */

import Anthropic from '@anthropic-ai/sdk';
import { parse as parseYaml } from 'yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { PlanDefinition } from '@invoker/core';
import type { ConversationRepository } from '@invoker/persistence';
import type { LogFn } from '../surface.js';

// ── Types ───────────────────────────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface PlanConversationConfig {
  apiKey: string;
  model?: string;
  /** Root directory for file tools. If set, enables codebase exploration. */
  workingDir?: string;
  /** Max tool-use loop iterations. Default: 15. */
  maxToolIterations?: number;
  /** Slack thread timestamp. Required for persistence. */
  threadTs?: string;
  /** Repository for persisting conversation state across restarts. */
  conversationRepo?: ConversationRepository;
  /** Default branch name (e.g. "master"). Used when plan YAML omits baseBranch. */
  defaultBranch?: string;
  /** Logging callback. Defaults to console.log/console.error. */
  log?: LogFn;
}

// ── System Prompt ───────────────────────────────────────────

function buildSystemPrompt(defaultBranch: string): string {
  return `You are an assistant for the Invoker orchestrator. You have two modes:

**Direct answer mode** — For simple, self-contained requests (counting lines of code, checking versions, running a quick command, answering questions about the codebase). Use the \`run_command\` tool to execute a shell command and report the result directly. Do NOT generate a YAML plan for these.

**Plan mode** — For multi-step implementation tasks (adding features, fixing bugs, refactoring code). Generate a YAML task plan as described below.

Use your judgment: if the request can be answered with 1-2 commands or a short explanation, use direct answer mode. If it requires coordinated changes across multiple files, use plan mode.

A plan has this structure:
\`\`\`yaml
name: "Plan Name"
onFinish: merge         # "merge" (default), "none", or "pull_request"
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
1. If file tools are available, explore the codebase first (list directories, read key files). Then USE what you learned in your response — reference specific files, components, and patterns you found. Do NOT give generic responses that ignore the code you read.
2. After exploring, generate the YAML plan directly. Do NOT ask clarifying questions unless absolutely necessary — prefer making reasonable assumptions based on the code you read.
3. Keep plans focused — 3-8 tasks maximum.
4. Each task should have either a \`command\` or a \`prompt\`, not both.
5. Every step MUST be testable. Every implementation task MUST have a corresponding test task that verifies it works using a concrete, executable \`command\` (e.g. \`cd packages/protocol && pnpm test\`, \`git diff --name-only\`). The test command must produce a clear pass/fail exit code. Do NOT skip tests for any step. Do NOT use prompts for test tasks — use commands only.
   Test command rules:
   - ALWAYS cd into the package directory first: \`cd packages/<pkg> && pnpm test\`
   - To target a specific test file: \`cd packages/<pkg> && pnpm test -- src/__tests__/file.test.ts\`
   - NEVER run \`pnpm test <path>\` from the repo root — it runs \`pnpm -r test\` across all packages and the path will be wrong
   - NEVER use \`npx vitest run\` — always use \`pnpm test\` which runs through electron-vitest with the correct native module ABI
   - NEVER invent test file names. Use list_files or search_files to verify the test file exists before referencing it in a command.
6. Use meaningful task IDs (kebab-case).
7. When ready, output the plan inside a \`\`\`yaml code block.
8. Always include \`dependencies\` (even if empty array).
9. After generating a plan, tell the user they can confirm execution by replying with "yes", "go", "execute", etc. NEVER mention "/invoker" in your response — there is NO /invoker start_plan or any /invoker command for plan execution. These commands do not exist. When the user confirms, you MUST call the \`submit_plan\` tool. Do NOT output bash commands, shell scripts, or tell the user to run anything manually. The ONLY way to start a plan is by calling the \`submit_plan\` tool. If the user wants changes, refine the plan first.
10. NEVER generate bash commands or shell scripts to execute plans. You cannot run commands. The submit_plan tool is the ONLY way to start execution.`;
}

const TOOLS_ADDENDUM = `

# Available Tools

You have access to filesystem tools to explore the codebase before generating a plan:
- **read_file**: Read a file's contents (path relative to repo root)
- **list_files**: List files in a directory (supports glob pattern filtering)
- **search_files**: Search file contents with regex
- **run_command**: Run a read-only shell command (e.g. \`wc -l\`, \`node -v\`, \`git log --oneline -5\`). Use for simple queries that don't need a plan.

Use multiple tools in a single turn when possible (e.g. list_files and read_file together). Start by listing the root directory, then read 2-3 key files. After exploring, STOP using tools and respond to the user with your findings. Keep exploration to 5 files maximum — do not keep exploring indefinitely.

- **submit_plan**: Submit the generated plan for execution. Call this tool when the user confirms they want to run the plan (e.g. "yes", "go ahead", "run it", "start", "execute"). This is the ONLY way to start plan execution — do NOT output bash commands or tell the user to run anything manually.`;

// ── Tool Definitions ────────────────────────────────────────

const SUBMIT_PLAN_TOOL: Anthropic.Messages.Tool = {
  name: 'submit_plan',
  description: 'Submit the generated plan for execution. Only use after the user has confirmed they want to run it.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
};

const RUN_COMMAND_TOOL: Anthropic.Messages.Tool = {
  name: 'run_command',
  description:
    'Run a read-only shell command in the repo. Use for simple queries (counting lines, checking versions, listing processes). Do NOT use for commands that modify files or state.',
  input_schema: {
    type: 'object' as const,
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
    required: ['command'],
  },
};

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

const FILE_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file at the given path (relative to repo root).',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'File path relative to repo root' },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories. Returns names with "/" suffix for directories.',
    input_schema: {
      type: 'object' as const,
      properties: {
        directory: { type: 'string', description: 'Directory path relative to repo root. Default: "."' },
        pattern: { type: 'string', description: 'Optional glob pattern to filter (e.g. "*.ts")' },
      },
      required: [],
    },
  },
  {
    name: 'search_files',
    description: 'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        directory: { type: 'string', description: 'Directory to search in (relative to repo root). Default: "."' },
        file_pattern: { type: 'string', description: 'Glob pattern for files to search (e.g. "*.ts")' },
      },
      required: ['pattern'],
    },
  },
];

// ── Constants ───────────────────────────────────────────────

const MAX_FILE_SIZE = 30_000; // 30KB — keeps total context under API limits
const MAX_RESULTS = 100;
const MAX_TOOL_RESULT_LENGTH = 10_000; // Truncate any single tool result to ~10KB

// ── PlanConversation ────────────────────────────────────────

export class PlanConversation {
  private client: Anthropic;
  private model: string;
  private apiMessages: Anthropic.Messages.MessageParam[] = [];
  private _submittedPlan: PlanDefinition | null = null;
  private _planSubmitted = false;
  private workingDir?: string;
  private maxToolIterations: number;
  private threadTs?: string;
  private conversationRepo?: ConversationRepository;
  private defaultBranch?: string;
  private log: LogFn;
  private _initialized = false;

  constructor(config: PlanConversationConfig) {
    this.client = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model ?? 'claude-sonnet-4-20250514';
    this.workingDir = config.workingDir;
    this.maxToolIterations = config.maxToolIterations ?? 12;
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
   * If no repository is configured or no saved state exists, this is a no-op.
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

      // Restore API messages from saved conversation messages.
      // Saved messages store content as deserialized objects (arrays of content blocks)
      // or plain strings — both are valid MessageParam content.
      this.apiMessages = saved.messages.map((m) => ({
        role: m.role,
        content: m.content as Anthropic.Messages.MessageParam['content'],
      }));
      this._planSubmitted = saved.planSubmitted;

      this.log('plan-conversation', 'info', `Restored conversation ${this.threadTs}: ${saved.messages.length} messages`);
    } catch (err) {
      this.log('plan-conversation', 'error', `Failed to load conversation ${this.threadTs}: ${err}`);
      // Continue with empty state — don't block the conversation
    }
  }

  /**
   * Send a user message and get Claude's response.
   * If workingDir is set, Claude can use file tools to explore the codebase.
   * The loop continues until Claude produces a final text response.
   * Persists conversation state after each completed exchange.
   */
  async sendMessage(userMessage: string): Promise<string> {
    // Auto-init on first sendMessage if not already called
    this.log('plan-conversation', 'info', `[TRACE] sendMessage() start (threadTs=${this.threadTs}, initialized=${this._initialized}, msgCount=${this.apiMessages.length})`);
    if (!this._initialized) await this.init();

    this.apiMessages.push({ role: 'user', content: userMessage });

    const hasFileTools = !!this.workingDir;
    const basePrompt = buildSystemPrompt(this.defaultBranch ?? 'main');
    const systemPrompt = hasFileTools
      ? basePrompt + TOOLS_ADDENDUM
      : basePrompt;
    const tools = hasFileTools
      ? [...FILE_TOOLS, RUN_COMMAND_TOOL, SUBMIT_PLAN_TOOL]
      : [SUBMIT_PLAN_TOOL];
    this.log('plan-conversation', 'info', `[TRACE] sendMessage() tools: hasFileTools=${hasFileTools}, toolCount=${tools.length}`);

    let iterations = 0;

    while (iterations < this.maxToolIterations) {
      iterations++;

      // On the last 2 iterations, inject a nudge to stop exploring and respond
      if (hasFileTools && iterations === this.maxToolIterations - 1) {
        this.apiMessages.push({
          role: 'user',
          content: 'You have explored enough. Stop using tools and generate your response now based on what you have learned.',
        });
      }

      this.log('plan-conversation', 'info', `Iteration ${iterations}, calling Claude API (${this.apiMessages.length} messages)...`);
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 16384,
        system: systemPrompt,
        messages: this.apiMessages,
        tools,
      });

      this.log('plan-conversation', 'info', `stop_reason=${response.stop_reason}, content blocks=${response.content.length}`);
      if (response.stop_reason === 'max_tokens') {
        this.log('plan-conversation', 'warn', 'Response truncated by max_tokens limit. YAML extraction may fail.');
      }

      // If no tool use, extract text and return
      if (response.stop_reason !== 'tool_use') {
        const text = response.content
          .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        this.apiMessages.push({ role: 'assistant', content: response.content });

        this.saveState();
        return text;
      }

      // Tool use: append assistant message, execute tools, append results
      this.apiMessages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        this.log('plan-conversation', 'info', `Tool call: ${block.name}(${JSON.stringify(block.input).slice(0, 200)})`);

        let result: string;
        let isError = false;
        try {
          result = await this.executeTool(block.name, block.input as Record<string, unknown>);
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          isError = true;
        }

        // Truncate large results to avoid exceeding API token limits
        if (result.length > MAX_TOOL_RESULT_LENGTH) {
          result = result.slice(0, MAX_TOOL_RESULT_LENGTH) + '\n... (truncated)';
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result,
          is_error: isError,
        });
      }

      this.apiMessages.push({ role: 'user', content: toolResults });
      this.saveState();
    }

    throw new Error(`Tool-use loop exceeded ${this.maxToolIterations} iterations`);
  }

  /** Returns the plan that was submitted via submit_plan tool, or null. */
  get submittedPlan(): PlanDefinition | null {
    return this._submittedPlan;
  }

  /** Returns true if the user confirmed and Claude called submit_plan. */
  get planSubmitted(): boolean {
    return this._planSubmitted;
  }

  /** Returns the conversation history as simple role/content pairs. */
  get history(): readonly ConversationMessage[] {
    return this.apiMessages
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content:
          typeof m.content === 'string'
            ? m.content
            : (m.content as any[])
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join(''),
      }))
      .filter((m) => m.content.length > 0);
  }

  /** Reset the conversation. */
  reset(): void {
    this.apiMessages = [];
    this._submittedPlan = null;
    this._planSubmitted = false;
    if (this.conversationRepo && this.threadTs) {
      this.conversationRepo.deleteConversation(this.threadTs);
    }
  }

  /**
   * Scan apiMessages in reverse for the last valid YAML plan.
   * Looks at assistant messages only, extracting text and running extractYamlPlan().
   */
  private extractLastPlanFromMessages(): PlanDefinition | null {
    for (let i = this.apiMessages.length - 1; i >= 0; i--) {
      const msg = this.apiMessages[i];
      if (msg.role !== 'assistant') continue;

      const text =
        typeof msg.content === 'string'
          ? msg.content
          : (msg.content as any[])
              .filter((b: any) => b.type === 'text')
              .map((b: any) => b.text)
              .join('');

      if (!text) continue;

      const plan = extractYamlPlan(text, this.defaultBranch);
      if (plan) return plan;
    }
    return null;
  }

  // ── Persistence ────────────────────────────────────────

  /** Persist current state to the database. No-op if no repository configured. */
  private saveState(): void {
    if (!this.conversationRepo || !this.threadTs) return;

    try {
      const messages = this.apiMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
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
      // Don't throw — persistence failure shouldn't break the conversation
    }
  }

  // ── Tool Execution ──────────────────────────────────────

  /** Execute a tool by name. All paths are resolved relative to workingDir. */
  async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'read_file': {
        const filePath = this.resolvePath(input.path as string);
        const stat = await fs.promises.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) {
          return `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE}). Try searching for specific content instead.`;
        }
        return await fs.promises.readFile(filePath, 'utf-8');
      }
      case 'list_files': {
        const dir = this.resolvePath((input.directory as string) || '.');
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        let results = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
        if (input.pattern) {
          const re = globToRegex(input.pattern as string);
          results = results.filter((r) => re.test(r.replace(/\/$/, '')));
        }
        if (results.length > MAX_RESULTS) {
          return results.slice(0, MAX_RESULTS).join('\n') + `\n... (${results.length - MAX_RESULTS} more)`;
        }
        return results.join('\n') || '(empty directory)';
      }
      case 'search_files': {
        return this.searchFiles(
          input.pattern as string,
          (input.directory as string) || '.',
          input.file_pattern as string | undefined,
        );
      }
      case 'run_command': {
        const command = input.command as string;
        if (isDangerousCommand(command)) {
          return 'Blocked: potentially destructive command. Only read-only commands are allowed.';
        }
        try {
          return execFileSync('bash', ['-c', command], {
            cwd: this.workingDir,
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
            encoding: 'utf8',
          });
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      case 'submit_plan': {
        const plan = this.extractLastPlanFromMessages();
        if (!plan) {
          return 'Error: No valid YAML plan found in the conversation history. Generate a plan first.';
        }
        this._submittedPlan = plan;
        this._planSubmitted = true;
        return `Plan "${plan.name}" submitted for execution.`;
      }
      default:
        return `Unknown tool: ${name}`;
    }
  }

  /** Resolve a relative path against workingDir, blocking traversal. */
  resolvePath(relative: string): string {
    if (!this.workingDir) throw new Error('No workingDir configured');
    const resolved = path.resolve(this.workingDir, relative);
    if (!resolved.startsWith(this.workingDir)) {
      throw new Error(`Path "${relative}" escapes the working directory`);
    }
    return resolved;
  }

  private searchFiles(pattern: string, directory: string, filePattern?: string): string {
    const dir = this.resolvePath(directory);
    const args = ['-rn', '-E', pattern, dir];
    if (filePattern) args.splice(2, 0, '--include', filePattern);

    try {
      const output = execFileSync('grep', args, {
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
      const lines = output.split('\n').filter(Boolean);
      if (lines.length > MAX_RESULTS) {
        return lines.slice(0, MAX_RESULTS).join('\n') + `\n... (${lines.length - MAX_RESULTS} more matches)`;
      }
      return lines.join('\n') || 'No matches found.';
    } catch (err: any) {
      if (err.status === 1) return 'No matches found.';
      throw err;
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
    let featureBranch = plan.featureBranch as string | undefined;
    if ((onFinish === 'merge' || onFinish === 'pull_request') && !featureBranch) {
      const slug = (plan.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      featureBranch = `plan/${slug}`;
    }
    return {
      name: plan.name,
      onFinish,
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
