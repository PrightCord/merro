export const SCHEMA_VERSION = 19;

export const MIGRATION_19 = `
ALTER TABLE relations ADD COLUMN gate TEXT CHECK (gate IN ('reviewed','done'));
ALTER TABLE relations ADD COLUMN consumed_reviewed_commit TEXT;
ALTER TABLE work_item_runtime ADD COLUMN github_team_review_pending INTEGER NOT NULL DEFAULT 0 CHECK (github_team_review_pending IN (0, 1));
DROP INDEX IF EXISTS decisions_one_pending_per_subject;
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_pending_per_subject_kind
ON decisions(subject_type, subject_id, kind)
WHERE state = 'pending';
`;

export const MIGRATION_17 = `
ALTER TABLE work_items ADD COLUMN delivery TEXT NOT NULL DEFAULT 'pr' CHECK (delivery IN ('local','pr'));
ALTER TABLE work_items ADD COLUMN target_branch TEXT CHECK (delivery = 'pr' OR (target_branch IS NOT NULL AND length(trim(target_branch)) > 0));
CREATE TRIGGER change_set_delivery_immutable BEFORE UPDATE OF delivery, target_branch ON work_items
WHEN NEW.delivery IS NOT OLD.delivery OR NEW.target_branch IS NOT OLD.target_branch
BEGIN SELECT RAISE(ABORT, 'ChangeSet delivery is immutable'); END;
`;

