import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12, SCHEMA_VERSION } from "../src/store/schema.js";
import { MerroStore } from "../src/store/store.js";

const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12];

function makeStore(): MerroStore {
  const store = new MerroStore(":memory:");
  store.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  return store;
}

test("v16 changes retain PR delivery and recorded clone paths; new local targets are required and immutable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "merro-local-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.db");
  const original = new MerroStore(path);
  original.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  original.createChangeSet({ id: "legacy", projectSlug: "p", slug: "legacy", issues: [{ projectSlug: "p", number: 1 }], generation: 1, state: "Reviewed", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("UPDATE work_item_runtime SET clone_path = '/tmp/old:clone', branch_name = 'fix/legacy' WHERE work_item_id = 'legacy'; DROP INDEX decisions_one_pending_per_subject_kind; CREATE UNIQUE INDEX decisions_one_pending_per_subject ON decisions(subject_type, subject_id) WHERE state = 'pending'; ALTER TABLE relations DROP COLUMN consumed_reviewed_commit; ALTER TABLE relations DROP COLUMN gate; ALTER TABLE work_item_runtime DROP COLUMN github_team_review_pending; DROP TRIGGER change_set_delivery_immutable; ALTER TABLE work_items DROP COLUMN target_branch; ALTER TABLE work_items DROP COLUMN delivery; UPDATE schema_meta SET version = 16;");
  legacy.close();
  const migrated = new MerroStore(path);
  try {
    assert.equal(migrated.getChangeSet("legacy")?.delivery, "pr");
    assert.equal(migrated.getChangeSet("legacy")?.targetBranch, undefined);
    assert.equal(migrated.getChangeSetRuntime("legacy")?.clonePath, "/tmp/old:clone");
    assert.throws(() => migrated.transitionChangeSet("legacy", "Done"), /invalid/);
    const local = { id: "local", projectSlug: "p", slug: "local", issues: [], delivery: "local" as const, generation: 1, state: "Planned" as const, priority: "normal" as const, readySince: null, blockedReason: null, blockedResumeState: null };
    assert.throws(() => migrated.createChangeSet(local), /CHECK constraint/);
    migrated.createChangeSet({ ...local, targetBranch: "main" });
    const database = new DatabaseSync(path);
    try {
      assert.throws(() => database.exec("UPDATE work_items SET delivery = 'pr' WHERE id = 'local'"), /immutable/);
      assert.throws(() => database.exec("UPDATE work_items SET target_branch = 'other' WHERE id = 'local'"), /immutable/);
    } finally { database.close(); }
  } finally { migrated.close(); }
});

test("v18 migration adds reviewed-dependency metadata and separates pending Decision kinds", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-v19-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const original = new MerroStore(path);
  original.createProject({ slug: "p", path: "/tmp/p", baseRemote: "origin", pushRemote: "origin", defaultBranch: "main" });
  original.createChangeSet({ id: "change", projectSlug: "p", slug: "change", issues: [], generation: 1, state: "Ready", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
  original.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("DROP INDEX decisions_one_pending_per_subject_kind; CREATE UNIQUE INDEX decisions_one_pending_per_subject ON decisions(subject_type, subject_id) WHERE state = 'pending'; ALTER TABLE relations DROP COLUMN consumed_reviewed_commit; ALTER TABLE relations DROP COLUMN gate; ALTER TABLE work_item_runtime DROP COLUMN github_team_review_pending; UPDATE schema_meta SET version = 18;");
  legacy.close();

  const migrated = new MerroStore(path);
  try {
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("SELECT version FROM schema_meta").get()?.version, SCHEMA_VERSION);
      assert.equal(database.prepare("SELECT github_team_review_pending FROM work_item_runtime WHERE work_item_id = 'change'").get()?.github_team_review_pending, 0);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'decisions_one_pending%'").all().map((row) => String(row.name)), [
        "decisions_one_pending_per_subject_kind",
      ]);
    } finally { database.close(); }
    migrated.createDecision({ id: "merge", subjectType: "ChangeSet", subjectId: "change", kind: "merge", payload: {} });
    migrated.createDecision({ id: "team-review", subjectType: "ChangeSet", subjectId: "change", kind: "team_review", payload: {} });
    assert.deepEqual(migrated.pendingDecisions().map((decision) => decision.kind), ["merge", "team_review"]);
  } finally { migrated.close(); }
});

