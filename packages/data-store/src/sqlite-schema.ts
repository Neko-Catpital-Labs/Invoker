/**
 * SQLite schema DDL and migration statements for {@link SQLiteAdapter}.
 *
 * Pure SQL strings extracted from the adapter so schema/migration definitions
 * live in one place. The adapter executes these in the same order it always
 * has, so migration sequencing and query semantics are unchanged.
 */

/** Full schema definition, executed once on `initSchema()`. */
export const SCHEMA_DDL = `
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        visual_proof INTEGER,
        plan_file TEXT,
        repo_url TEXT,
        intermediate_repo_url TEXT,
        branch TEXT,
        on_finish TEXT,
        base_branch TEXT,
        parent_remote TEXT,
        feature_branch TEXT,
        merge_mode TEXT,
        review_provider TEXT,
        external_dependencies TEXT,
        external_dependency_changes TEXT,
        detached_external_dependencies TEXT,
        generation INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        blocked_by TEXT,
        dependencies TEXT DEFAULT '[]',
        command TEXT,
        prompt TEXT,
        exit_code INTEGER,
        error TEXT,
        protocol_error_code TEXT,
        protocol_error_message TEXT,
        input_prompt TEXT,
        external_dependencies TEXT,

        -- Context
        summary TEXT,
        problem TEXT,
        approach TEXT,
        test_plan TEXT,
        repro_command TEXT,
        fix_prompt TEXT,
        fix_context TEXT,

        -- Git
        branch TEXT,
        commit_hash TEXT,
        fixed_integration_sha TEXT,
        fixed_integration_recorded_at TEXT,
        fixed_integration_source TEXT,
        parent_task TEXT,

        -- Experiments
        pivot INTEGER DEFAULT 0,
        experiment_variants TEXT,
        is_reconciliation INTEGER DEFAULT 0,
        selected_experiment TEXT,
        experiment_results TEXT,
        requires_manual_approval INTEGER DEFAULT 0,

        -- Repository
        repo_url TEXT,
        feature_branch TEXT,

        -- Merge node
        is_merge_node INTEGER DEFAULT 0,

        -- Claude session
        claude_session_id TEXT,
        workspace_path TEXT,

        -- Timestamps
        created_at TEXT DEFAULT (datetime('now')),
        launch_phase TEXT,
        launch_started_at TEXT,
        launch_completed_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        execution_generation INTEGER DEFAULT 0,
        docker_image TEXT,
        execution_model TEXT,

        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_task_id_id
        ON events(task_id, id);

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversations (
        thread_ts TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        extracted_plan TEXT,
        plan_submitted INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS conversation_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_ts TEXT NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (thread_ts) REFERENCES conversations(thread_ts)
      );

      CREATE INDEX IF NOT EXISTS idx_conv_messages_thread
        ON conversation_messages(thread_ts, seq);

      CREATE TABLE IF NOT EXISTS workflow_channels (
        workflow_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        requested_by TEXT,
        lobby_channel_id TEXT,
        lobby_thread_ts TEXT,
        harness_preset TEXT,
        repo_url TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_channels_channel
        ON workflow_channels(channel_id);

      CREATE TABLE IF NOT EXISTS task_output (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_task_output_task
        ON task_output(task_id);

      CREATE INDEX IF NOT EXISTS idx_tasks_workflow_id
        ON tasks(workflow_id);

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        node_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        queue_priority INTEGER NOT NULL DEFAULT 0,
        status TEXT DEFAULT 'pending',

        -- Input snapshot
        snapshot_commit TEXT,
        base_branch TEXT,
        upstream_attempt_ids TEXT DEFAULT '[]',

        -- Overrides
        command_override TEXT,
        prompt_override TEXT,

        -- Execution state
        claimed_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        exit_code INTEGER,
        error TEXT,
        last_heartbeat_at TEXT,
        lease_expires_at TEXT,

        -- Output
        branch TEXT,
        commit_hash TEXT,
        summary TEXT,
        workspace_path TEXT,
        claude_session_id TEXT,
        container_id TEXT,

        -- Lineage
        supersedes_attempt_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),

        -- Merge conflict
        merge_conflict TEXT,

        FOREIGN KEY (node_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_attempts_node_created
        ON attempts(node_id, created_at);

      CREATE TABLE IF NOT EXISTS workflow_mutation_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        args_json TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'queued',
        owner_id TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        started_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_mutation_intents_workflow_status
        ON workflow_mutation_intents(workflow_id, status, priority, id);

      CREATE TABLE IF NOT EXISTS workflow_mutation_leases (
        workflow_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        active_intent_id INTEGER,
        active_mutation_kind TEXT,
        leased_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(id),
        FOREIGN KEY (active_intent_id) REFERENCES workflow_mutation_intents(id)
      );

      CREATE INDEX IF NOT EXISTS idx_workflow_mutation_leases_expiry
        ON workflow_mutation_leases(lease_expires_at);

      CREATE TABLE IF NOT EXISTS task_launch_dispatch (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'enqueued',
        priority TEXT NOT NULL DEFAULT 'normal',
        dispatch_owner TEXT,
        enqueued_at TEXT NOT NULL DEFAULT (datetime('now')),
        leased_at TEXT,
        acknowledged_at TEXT,
        completed_at TEXT,
        fenced_until TEXT,
        attempts_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        generation INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id),
        FOREIGN KEY (workflow_id) REFERENCES workflows(id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_launch_dispatch_active_attempt
        ON task_launch_dispatch(attempt_id)
        WHERE state IN ('enqueued', 'leased');

      CREATE INDEX IF NOT EXISTS idx_task_launch_dispatch_ready
        ON task_launch_dispatch(state, priority, id)
        WHERE state IN ('enqueued', 'leased');

      CREATE INDEX IF NOT EXISTS idx_task_launch_dispatch_workflow_state
        ON task_launch_dispatch(workflow_id, state);

      CREATE INDEX IF NOT EXISTS idx_task_launch_dispatch_task_state
        ON task_launch_dispatch(task_id, state);

      CREATE TABLE IF NOT EXISTS worker_actions (
        id TEXT PRIMARY KEY,
        worker_kind TEXT NOT NULL,
        action_type TEXT NOT NULL,
        workflow_id TEXT,
        task_id TEXT,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        external_key TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        intent_id TEXT,
        agent_name TEXT,
        execution_model TEXT,
        session_id TEXT,
        summary TEXT,
        payload_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        UNIQUE(worker_kind, external_key)
      );

      CREATE INDEX IF NOT EXISTS idx_worker_actions_task_updated
        ON worker_actions(task_id, updated_at);

      CREATE INDEX IF NOT EXISTS idx_worker_actions_workflow_status
        ON worker_actions(workflow_id, worker_kind, status);

      CREATE TABLE IF NOT EXISTS execution_resource_leases (
        resource_key TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        task_id TEXT,
        pool_id TEXT,
        pool_member_id TEXT,
        acquired_at TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        metadata_json TEXT,
        PRIMARY KEY(resource_key, holder_id)
      );

      CREATE INDEX IF NOT EXISTS idx_execution_resource_leases_resource
        ON execution_resource_leases(resource_key, lease_expires_at);

      CREATE INDEX IF NOT EXISTS idx_execution_resource_leases_expiry
        ON execution_resource_leases(lease_expires_at);

      CREATE TABLE IF NOT EXISTS output_spool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        offset INTEGER NOT NULL,
        data TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_output_spool_task_offset
        ON output_spool(task_id, offset);
    `;

