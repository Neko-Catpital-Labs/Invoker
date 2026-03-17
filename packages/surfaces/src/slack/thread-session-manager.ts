/**
 * ThreadSessionManager — Thread-isolated conversation sessions.
 *
 * Manages the lifecycle of PlanConversation instances across Slack threads,
 * ensuring each (channelId, threadTs) maps to exactly one isolated conversation
 * with no context leakage. Provides TTL-based memory eviction while maintaining
 * database persistence for crash recovery.
 *
 * Architecture:
 * - SessionIdentifier: Immutable composite key (channelId, threadTs)
 * - SessionMetadata: Creation time, last access, user, submission state
 * - SessionHandle: Wraps PlanConversation with lifecycle tracking
 * - SessionManager: Central registry with TTL eviction and session limits
 */

import { PlanConversation } from './plan-conversation.js';
import type { ConversationRepository } from '@invoker/persistence';
import type { LogFn } from '../surface.js';

// ── Types ───────────────────────────────────────────────────────

/**
 * Globally unique session identifier for a Slack thread conversation.
 * Immutable and serializable.
 */
export class SessionIdentifier {
  readonly channelId: string;
  readonly threadTs: string;

  constructor(channelId: string, threadTs: string) {
    if (!channelId || !threadTs) {
      throw new Error('channelId and threadTs are required');
    }
    this.channelId = channelId;
    this.threadTs = threadTs;
  }

  /** Canonical string representation for Map keys and logging */
  toString(): string {
    return `${this.channelId}:${this.threadTs}`;
  }

  /** Parse from string format (for deserialization) */
  static fromString(key: string): SessionIdentifier {
    const [channelId, threadTs] = key.split(':', 2);
    return new SessionIdentifier(channelId, threadTs);
  }

  /** Equality check for testing and deduplication */
  equals(other: SessionIdentifier): boolean {
    return this.channelId === other.channelId && this.threadTs === other.threadTs;
  }
}

/**
 * Metadata about a conversation session, captured at creation time.
 */
export interface SessionMetadata {
  /** When the session was created */
  readonly createdAt: Date;
  /** When the session was last accessed (for TTL eviction) */
  lastAccessedAt: Date;
  /** User who initiated the conversation */
  readonly userId: string;
  /** Whether the plan has been submitted (terminal state) */
  planSubmitted: boolean;
}

/**
 * Handle to an active conversation session.
 * Wraps PlanConversation with metadata for lifecycle management.
 */
export class SessionHandle {
  readonly id: SessionIdentifier;
  readonly metadata: SessionMetadata;
  private conversation: PlanConversation;
  private disposed: boolean = false;

  constructor(
    id: SessionIdentifier,
    metadata: SessionMetadata,
    conversation: PlanConversation,
  ) {
    this.id = id;
    this.metadata = metadata;
    this.conversation = conversation;
  }

  /**
   * Send a message in this session's conversation.
   * Updates lastAccessedAt on every call.
   */
  async sendMessage(message: string): Promise<string> {
    if (this.disposed) {
      throw new Error(`Session ${this.id} has been disposed`);
    }
    this.metadata.lastAccessedAt = new Date();
    return this.conversation.sendMessage(message);
  }

  /**
   * Get the plan submitted via the submit_plan tool.
   */
  get submittedPlan() {
    return this.conversation.submittedPlan;
  }

  /**
   * Check if the plan has been submitted.
   */
  get planSubmitted(): boolean {
    return this.conversation.planSubmitted;
  }

  /**
   * Mark the plan as submitted (terminal state).
   */
  markPlanSubmitted(): void {
    this.metadata.planSubmitted = true;
  }

  /**
   * Check if session is idle for TTL eviction.
   */
  isIdleFor(durationMs: number): boolean {
    const now = Date.now();
    const lastAccess = this.metadata.lastAccessedAt.getTime();
    return now - lastAccess > durationMs;
  }

  /**
   * Check if session is eligible for cleanup.
   */
  canEvict(): boolean {
    return this.metadata.planSubmitted || this.isIdleFor(30 * 60 * 1000); // 30 minutes default
  }

  /**
   * Release resources (called during eviction).
   * After disposal, sendMessage will throw.
   */
  dispose(): void {
    this.disposed = true;
    // Conversation state already persisted, just mark disposed
  }
}

// ── SessionManager ──────────────────────────────────────────────