test("store enforces one non-terminal generation per source", () => {
  const store = makeStore();
  try {
    store.createChangeSet({ id: "p:issue-1:g1", projectSlug: "p", slug: "first-change", issues: [{ projectSlug: "p", number: 1 }], generation: 1, state: "Ready", priority: "normal", readySince: "2026-01-01T00:00:00Z", blockedReason: null, blockedResumeState: null });
    assert.throws(() => store.createChangeSet({ id: "p:issue-1:g2", projectSlug: "p", slug: "second-change", issues: [{ projectSlug: "p", number: 1 }], generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null }));
  } finally {
    store.close();
  }
});

test("terminal generation allows a fresh generation", () => {
  const store = makeStore();
  try {
    store.createChangeSet({ id: "p:issue-1:g1", projectSlug: "p", slug: "first-change", issues: [{ projectSlug: "p", number: 1 }], generation: 1, state: "AwaitingMerge", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    store.transitionChangeSet("p:issue-1:g1", "Done");
    store.createChangeSet({ id: "p:issue-1:g2", projectSlug: "p", slug: "second-change", issues: [{ projectSlug: "p", number: 1 }], generation: 2, state: "Planned", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    assert.equal(store.getChangeSet("p:issue-1:g2")?.generation, 2);
  } finally {
    store.close();
  }
});

test("external PR merge completes a blocked ChangeSet regardless of its resume state", () => {
  const store = makeStore();
  try {
    store.createChangeSet({
      id: "blocked-implement",
      projectSlug: "p",
      slug: "blocked-implement",
      issues: [{ projectSlug: "p", number: 8 }],
      generation: 1,
      state: "Implementing",
      priority: "normal",
      readySince: null,
      blockedReason: null,
      blockedResumeState: null,
    });
    store.transitionChangeSet("blocked-implement", "Blocked", "task_failed");

    store.completeChangeSetAfterExternalMerge("blocked-implement");

    assert.equal(store.getChangeSet("blocked-implement")?.state, "Done");
  } finally {
    store.close();
  }
});

test("store enforces one active Task per ChangeSet and immutable finalization", () => {
  const store = makeStore();
  try {
    store.createChangeSet({ id: "w", projectSlug: "p", slug: "work", issues: [], generation: 1, state: "Implementing", priority: "normal", readySince: null, blockedReason: null, blockedResumeState: null });
    store.createTask({ id: "t1", changeSetId: "w", role: "implement", attempt: 1 });
    assert.throws(() => store.createTask({ id: "t2", changeSetId: "w", role: "review", attempt: 1 }));
    assert.throws(() => store.transitionChangeSet("w", "Obsolete"), /active Task/);
    store.finalizeTask({ id: "t1", outcome: "success", summary: "done", resultJson: "{}", commitSha: "abc" });
    assert.equal(store.getTask("t1")?.outcome, "success");
    store.transitionChangeSet("w", "Obsolete");
    assert.throws(() => store.finalizeTask({ id: "t1", outcome: "failed", summary: "changed", resultJson: "{}" }), /already finalized/);
  } finally {
    store.close();
  }
});

test("SQLite trigger protects terminal ChangeSet core fields", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_1);
    db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("p", "/tmp/p", "origin", "origin", "main", "2026-01-01T00:00:00Z");
    db.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("done", "p", "issue", "1", 1, "Done", "normal", null, null, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");

    assert.throws(
      () => db.prepare("UPDATE work_items SET priority = 'high' WHERE id = 'done'").run(),
      /terminal WorkItem core fields are immutable/,
    );
    assert.throws(
      () => db.prepare("UPDATE work_items SET state = 'Ready' WHERE id = 'done'").run(),
      /terminal WorkItem core fields are immutable/,
    );

    assert.doesNotThrow(() => db.prepare("UPDATE work_items SET updated_at = ? WHERE id = 'done'").run("2026-01-02T00:00:00Z"));
  } finally {
    db.close();
  }
});


test("Blocked transition requires a typed reason and resumes only to the previous flow state", () => {
  const store = makeStore();
  try {
    store.createChangeSet({
      id: "blocked",
      projectSlug: "p",
      slug: "blocked",
      issues: [{ projectSlug: "p", number: 2 }],
      generation: 1,
      state: "Ready",
      priority: "normal",
      readySince: "2026-01-01T00:00:00Z",
      blockedReason: null,
      blockedResumeState: null,
    });

    assert.throws(() => store.transitionChangeSet("blocked", "Blocked"), /requires a BlockReason/);

    store.transitionChangeSet("blocked", "Blocked", "task_failed");
    const blocked = store.getChangeSet("blocked");
    assert.equal(blocked?.state, "Blocked");
    assert.equal(blocked?.blockedReason, "task_failed");
    assert.equal(blocked?.blockedResumeState, "Ready");

    assert.throws(
      () => store.transitionChangeSet("blocked", "Reviewing"),
      /invalid ChangeSet transition/,
    );

    store.transitionChangeSet("blocked", "Ready");
    const resumed = store.getChangeSet("blocked");
    assert.equal(resumed?.state, "Ready");
    assert.equal(resumed?.blockedReason, null);
    assert.equal(resumed?.blockedResumeState, null);
    assert.equal(resumed?.readySince, "2026-01-01T00:00:00Z");
  } finally {
    store.close();
  }
});

test("SQLite rejects Blocked ChangeSets without reason and resume state", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MIGRATION_1);
    db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("p", "/tmp/p", "origin", "origin", "main", "2026-01-01T00:00:00Z");
    db.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "ready",
      "p",
      "issue",
      "3",
      1,
      "Ready",
      "normal",
      "2026-01-01T00:00:00Z",
      null,
      null,
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
    );

    assert.throws(
      () => db.prepare("UPDATE work_items SET state = 'Blocked' WHERE id = 'ready'").run(),
    );
    assert.throws(
      () => db.prepare(
        "UPDATE work_items SET state = 'Blocked', blocked_reason = 'not_a_reason', blocked_resume_state = 'Ready' WHERE id = 'ready'",
      ).run(),
    );

    db.prepare(
      "UPDATE work_items SET state = 'Blocked', blocked_reason = 'task_failed', blocked_resume_state = 'Ready' WHERE id = 'ready'",
    ).run();

    assert.throws(
      () => db.prepare(
        "UPDATE work_items SET state = 'Reviewing', blocked_reason = NULL, blocked_resume_state = NULL WHERE id = 'ready'",
      ).run(),
      /must resume previous flow state/,
    );
  } finally {
    db.close();
  }
});