/** Idempotent `ALTER TABLE ... ADD COLUMN` migrations for older databases. */
export const COLUMN_MIGRATIONS = [
  'ALTER TABLE tasks ADD COLUMN claude_session_id TEXT',
  'ALTER TABLE tasks ADD COLUMN workspace_path TEXT',
  'ALTER TABLE tasks ADD COLUMN container_id TEXT',
  'ALTER TABLE tasks ADD COLUMN is_merge_node INTEGER DEFAULT 0',
  'ALTER TABLE workflows ADD COLUMN on_finish TEXT',
  'ALTER TABLE workflows ADD COLUMN base_branch TEXT',
  'ALTER TABLE workflows ADD COLUMN parent_remote TEXT',
  'ALTER TABLE workflows ADD COLUMN feature_branch TEXT',
  'ALTER TABLE workflows ADD COLUMN generation INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN last_heartbeat_at TEXT',
  'ALTER TABLE tasks ADD COLUMN experiment_prompt TEXT',
  'ALTER TABLE tasks ADD COLUMN auto_fix INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN max_fix_attempts INTEGER',
  'ALTER TABLE tasks ADD COLUMN action_request_id TEXT',
  'ALTER TABLE tasks ADD COLUMN experiments TEXT',
  'ALTER TABLE tasks ADD COLUMN selected_experiments TEXT',
  'ALTER TABLE tasks ADD COLUMN utilization INTEGER',
  'ALTER TABLE tasks ADD COLUMN pending_fix_error TEXT',
  'ALTER TABLE workflows ADD COLUMN merge_mode TEXT',
  'ALTER TABLE tasks ADD COLUMN review_url TEXT',
  'ALTER TABLE tasks ADD COLUMN review_id TEXT',
  'ALTER TABLE tasks ADD COLUMN review_status TEXT',
  'ALTER TABLE tasks ADD COLUMN review_provider_id TEXT',
  'ALTER TABLE tasks ADD COLUMN review_gate TEXT',
  'ALTER TABLE tasks ADD COLUMN is_fixing_with_ai INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN execution_generation INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN docker_image TEXT',
  'ALTER TABLE tasks ADD COLUMN selected_attempt_id TEXT',
  'ALTER TABLE tasks ADD COLUMN pool_member_id TEXT',
  'ALTER TABLE workflows ADD COLUMN description TEXT',
  'ALTER TABLE workflows ADD COLUMN visual_proof INTEGER',
  'ALTER TABLE workflows ADD COLUMN intermediate_repo_url TEXT',
  // agent_session_id: new column for pluggable agent architecture
  'ALTER TABLE tasks ADD COLUMN agent_session_id TEXT',
  'ALTER TABLE attempts ADD COLUMN agent_session_id TEXT',
  'ALTER TABLE workflows ADD COLUMN review_provider TEXT',
  'ALTER TABLE workflows ADD COLUMN external_dependencies TEXT',
  'ALTER TABLE workflows ADD COLUMN external_dependency_changes TEXT',
  // detached_external_dependencies: read-only provenance for deps removed by detachWorkflow
  'ALTER TABLE workflows ADD COLUMN detached_external_dependencies TEXT',
  // execution_agent / agent_name: interchangeable agent support
  'ALTER TABLE tasks ADD COLUMN execution_agent TEXT',
  'ALTER TABLE tasks ADD COLUMN agent_name TEXT',
  // durable audit pointers for most-recent agent session/name
  'ALTER TABLE tasks ADD COLUMN last_agent_session_id TEXT',
  'ALTER TABLE tasks ADD COLUMN last_agent_name TEXT',
  'ALTER TABLE tasks ADD COLUMN external_dependencies TEXT',
  'ALTER TABLE tasks ADD COLUMN runner_kind TEXT',
  'ALTER TABLE tasks ADD COLUMN pool_id TEXT',
  'ALTER TABLE tasks ADD COLUMN auto_fix_attempts INTEGER DEFAULT 0',
  'ALTER TABLE tasks ADD COLUMN launch_phase TEXT',
  'ALTER TABLE tasks ADD COLUMN launch_started_at TEXT',
  'ALTER TABLE tasks ADD COLUMN launch_completed_at TEXT',
  'ALTER TABLE tasks ADD COLUMN fixed_integration_sha TEXT',
  'ALTER TABLE tasks ADD COLUMN fixed_integration_recorded_at TEXT',
  'ALTER TABLE tasks ADD COLUMN fixed_integration_source TEXT',
  'ALTER TABLE tasks ADD COLUMN fix_prompt TEXT',
  'ALTER TABLE tasks ADD COLUMN fix_context TEXT',
  'ALTER TABLE tasks ADD COLUMN execution_model TEXT',
  'ALTER TABLE attempts ADD COLUMN queue_priority INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE attempts ADD COLUMN claimed_at TEXT',
  'ALTER TABLE attempts ADD COLUMN lease_expires_at TEXT',
  'ALTER TABLE tasks ADD COLUMN task_state_version INTEGER NOT NULL DEFAULT 1',
];