export const MIGRATION_1 = `
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_meta (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  base_remote TEXT NOT NULL,
  push_remote TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS objectives (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Done', 'Stopped')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  source_type TEXT NOT NULL CHECK (source_type IN ('issue', 'local')),
  source_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('Planned','Ready','Implementing','Reviewing','AwaitingMerge','Blocked','Done','Obsolete','Cancelled')),
  priority TEXT NOT NULL CHECK (priority IN ('high', 'normal', 'low')),
  ready_since TEXT,
  blocked_reason TEXT CHECK (blocked_reason IN (
    'review_cap','cycle','task_failed','clone_lost','policy_unknown','github_unavailable',
    'structural_rejected','merge_rejected','merge_failed','pr_closed',
    'remote_branch_deleted','project_unavailable'
  )),
  blocked_resume_state TEXT CHECK (blocked_resume_state IN ('Planned','Ready','Implementing','Reviewing','AwaitingMerge')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (state = 'Blocked' AND blocked_reason IS NOT NULL AND blocked_resume_state IS NOT NULL)
    OR
    (state <> 'Blocked' AND blocked_reason IS NULL AND blocked_resume_state IS NULL)
  ),
  UNIQUE(project_slug, source_type, source_ref, generation)
);

CREATE UNIQUE INDEX IF NOT EXISTS work_items_one_live_generation
ON work_items(project_slug, source_type, source_ref)
WHERE state NOT IN ('Done', 'Obsolete', 'Cancelled');

CREATE TRIGGER IF NOT EXISTS work_items_block_from_current_flow
BEFORE UPDATE ON work_items
WHEN OLD.state <> 'Blocked'
  AND NEW.state = 'Blocked'
  AND NEW.blocked_resume_state IS NOT OLD.state
BEGIN
  SELECT RAISE(ABORT, 'Blocked WorkItem resume state must match previous flow state');
END;

CREATE TRIGGER IF NOT EXISTS blocked_work_items_resume_previous_flow
BEFORE UPDATE ON work_items
WHEN OLD.state = 'Blocked'
  AND NEW.state NOT IN ('Blocked', 'Obsolete', 'Cancelled')
  AND NEW.state IS NOT OLD.blocked_resume_state
BEGIN
  SELECT RAISE(ABORT, 'Blocked WorkItem must resume previous flow state');
END;

CREATE TRIGGER IF NOT EXISTS terminal_work_items_core_immutable_update
BEFORE UPDATE ON work_items
WHEN OLD.state IN ('Done', 'Obsolete', 'Cancelled')
  AND (
    NEW.id IS NOT OLD.id
    OR NEW.project_slug IS NOT OLD.project_slug
    OR NEW.source_type IS NOT OLD.source_type
    OR NEW.source_ref IS NOT OLD.source_ref
    OR NEW.generation IS NOT OLD.generation
    OR NEW.state IS NOT OLD.state
    OR NEW.priority IS NOT OLD.priority
    OR NEW.ready_since IS NOT OLD.ready_since
    OR NEW.blocked_reason IS NOT OLD.blocked_reason
    OR NEW.blocked_resume_state IS NOT OLD.blocked_resume_state
    OR NEW.created_at IS NOT OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'terminal WorkItem core fields are immutable');
END;

CREATE TABLE IF NOT EXISTS objective_work_items (
  objective_id TEXT NOT NULL REFERENCES objectives(id),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  PRIMARY KEY (objective_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('Requires', 'Conflicts')),
  from_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  to_work_item_id TEXT NOT NULL REFERENCES work_items(id),
  confidence TEXT NOT NULL CHECK (confidence IN ('explicit', 'high')),
  rationale TEXT NOT NULL,
  evidence TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  CHECK (from_work_item_id <> to_work_item_id),
  UNIQUE(kind, from_work_item_id, to_work_item_id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  role TEXT NOT NULL CHECK (role IN ('implement', 'review')),
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'finalized')),
  outcome TEXT CHECK (outcome IN ('success', 'failed', 'cancelled', 'pass', 'reject')),
  started_at TEXT NOT NULL,
  finalized_at TEXT,
  commit_sha TEXT,
  reviewed_commit TEXT,
  summary TEXT,
  result_json TEXT,
  CHECK ((status = 'active' AND outcome IS NULL AND finalized_at IS NULL) OR (status = 'finalized' AND outcome IS NOT NULL AND finalized_at IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_active_per_work_item
ON tasks(work_item_id)
WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS finalized_tasks_are_immutable_update
BEFORE UPDATE ON tasks
WHEN OLD.status = 'finalized'
BEGIN
  SELECT RAISE(ABORT, 'finalized Task is immutable');
END;

CREATE TRIGGER IF NOT EXISTS finalized_tasks_are_immutable_delete
BEFORE DELETE ON tasks
WHEN OLD.status = 'finalized'
BEGIN
  SELECT RAISE(ABORT, 'finalized Task is immutable');
END;

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'resolved')),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_pending_per_subject_kind
ON decisions(subject_type, subject_id, kind)
WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS objective_projects (
  objective_id TEXT NOT NULL REFERENCES objectives(id) ON DELETE CASCADE,
  project_slug TEXT NOT NULL REFERENCES projects(slug),
  PRIMARY KEY (objective_id, project_slug)
);

CREATE TABLE IF NOT EXISTS project_settings (
  project_slug TEXT PRIMARY KEY REFERENCES projects(slug) ON DELETE CASCADE,
  guidance TEXT NOT NULL DEFAULT '',
  image TEXT,
  setup_command TEXT,
  sandbox TEXT CHECK (sandbox IN ('docker', 'none')),
  network TEXT CHECK (network IN ('on', 'off')),
  worker_github INTEGER CHECK (worker_github IN (0, 1))
);

CREATE TABLE IF NOT EXISTS objective_settings (
  objective_id TEXT PRIMARY KEY REFERENCES objectives(id) ON DELETE CASCADE,
  max_review_rounds TEXT CHECK (max_review_rounds = 'unlimited' OR CAST(max_review_rounds AS INTEGER) > 0)
);

CREATE TABLE IF NOT EXISTS work_item_settings (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  guidance TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS work_item_runtime (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  branch_name TEXT,
  clone_path TEXT,
  base_commit TEXT,
  pull_request_number INTEGER,
  pull_request_url TEXT,
  pull_request_state TEXT,
  pull_request_head_sha TEXT,
  pull_request_base_sha TEXT,
  review_round INTEGER NOT NULL DEFAULT 0 CHECK (review_round >= 0),
  infrastructure_retries INTEGER NOT NULL DEFAULT 0 CHECK (infrastructure_retries >= 0),
  implementation_attempt INTEGER NOT NULL DEFAULT 0 CHECK (implementation_attempt >= 0),
  last_reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS task_runtime (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  tmux_session TEXT NOT NULL,
  tmux_window TEXT NOT NULL,
  pane_id TEXT,
  container_id TEXT,
  process_pid INTEGER,
  process_started_at TEXT,
  clone_path TEXT NOT NULL,
  task_file_path TEXT NOT NULL,
  result_path TEXT NOT NULL,
  started_at TEXT NOT NULL
);
`;