export interface SessionManagerConfig {
  cursorCommand?: string;
  workingDir: string;
  conversationRepo: ConversationRepository;
  sessionTtlMs?: number;
  evictionIntervalMs?: number;
  maxActiveSessions?: number;
  defaultBranch?: string;
  log?: LogFn;
}

export interface SessionMetrics {
  totalActive: number;
  idle: number;
  submitted: number;
  active: number;
}

const defaultLog: LogFn = (component, level, message) => {
  const prefix = `[${component}]`;
  if (level === 'error') console.error(prefix, message);
  else if (level === 'warn') console.warn(prefix, message);
  else console.log(prefix, message);
};

/**
 * Manages the lifecycle of conversation sessions across all Slack threads.
 * Provides session isolation guarantees and automatic cleanup.
 */
export class SessionManager {
  private sessions = new Map<string, SessionHandle>();
  private cursorCommand: string;
  private workingDir: string;
  private conversationRepo: ConversationRepository;
  private defaultBranch?: string;
  private evictionTimer?: NodeJS.Timeout;
  private log: LogFn;

  // Configuration
  private readonly sessionTtlMs: number;
  private readonly evictionIntervalMs: number;
  private readonly maxActiveSessions: number;

  constructor(config: SessionManagerConfig) {
    this.cursorCommand = config.cursorCommand ?? 'cursor';
    this.workingDir = config.workingDir;
    this.conversationRepo = config.conversationRepo;
    this.defaultBranch = config.defaultBranch;
    this.log = config.log ?? defaultLog;
    this.sessionTtlMs = config.sessionTtlMs ?? 30 * 60 * 1000; // 30 minutes
    this.evictionIntervalMs = config.evictionIntervalMs ?? 5 * 60 * 1000; // 5 minutes
    this.maxActiveSessions = config.maxActiveSessions ?? 100;
  }

  /**
   * Start the session manager and background eviction loop.
   */
  start(): void {
    this.log('session-manager', 'info', 'Starting session manager');
    this.startEvictionLoop();
  }