/**
 * Index reconciliation run after the column migrations. Replaces the old
 * attempt_number index with a created_at index and rebuilds the active-attempt
 * dispatch index. Order preserved from the original `migrate()` body.
 */
export const POST_MIGRATION_STATEMENTS = [
  'DROP INDEX IF EXISTS idx_attempts_node',
  'CREATE INDEX IF NOT EXISTS idx_attempts_node_created ON attempts(node_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_events_task_id_id ON events(task_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_workflow_id ON tasks(workflow_id)',
  'CREATE INDEX IF NOT EXISTS idx_worker_actions_task_updated ON worker_actions(task_id, updated_at)',
  'CREATE INDEX IF NOT EXISTS idx_worker_actions_workflow_status ON worker_actions(workflow_id, worker_kind, status)',
  'DROP INDEX IF EXISTS idx_task_launch_dispatch_active_attempt',
  `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_task_launch_dispatch_active_attempt
        ON task_launch_dispatch(attempt_id)
        WHERE state IN ('enqueued', 'leased')
    `,
];

/** Rebuilt `workflows` table used to drop a legacy `status` column. */
export const WORKFLOWS_REBUILD_TABLE_DDL = `
      CREATE TABLE workflows_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        visual_proof INTEGER,
        plan_file TEXT,
        repo_url TEXT,
        intermediate_repo_url TEXT,
        branch TEXT,
        on_finish TEXT,
        base_branch TEXT,
        parent_remote TEXT,
        feature_branch TEXT,
        merge_mode TEXT,
        review_provider TEXT,
        external_dependencies TEXT,
        external_dependency_changes TEXT,
        generation INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `;

/** Copies rows from the legacy `workflows` table into the rebuilt one. */
export const WORKFLOWS_REBUILD_INSERT_DDL = `
      INSERT INTO workflows_new (
        id, name, description, visual_proof, plan_file, repo_url, intermediate_repo_url,
        branch, on_finish, base_branch, parent_remote, feature_branch, merge_mode,
        review_provider, external_dependencies, external_dependency_changes,
        generation, created_at, updated_at
      )
      SELECT
        id, name, description, visual_proof, plan_file, repo_url, intermediate_repo_url,
        branch, on_finish, base_branch, parent_remote, feature_branch, merge_mode,
        review_provider, external_dependencies, external_dependency_changes,
        generation, created_at, updated_at
      FROM workflows
    `;