export const MIGRATION_3 = `
ALTER TABLE task_runtime ADD COLUMN expected_commit TEXT NOT NULL DEFAULT '';
`;

export const MIGRATION_4 = `
ALTER TABLE task_runtime ADD COLUMN runtime_kind TEXT CHECK (runtime_kind IN ('docker', 'host'));
`;

export const MIGRATION_5 = `
ALTER TABLE work_item_runtime ADD COLUMN merged_commit_sha TEXT;
`;

export const MIGRATION_6 = `
ALTER TABLE work_item_runtime ADD COLUMN last_rework_trigger TEXT;
`;

export const MIGRATION_7 = `
DROP TRIGGER IF EXISTS blocked_work_items_resume_previous_flow;
CREATE TRIGGER blocked_work_items_resume_previous_flow
BEFORE UPDATE ON work_items
WHEN OLD.state = 'Blocked'
  AND NEW.state NOT IN ('Blocked', 'Obsolete', 'Cancelled', 'Done')
  AND NEW.state IS NOT OLD.blocked_resume_state
BEGIN
  SELECT RAISE(ABORT, 'Blocked WorkItem must resume previous flow state');
END;
`;

export const MIGRATION_8 = `
ALTER TABLE work_item_runtime ADD COLUMN last_issue_state TEXT;
ALTER TABLE work_item_runtime ADD COLUMN reviewed_diff_hash TEXT;
`;

export const MIGRATION_9 = `
CREATE TABLE final_summaries (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TRIGGER final_summaries_immutable_update
BEFORE UPDATE ON final_summaries
BEGIN
  SELECT RAISE(ABORT, 'final summaries are immutable');
END;

CREATE TRIGGER final_summaries_immutable_delete
BEFORE DELETE ON final_summaries
BEGIN
  SELECT RAISE(ABORT, 'final summaries are immutable');
END;
`;

export const MIGRATION_10 = `
ALTER TABLE objectives ADD COLUMN issue_scopes_json TEXT CHECK (issue_scopes_json IS NULL OR json_valid(issue_scopes_json));
ALTER TABLE work_item_runtime ADD COLUMN base_update_json TEXT CHECK (base_update_json IS NULL OR json_valid(base_update_json));
ALTER TABLE task_runtime ADD COLUMN base_update_json TEXT CHECK (base_update_json IS NULL OR json_valid(base_update_json));
`;

export const MIGRATION_11 = `
ALTER TABLE objective_work_items ADD COLUMN in_scope INTEGER NOT NULL DEFAULT 1 CHECK (in_scope IN (0, 1));
ALTER TABLE relations ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0 CHECK (automatic IN (0, 1));
`;

export const MIGRATION_12 = `
ALTER TABLE task_runtime ADD COLUMN cleanup_completed_at TEXT;
CREATE INDEX task_runtime_pending_cleanup ON task_runtime(task_id) WHERE cleanup_completed_at IS NULL;
`;

export const MIGRATION_16 = `
ALTER TABLE work_item_runtime ADD COLUMN github_checks_at TEXT;
ALTER TABLE work_item_runtime ADD COLUMN github_review_decision TEXT;
`;