  /**
   * Stop the session manager and clean up all sessions.
   */
  stop(): void {
    this.log('session-manager', 'info', `Stopping session manager (${this.sessions.size} active sessions)`);
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = undefined;
    }
    // Dispose all sessions (state already persisted)
    for (const handle of this.sessions.values()) {
      handle.dispose();
    }
    this.sessions.clear();
  }

  /**
   * Get or create a session for the given identifier and user.
   * Idempotent: calling twice with same ID returns the same handle.
   *
   * @returns SessionHandle for the conversation, or null if session limit reached
   */
  async getOrCreateSession(
    id: SessionIdentifier,
    userId: string,
  ): Promise<SessionHandle | null> {
    const key = id.toString();

    // Fast path: session already in memory
    const existing = this.sessions.get(key);
    if (existing) {
      this.log('session-manager', 'info', `Session ${key} found in memory`);
      return existing;
    }

    // Check session limit before creating
    if (this.sessions.size >= this.maxActiveSessions) {
      this.log('session-manager', 'warn', `Session limit reached (${this.maxActiveSessions}), evicting idle sessions`);
      this.evictIdleSessions();

      // If still at limit after eviction, reject
      if (this.sessions.size >= this.maxActiveSessions) {
        this.log('session-manager', 'error', `Cannot create session ${key}: limit reached and no idle sessions`);
        return null;
      }
    }

    // Try to load from database
    this.log('session-manager', 'info', `[TRACE] loadConversation from DB (threadTs=${id.threadTs})`);
    const loaded = this.conversationRepo.loadConversation(id.threadTs);
    this.log('session-manager', 'info', `[TRACE] loadConversation result: ${loaded ? `found (msgs=${loaded.messages.length}, plan=${loaded.extractedPlan?.name ?? 'none'}, submitted=${loaded.planSubmitted})` : 'null'} (threadTs=${id.threadTs})`);

    if (!loaded) {
      this.log('session-manager', 'info', `No persisted conversation for ${id.threadTs}`);
    } else if (loaded.channelId !== id.channelId && loaded.channelId !== '') {
      this.log('session-manager', 'warn', `Channel mismatch for ${id.threadTs}: expected=${id.channelId}, found=${loaded.channelId}`);
    }

    let handle: SessionHandle;

    if (loaded && (loaded.channelId === id.channelId || loaded.channelId === '')) {
      // Recover existing session
      this.log('session-manager', 'info', `Recovering session ${key} from database`);

      this.log('session-manager', 'info', `[TRACE] Recovery path: creating PlanConversation + init() (threadTs=${id.threadTs})`);
      const conversation = new PlanConversation({
        cursorCommand: this.cursorCommand,
        workingDir: this.workingDir,
        threadTs: id.threadTs,
        conversationRepo: this.conversationRepo,
        defaultBranch: this.defaultBranch,
        log: this.log,
      });
      await conversation.init(); // Load state from database
      this.log('session-manager', 'info', `[TRACE] Recovery init() done (threadTs=${id.threadTs})`);

      const metadata: SessionMetadata = {
        createdAt: new Date(loaded.createdAt),
        lastAccessedAt: new Date(loaded.updatedAt),
        userId: loaded.userId,
        planSubmitted: loaded.planSubmitted,
      };

      handle = new SessionHandle(id, metadata, conversation);
    } else {
      // Create new session
      this.log('session-manager', 'info', `Creating new session ${key}`);

      this.log('session-manager', 'info', `[TRACE] Creation path: new PlanConversation (threadTs=${id.threadTs}, hasConversationRepo=true, skipping init)`);
      const conversation = new PlanConversation({
        cursorCommand: this.cursorCommand,
        workingDir: this.workingDir,
        threadTs: id.threadTs,
        conversationRepo: this.conversationRepo,
        defaultBranch: this.defaultBranch,
        log: this.log,
      });
      // Don't call init() for new sessions — nothing to load

      const metadata: SessionMetadata = {
        createdAt: new Date(),
        lastAccessedAt: new Date(),
        userId,
        planSubmitted: false,
      };

      handle = new SessionHandle(id, metadata, conversation);

      // Persist immediately so concurrent calls see it
      this.log('session-manager', 'info', `[TRACE] Saving empty conversation to DB (threadTs=${id.threadTs}, channelId=${id.channelId}, userId=${userId})`);
      this.conversationRepo.saveConversation(
        id.threadTs,
        [], // No messages yet
        null, // No plan yet
        false, // Not submitted
        id.channelId,
        userId,
      );
    }

    // Register in memory
    this.sessions.set(key, handle);
    this.log('session-manager', 'info', `Session ${key} registered (total active: ${this.sessions.size})`);

    return handle;
  }

  /**
   * Mark a session as having submitted its plan.
   * This makes it eligible for immediate eviction.
   */
  markPlanSubmitted(id: SessionIdentifier): void {
    const key = id.toString();
    const handle = this.sessions.get(key);
    if (handle) {
      handle.markPlanSubmitted();
      this.conversationRepo.saveConversation(
        id.threadTs,
        [],
        undefined,
        true,
      );
      this.log('session-manager', 'info', `Session ${key} marked as submitted (persisted)`);
    }
  }

  /**
   * Get metrics about active sessions (for observability).
   */
  getMetrics(): SessionMetrics {
    let idleCount = 0;
    let submittedCount = 0;

    for (const handle of this.sessions.values()) {
      if (handle.metadata.planSubmitted) {
        submittedCount++;
      } else if (handle.isIdleFor(this.sessionTtlMs)) {
        idleCount++;
      }
    }

    return {
      totalActive: this.sessions.size,
      idle: idleCount,
      submitted: submittedCount,
      active: this.sessions.size - idleCount - submittedCount,
    };
  }

  /**
   * Look up an existing session without creating one.
   * Returns null if no session exists in memory for this identifier.
   */
  findSession(id: SessionIdentifier): SessionHandle | null {
    return this.sessions.get(id.toString()) ?? null;
  }

  /**
   * Explicitly evict a session (for admin commands or testing).
   */
  evictSession(id: SessionIdentifier): boolean {
    const key = id.toString();
    const handle = this.sessions.get(key);
    if (!handle) return false;

    handle.dispose();
    this.sessions.delete(key);
    this.log('session-manager', 'info', `Session ${key} evicted`);
    return true;
  }

  // ── Private: Eviction Loop ──────────────────────────────────

  private startEvictionLoop(): void {
    this.evictionTimer = setInterval(() => {
      this.evictIdleSessions();
    }, this.evictionIntervalMs);
  }

  private evictIdleSessions(): void {
    const toEvict: string[] = [];

    for (const [key, handle] of this.sessions.entries()) {
      if (handle.canEvict()) {
        toEvict.push(key);
      }
    }

    if (toEvict.length > 0) {
      this.log('session-manager', 'info', `Evicting ${toEvict.length} idle sessions`);
      for (const key of toEvict) {
        const handle = this.sessions.get(key);
        handle?.dispose();
        this.sessions.delete(key);
      }
    }
  }
}