for (const version of [10, 11, 12]) {
  test(`v${version} incomplete persisted Objective scopes recover only attached fixed selections`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "merro-scope-migration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "state.db");
    const legacy = new DatabaseSync(path);
    const approved = [{ projectSlug: "api", query: { labels: ["feature"], milestone: "v1" } }];
    const fixed = [{ projectSlug: "api", numbers: [7] }];
    const complete = [...approved, { projectSlug: "web", numbers: [8] }, { projectSlug: "empty", query: { labels: ["approved"] } }];
    try {
      legacy.exec(migrations.slice(0, version).join("\n"));
      legacy.prepare("INSERT INTO schema_meta VALUES (?)").run(version);
      for (const slug of ["api", "web", "empty"]) {
        legacy.prepare(`INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
          VALUES (?, ?, 'origin', 'origin', 'main', '2026-01-01T00:00:00Z')`).run(slug, `/tmp/${slug}`);
      }
      for (const state of ["Active", "Done", "Stopped"]) {
        legacy.prepare(`INSERT INTO objectives(id, goal, priority, state, created_at, updated_at, issue_scopes_json)
          VALUES (?, 'Ship all features', 'normal', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ?)`)
          .run(state, state, JSON.stringify(state === "Stopped" ? fixed : state === "Done" ? complete : approved));
        for (const slug of ["api", "web", "empty"]) {
          legacy.prepare("INSERT INTO objective_projects VALUES (?, ?)").run(state, slug);
        }
      }
      for (const [id, project, source, reference, generation, state] of [
        ["web9", "web", "issue", "9", 1, "Ready"], ["web8-old", "web", "issue", "8", 1, "Done"],
        ["web8", "web", "issue", "8", 2, "Ready"], ["unattached", "web", "issue", "10", 1, "Ready"],
        ["local", "empty", "local", "note", 1, "Ready"],
      ] as const) {
        legacy.prepare(`INSERT INTO work_items(id, project_slug, source_type, source_ref, generation, state, priority, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
          .run(id, project, source, reference, generation, state);
        if (id === "unattached") continue;
        for (const objective of ["Active", "Stopped"]) {
          legacy.prepare("INSERT INTO objective_work_items(objective_id, work_item_id) VALUES (?, ?)").run(objective, id);
        }
      }
      if (version >= 11) legacy.exec("UPDATE objective_work_items SET in_scope = 0 WHERE work_item_id = 'web9'");
    } finally { legacy.close(); }
    for (let restart = 0; restart < 2; restart++) {
      const store = new MerroStore(path);
      try {
        assert.equal(store.listObjectives().length, 3);
        assert.deepEqual(store.getObjective("Active")?.issueScopes, [...approved, { projectSlug: "empty", numbers: [] }, { projectSlug: "web", numbers: [8, 9] }]);
        assert.deepEqual(store.getObjective("Stopped")?.issueScopes, [...fixed, { projectSlug: "empty", numbers: [] }, { projectSlug: "web", numbers: [8, 9] }]);
        assert.deepEqual(store.getObjective("Done")?.issueScopes, complete);
        assert.equal(store.getObjective("Stopped")?.state, "Stopped");
        assert.equal(store.getObjective("Done")?.state, "Done");
      } finally { store.close(); }
    }
    const database = new DatabaseSync(path);
    try {
      assert.equal(database.prepare("SELECT version FROM schema_meta").get()?.version, SCHEMA_VERSION);
      assert.equal(database.prepare("SELECT issue_scopes_json FROM objectives WHERE id = 'Done'").get()?.issue_scopes_json, JSON.stringify(complete));
      assert.equal(database.prepare("SELECT count(*) AS count FROM event_log WHERE event_type = 'scope_restored'").get()?.count, 2);
    } finally { database.close(); }
  });
}

test("scope recovery and schema version update roll back together on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-scope-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(migrations.join("\n"));
    legacy.exec(`
      INSERT INTO schema_meta VALUES (12);
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES ('p', '/tmp/p', 'origin', 'origin', 'main', '2026-01-01T00:00:00Z');
      INSERT INTO objectives(id, goal, priority, state, created_at, updated_at, issue_scopes_json)
      VALUES ('legacy', 'Ship all features', 'normal', 'Active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '[]');
      INSERT INTO objective_projects VALUES ('legacy', 'p');
      CREATE TRIGGER reject_scope_event BEFORE INSERT ON event_log BEGIN SELECT RAISE(ABORT, 'scope event unavailable'); END;
    `);
    assert.throws(() => new MerroStore(path), /scope event unavailable/);
    assert.equal(legacy.prepare("SELECT version FROM schema_meta").get()?.version, 12);
    assert.equal(legacy.prepare("SELECT issue_scopes_json FROM objectives").get()?.issue_scopes_json, "[]");
    legacy.exec("DROP TRIGGER reject_scope_event");
  } finally { legacy.close(); }
  const recovered = new MerroStore(path);
  try { assert.deepEqual(recovered.getObjective("legacy")?.issueScopes, [{ projectSlug: "p", numbers: [] }]); }
  finally { recovered.close(); }
});

test("v11 finalized Tasks enter cleanup once and retain immutable history across migration and restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-cleanup-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(migrations.slice(0, 11).join("\n"));
    legacy.exec(`
      INSERT INTO schema_meta VALUES (11);
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES ('p', '/tmp/p', 'origin', 'origin', 'main', '2026-01-01T00:00:00Z');
      INSERT INTO work_items(id, project_slug, source_type, source_ref, generation, state, priority, created_at, updated_at)
      VALUES ('legacy', 'p', 'issue', '1', 1, 'Ready', 'normal', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      INSERT INTO tasks(id, work_item_id, role, attempt, status, outcome, started_at, finalized_at, summary, result_json)
      VALUES ('finished', 'legacy', 'implement', 1, 'finalized', 'failed', '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'Original summary', '{}');
      INSERT INTO task_runtime(task_id, tmux_session, tmux_window, clone_path, task_file_path, result_path, started_at, expected_commit)
      VALUES ('finished', 'merro-p', 'impl-legacy', '/tmp/legacy', '/tmp/legacy/.merro-task.md', '/tmp/task/result.json', '2026-01-01T00:00:00Z', 'abc');
    `);
  } finally { legacy.close(); }
  const prepare = DatabaseSync.prototype.prepare;
  let cleanupQuery = "";
  const observed = t.mock.method(DatabaseSync.prototype, "prepare", function(this: DatabaseSync, sql: string) {
    if (sql.includes("cleanup_completed_at IS NULL")) cleanupQuery = sql;
    return prepare.call(this, sql);
  });
  const migrated = new MerroStore(path);
  const history = migrated.getTask("finished");
  try {
    assert.equal(history?.summary, "Original summary");
    assert.equal(migrated.getTaskRuntime("finished")?.cleanupCompletedAt, null);
    assert.deepEqual(migrated.listTasksPendingCleanup().map((task) => task.id), ["finished"]);
  } finally { migrated.close(); }
  const restarted = new MerroStore(path);
  try {
    assert.deepEqual(restarted.listTasksPendingCleanup().map((task) => task.id), ["finished"]);
    restarted.markTaskCleanupCompleted("finished");
    assert.deepEqual(restarted.getTask("finished"), history);
  } finally { restarted.close(); }
  const completed = new MerroStore(path);
  try {
    assert.equal(typeof completed.getTaskRuntime("finished")?.cleanupCompletedAt, "string");
    assert.deepEqual(completed.listTasksPendingCleanup(), []);
    assert.deepEqual(completed.getTask("finished"), history);
  } finally { completed.close(); }
  observed.mock.restore();
  const database = new DatabaseSync(path);
  try {
    assert.throws(() => database.prepare("UPDATE tasks SET summary = 'Changed' WHERE id = 'finished'").run(), /immutable/);
    assert.throws(() => database.prepare("DELETE FROM tasks WHERE id = 'finished'").run(), /immutable/);
    assert.notEqual(cleanupQuery, "");
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${cleanupQuery}`).all();
    assert.ok(plan.some((row) => String(row.detail).includes("task_runtime_pending_cleanup")));
    assert.equal(plan.some((row) => /^SCAN tasks\b/.test(String(row.detail))), false);
  } finally { database.close(); }
});

test("store migrates v1 state without losing ChangeSets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "merro-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "state.db");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(MIGRATION_1);
    legacy.prepare("INSERT INTO schema_meta(version) VALUES (1)").run();
    legacy.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES ('p', '/tmp/p', 'origin', 'origin', 'main', '2026-01-01T00:00:00Z')
    `).run();
    legacy.prepare(`
      INSERT INTO work_items(
        id, project_slug, source_type, source_ref, generation, state, priority,
        ready_since, blocked_reason, blocked_resume_state, created_at, updated_at
      ) VALUES ('legacy', 'p', 'issue', '1', 1, 'Ready', 'normal', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
    `).run();
  } finally {
    legacy.close();
  }

  const store = new MerroStore(path);
  try {
    assert.equal(store.getChangeSet("legacy")?.state, "Ready");
  } finally {
    store.close();
  }

  const migrated = new DatabaseSync(path);
  try {
    assert.equal(Number(migrated.prepare("SELECT version FROM schema_meta").get()?.version), SCHEMA_VERSION);
    assert.doesNotThrow(() => migrated.prepare("SELECT runtime_kind, base_update_json, cleanup_completed_at FROM task_runtime").all());
    assert.doesNotThrow(() => migrated.prepare("SELECT base_update_json FROM work_item_runtime").all());
    assert.doesNotThrow(() => migrated.prepare("SELECT issue_scopes_json FROM objectives").all());
  } finally {
    migrated.close();
  }
});
