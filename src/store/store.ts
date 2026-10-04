import { DatabaseSync } from "node:sqlite";
import {
  priorityRank,
  type BaseUpdate,
  type BlockReason,
  type Decision,
  type FlowChangeSetState,
  type Objective,
  type ObjectiveIssueScope,
  type Priority,
  type Project,
  type Relation,
  type ReviewRoundLimit,
  type Task,
  type TaskOutcome,
  type TaskRole,
  type ChangeSet,
  type ChangeSetState,
} from "../domain/model.js";
import { parseObjectiveIssueScopes } from "../domain/objective.js";
import { changeName, issueNumbers, semanticSlug } from "../domain/names.js";
import { effectiveRelations, normalizeRelation } from "../domain/relations.js";
import { assertChangeSetTransition } from "../domain/change-set.js";
import type { FinalSummaryRecord, ObjectiveSettingsRecord, ProjectSettingsRecord, TaskRuntimeRecord, ChangeSetRuntimeRecord } from "./model.js";
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10, MIGRATION_11, MIGRATION_12, MIGRATION_16, MIGRATION_17, MIGRATION_19, SCHEMA_VERSION } from "./schema.js";

import { migratePublicationStates } from "./publication-migration.js";
import { migrateLocalMergeState } from "./local-merge-migration.js";

function now(): string {
  return new Date().toISOString();
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    slug: String(row.slug),
    path: String(row.path),
    baseRemote: String(row.base_remote),
    pushRemote: String(row.push_remote),
    defaultBranch: String(row.default_branch),
  };
}

function reviewRoundLimit(value: unknown): ReviewRoundLimit | null {
  if (value === null || value === undefined) return null;
  if (value === "unlimited") return "unlimited";
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`invalid stored review-round limit: ${String(value)}`);
  return limit;
}

function changeSetFromRow(row: Record<string, unknown>): ChangeSet {
  return {
    id: String(row.id),
    projectSlug: String(row.project_slug),
    // Old source columns remain a persisted-state detail, not a domain identity.
    slug: row.slug ? String(row.slug) : row.source_type === "issue" ? `issues-${String(row.source_ref).replace(/,/g, "-")}` : semanticSlug(String(row.source_ref)),
    issues: row.source_type === "issue" ? String(row.source_ref).split(",").map((number) => ({ projectSlug: String(row.project_slug), number: Number(number) })) : [],
    delivery: row.delivery === "local" ? "local" : "pr",
    ...(typeof row.target_branch === "string" ? { targetBranch: row.target_branch } : {}),
    generation: Number(row.generation),
    state: row.state as ChangeSetState,
    priority: row.priority as ChangeSet["priority"],
    readySince: row.ready_since === null ? null : String(row.ready_since),
    blockedReason: row.blocked_reason === null ? null : row.blocked_reason as BlockReason,
    blockedResumeState: row.blocked_resume_state === null ? null : row.blocked_resume_state as FlowChangeSetState,
    guidance: typeof row.guidance === "string" ? row.guidance : "",
  };
}

function taskFromRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    changeSetId: String(row.work_item_id),
    role: row.role as TaskRole,
    attempt: Number(row.attempt),
    status: row.status as Task["status"],
    outcome: row.outcome === null ? null : row.outcome as TaskOutcome,
    startedAt: String(row.started_at),
    finalizedAt: row.finalized_at === null ? null : String(row.finalized_at),
    commitSha: row.commit_sha === null ? null : String(row.commit_sha),
    reviewedCommit: row.reviewed_commit === null ? null : String(row.reviewed_commit),
    summary: row.summary === null ? null : String(row.summary),
    resultJson: row.result_json === null ? null : String(row.result_json),
  };
}

function relationFromRow(row: Record<string, unknown>): Relation {
  return {
    kind: row.kind as Relation["kind"],
    from: String(row.from_work_item_id),
    to: String(row.to_work_item_id),
    confidence: row.confidence as Relation["confidence"],
    rationale: String(row.rationale),
    evidence: String(row.evidence),
  };
}

function decisionFromRow(row: Record<string, unknown>): Decision {
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch (error) {
    throw new Error(`invalid Decision payload for ${String(row.id)}`, { cause: error });
  }
  return {
    id: String(row.id),
    subjectType: String(row.subject_type),
    subjectId: String(row.subject_id),
    kind: String(row.kind),
    state: row.state as Decision["state"],
    payload,
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

export class MerroStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    this.#db = new DatabaseSync(path);
    try {
      this.#migrate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  close(): void {
    this.#db.close();
  }

  #migrate(): void {
    this.#db.exec(MIGRATION_1);
    let row = this.#db.prepare("SELECT version FROM schema_meta LIMIT 1").get();
    if (!row) {
      this.#db.prepare("INSERT INTO schema_meta(version) VALUES (1)").run();
      row = { version: 1 };
    }
    let version = Number(row.version);
    if (!Number.isSafeInteger(version) || version < 1 || version > SCHEMA_VERSION) {
      throw new Error(`unsupported Merro schema version ${String(row.version)}; expected 1-${SCHEMA_VERSION}`);
    }
    if (version < 2) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_2);
        this.#db.prepare("UPDATE schema_meta SET version = 2").run();
        this.#db.exec("COMMIT");
        version = 2;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 3) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_3);
        this.#db.prepare("UPDATE schema_meta SET version = 3").run();
        this.#db.exec("COMMIT");
        version = 3;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 4) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_4);
        this.#db.prepare("UPDATE schema_meta SET version = 4").run();
        this.#db.exec("COMMIT");
        version = 4;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 5) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_5);
        this.#db.prepare("UPDATE schema_meta SET version = 5").run();
        this.#db.exec("COMMIT");
        version = 5;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 6) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_6);
        this.#db.prepare("UPDATE schema_meta SET version = 6").run();
        this.#db.exec("COMMIT");
        version = 6;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 7) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_7);
        this.#db.prepare("UPDATE schema_meta SET version = 7").run();
        this.#db.exec("COMMIT");
        version = 7;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 8) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_8);
        this.#db.prepare("UPDATE schema_meta SET version = 8").run();
        this.#db.exec("COMMIT");
        version = 8;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 9) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_9);
        this.#db.prepare("UPDATE schema_meta SET version = 9").run();
        this.#db.exec("COMMIT");
        version = 9;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 10) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_10);
        this.#db.prepare("UPDATE schema_meta SET version = 10").run();
        this.#db.exec("COMMIT");
        version = 10;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 11) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_11);
        this.#db.prepare("UPDATE schema_meta SET version = 11").run();
        this.#db.exec("COMMIT");
        version = 11;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 12) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_12);
        this.#db.prepare("UPDATE schema_meta SET version = 12").run();
        this.#db.exec("COMMIT");
        version = 12;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 13) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        // v10-v12 could persist scopes for only some linked Projects. Preserve approved
        // scopes and recover missing selections from attached issues, never from the goal.
        for (const objective of this.#db.prepare("SELECT id, issue_scopes_json FROM objectives WHERE issue_scopes_json IS NOT NULL").all()) {
          const scopes: unknown = JSON.parse(String(objective.issue_scopes_json));
          if (!Array.isArray(scopes)) throw new Error("Objective issue scopes must be an array");
          const projects = this.#db.prepare("SELECT project_slug FROM objective_projects WHERE objective_id = ? ORDER BY project_slug")
            .all(String(objective.id)).map((row) => String(row.project_slug));
          let changed = false;
          for (const projectSlug of projects) {
            if (scopes.some((scope: unknown) => typeof scope === "object" && scope !== null
              && "projectSlug" in scope && scope.projectSlug === projectSlug)) continue;
            const numbers = this.#db.prepare(`
              SELECT w.source_ref FROM work_items w
              JOIN objective_work_items ow ON ow.work_item_id = w.id
              WHERE ow.objective_id = ? AND w.project_slug = ? AND w.source_type = 'issue'
            `).all(String(objective.id), projectSlug).map((row) => Number(row.source_ref));
            scopes.push({ projectSlug, numbers });
            changed = true;
          }
          const normalized = parseObjectiveIssueScopes(scopes, projects, { allowEmptyFixedSelections: true });
          if (changed) {
            this.#db.prepare("UPDATE objectives SET issue_scopes_json = ? WHERE id = ?").run(JSON.stringify(normalized), String(objective.id));
            this.appendEvent("Objective", String(objective.id), "scope_restored", normalized);
          }
        }
        this.#db.prepare("UPDATE schema_meta SET version = 13").run();
        this.#db.exec("COMMIT");
        version = 13;
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
    if (version < 14) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec("ALTER TABLE work_items ADD COLUMN slug TEXT; ALTER TABLE task_runtime ADD COLUMN window_id TEXT");
        const used = new Set<string>();
        for (const row of this.#db.prepare("SELECT * FROM work_items ORDER BY created_at, id").all()) {
          const name = changeName(changeSetFromRow(row));
          let slug = name;
          for (let suffix = 2; used.has(slug); suffix++) slug = `${name.slice(0, 63 - String(suffix).length)}-${suffix}`;
          used.add(slug);
          this.#db.prepare("UPDATE work_items SET slug = ? WHERE id = ?").run(slug, String(row.id));
        }
        this.#db.exec("CREATE UNIQUE INDEX change_sets_unique_slug ON work_items(slug)");
        this.#db.exec(`CREATE TRIGGER change_set_slug_immutable BEFORE UPDATE OF slug ON work_items
          WHEN OLD.slug IS NOT NULL AND NEW.slug IS NOT OLD.slug BEGIN
          SELECT RAISE(ABORT, 'ChangeSet name is immutable'); END;`);
        this.#db.exec(`CREATE TRIGGER change_set_sources_exclusive BEFORE INSERT ON work_items
          WHEN NEW.source_type = 'issue' AND NEW.state NOT IN ('Done', 'Obsolete', 'Cancelled') BEGIN
          SELECT RAISE(ABORT, 'An issue already belongs to an active ChangeSet') WHERE EXISTS (
            SELECT 1 FROM work_items w, json_each(CASE WHEN w.source_type = 'issue' THEN '[' || w.source_ref || ']' ELSE '[]' END) existing,
              json_each('[' || NEW.source_ref || ']') incoming
            WHERE w.project_slug = NEW.project_slug AND w.source_type = 'issue'
              AND w.state NOT IN ('Done', 'Obsolete', 'Cancelled') AND existing.value = incoming.value
          ); END;`);
        this.#db.prepare("UPDATE schema_meta SET version = 14").run();
        this.#db.exec("COMMIT");
        version = 14;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    if (version < 15) {
      migratePublicationStates(this.#db);
      version = 15;
    }
    if (version < 16) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_16);
        this.#db.prepare("UPDATE schema_meta SET version = 16").run();
        this.#db.exec("COMMIT");
        version = 16;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    if (version < 17) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_17);
        this.#db.prepare("UPDATE schema_meta SET version = 17").run();
        this.#db.exec("COMMIT");
        version = 17;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    if (version < 18) {
      migrateLocalMergeState(this.#db);
      version = 18;
    }
    if (version < 19) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#db.exec(MIGRATION_19);
        this.#db.prepare("UPDATE schema_meta SET version = 19").run();
        this.#db.exec("COMMIT");
        version = 19;
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(`unsupported Merro schema version ${version}; expected ${SCHEMA_VERSION}`);
    }
  }

  createProject(project: Project): void {
    this.#db.prepare(`
      INSERT INTO projects(slug, path, base_remote, push_remote, default_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(project.slug, project.path, project.baseRemote, project.pushRemote, project.defaultBranch, now());
    this.appendEvent("Project", project.slug, "created", project);
  }

  getProject(slug: string): Project | null {
    const row = this.#db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);
    return row ? projectFromRow(row) : null;
  }

  updateProject(project: Project): void {
    const current = this.getProject(project.slug);
    if (!current) throw new Error(`unknown Project: ${project.slug}`);
    if (current.path === project.path && current.baseRemote === project.baseRemote
      && current.pushRemote === project.pushRemote && current.defaultBranch === project.defaultBranch) return;
    this.#db.prepare(`
      UPDATE projects
      SET path = ?, base_remote = ?, push_remote = ?, default_branch = ?
      WHERE slug = ?
    `).run(project.path, project.baseRemote, project.pushRemote, project.defaultBranch, project.slug);
    this.appendEvent("Project", project.slug, "reconciled", { from: current, to: project });
  }

  listProjects(): Project[] {
    return this.#db.prepare("SELECT * FROM projects ORDER BY slug").all().map(projectFromRow);
  }

  saveProjectSettings(slug: string, settings: ProjectSettingsRecord): void {
    this.#db.prepare(`
      INSERT INTO project_settings(project_slug, guidance, image, setup_command, sandbox, network, worker_github)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_slug) DO UPDATE SET
        guidance = excluded.guidance,
        image = excluded.image,
        setup_command = excluded.setup_command,
        sandbox = excluded.sandbox,
        network = excluded.network,
        worker_github = excluded.worker_github
    `).run(
      slug,
      settings.guidance,
      settings.image,
      settings.setupCommand,
      settings.sandbox,
      settings.network,
      settings.workerGithub === null ? null : Number(settings.workerGithub),
    );
    this.appendEvent("Project", slug, "settings_changed", settings);
  }

  getProjectSettings(slug: string): ProjectSettingsRecord | null {
    const row = this.#db.prepare("SELECT * FROM project_settings WHERE project_slug = ?").get(slug);
    if (!row) return null;
    return {
      guidance: String(row.guidance),
      image: row.image === null ? null : String(row.image),
      setupCommand: row.setup_command === null ? null : String(row.setup_command),
      sandbox: row.sandbox === null ? null : row.sandbox as ProjectSettingsRecord["sandbox"],
      network: row.network === null ? null : row.network as ProjectSettingsRecord["network"],
      workerGithub: row.worker_github === null ? null : Number(row.worker_github) === 1,
    };
  }

  createObjective(objective: Objective): void {
    if (objective.projectSlugs.length === 0) throw new Error("Objective requires at least one Project");
    const timestamp = now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO objectives(id, goal, priority, state, created_at, updated_at, issue_scopes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(objective.id, objective.goal, objective.priority, objective.state, timestamp, timestamp,
        objective.issueScopes === undefined ? null : JSON.stringify(parseObjectiveIssueScopes(objective.issueScopes, objective.projectSlugs, { allowEmptyFixedSelections: true })));
      const attach = this.#db.prepare("INSERT INTO objective_projects(objective_id, project_slug) VALUES (?, ?)");
      for (const slug of [...new Set(objective.projectSlugs)]) attach.run(objective.id, slug);
      if (objective.maxReviewRounds !== undefined && objective.maxReviewRounds !== null) {
        this.#db.prepare("INSERT INTO objective_settings(objective_id, max_review_rounds) VALUES (?, ?)")
          .run(objective.id, String(objective.maxReviewRounds));
      }
      this.appendEvent("Objective", objective.id, "created", objective);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  restoreObjectiveIssueScopes(id: string, scopes: ObjectiveIssueScope[]): void {
    const objective = this.getObjective(id);
    if (!objective) throw new Error(`unknown Objective: ${id}`);
    if (objective.issueScopes !== undefined) throw new Error("Objective already has approved issue scopes");
    const normalized = parseObjectiveIssueScopes(scopes, objective.projectSlugs, { allowEmptyFixedSelections: true });
    this.#db.prepare("UPDATE objectives SET issue_scopes_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(normalized), now(), id);
    this.appendEvent("Objective", id, "scope_restored", normalized);
  }

  getObjective(id: string): Objective | null {
    const row = this.#db.prepare(`
      SELECT o.*, s.max_review_rounds
      FROM objectives o LEFT JOIN objective_settings s ON s.objective_id = o.id
      WHERE o.id = ?
    `).get(id);
    return row ? this.#objectiveFromRow(row) : null;
  }

  listObjectives(): Objective[] {
    return this.#db.prepare(`
      SELECT o.*, s.max_review_rounds
      FROM objectives o LEFT JOIN objective_settings s ON s.objective_id = o.id
      ORDER BY o.created_at, o.id
    `).all().map((row) => this.#objectiveFromRow(row));
  }

  saveObjectiveSettings(id: string, settings: ObjectiveSettingsRecord): void {
    this.#db.prepare(`
      INSERT INTO objective_settings(objective_id, max_review_rounds) VALUES (?, ?)
      ON CONFLICT(objective_id) DO UPDATE SET max_review_rounds = excluded.max_review_rounds
    `).run(id, settings.maxReviewRounds === null ? null : String(settings.maxReviewRounds));
    this.appendEvent("Objective", id, "settings_changed", settings);
  }

  setObjectiveState(id: string, state: Objective["state"]): void {
    const row = this.#db.prepare("SELECT state FROM objectives WHERE id = ?").get(id);
    if (!row) throw new Error(`unknown Objective: ${id}`);
    const from = row.state as Objective["state"];
    this.#db.prepare("UPDATE objectives SET state = ?, updated_at = ? WHERE id = ?").run(state, now(), id);
    this.appendEvent("Objective", id, "state_changed", { from, to: state });
  }

  replaceRelations(relations: readonly Relation[]): void {
    const effective = effectiveRelations(relations.map(normalizeRelation));
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("UPDATE relations SET active = 0 WHERE active = 1").run();
      const upsert = this.#db.prepare(`
        INSERT INTO relations(kind, from_work_item_id, to_work_item_id, confidence, rationale, evidence, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(kind, from_work_item_id, to_work_item_id) DO UPDATE SET
          confidence = excluded.confidence,
          rationale = excluded.rationale,
          evidence = excluded.evidence,
          automatic = 0,
          active = 1
      `);
      for (const relation of effective) {
        upsert.run(relation.kind, relation.from, relation.to, relation.confidence, relation.rationale, relation.evidence, now());
      }
      this.appendEvent("Relations", "workspace", "replaced", effective);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #relationRebuild(analyzedIds: readonly string[], relations: readonly Relation[], occupiedChangeSetIds: readonly string[]) {
    const analyzed = new Set(analyzedIds);
    const occupied = new Set([...occupiedChangeSetIds,
      ...this.#db.prepare("SELECT work_item_id FROM tasks WHERE status = 'active'").all().map((row) => String(row.work_item_id))]);
    const deactivateIds: number[] = [];
    const surviving = new Map<string, { relation: Relation; automatic: boolean }>();
    const key = (relation: Relation) => `${relation.kind}\0${relation.from}\0${relation.to}`;
    const rows = this.#db.prepare("SELECT * FROM relations ORDER BY id").all();
    const order = new Map(rows.map((row, index) => [key(relationFromRow(row)), index]));
    for (const row of rows) {
      if (Number(row.active) !== 1) continue;
      const relation = relationFromRow(row);
      const automatic = Number(row.automatic) === 1;
      // Either endpoint may supply a symmetric relation. Preserve it until both are checked and idle.
      const remove = automatic && (relation.kind === "Requires" ? analyzed.has(relation.from)
        : analyzed.has(relation.from) && analyzed.has(relation.to) && !occupied.has(relation.from) && !occupied.has(relation.to));
      if (remove) deactivateIds.push(Number(row.id));
      else surviving.set(key(relation), { relation, automatic });
    }
    for (const relation of relations.map(normalizeRelation)) {
      if (surviving.get(key(relation))?.automatic === false) continue;
      surviving.set(key(relation), { relation, automatic: true });
    }
    const projected = [...surviving.values()].map((entry) => entry.relation)
      .sort((left, right) => (order.get(key(left)) ?? rows.length) - (order.get(key(right)) ?? rows.length));
    return { deactivateIds, relations: effectiveRelations(projected) };
  }

  previewAutomaticRelations(analyzedIds: readonly string[], relations: readonly Relation[]): Relation[] {
    return this.#relationRebuild(analyzedIds, relations, []).relations;
  }

  rebuildAutomaticRelations(
    analyzedIds: readonly string[],
    relations: readonly Relation[],
    occupiedChangeSetIds: readonly string[] = [],
    explicitRelations: readonly Relation[] = [],
  ): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const rebuild = this.#relationRebuild(analyzedIds, relations, occupiedChangeSetIds);
      const deactivate = this.#db.prepare("UPDATE relations SET active = 0 WHERE id = ?");
      for (const id of rebuild.deactivateIds) deactivate.run(id);
      const upsert = this.#db.prepare(`
        INSERT INTO relations(kind, from_work_item_id, to_work_item_id, confidence, rationale, evidence, active, automatic, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)
        ON CONFLICT(kind, from_work_item_id, to_work_item_id) DO UPDATE SET
          confidence = excluded.confidence, rationale = excluded.rationale, evidence = excluded.evidence, active = 1, automatic = 1
        WHERE relations.automatic = 1 OR relations.active = 0
      `);
      for (const relation of relations.map(normalizeRelation)) {
        upsert.run(relation.kind, relation.from, relation.to, relation.confidence, relation.rationale, relation.evidence, now());
      }
      const explicitUpsert = this.#db.prepare(`
        INSERT INTO relations(kind, from_work_item_id, to_work_item_id, confidence, rationale, evidence, active, automatic, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)
        ON CONFLICT(kind, from_work_item_id, to_work_item_id) DO UPDATE SET
          confidence = excluded.confidence, rationale = excluded.rationale, evidence = excluded.evidence, active = 1, automatic = 0
      `);
      for (const relation of explicitRelations.map(normalizeRelation)) {
        explicitUpsert.run(relation.kind, relation.from, relation.to, relation.confidence, relation.rationale, relation.evidence, now());
      }
      const rebuilt = this.listRelations();
      const previous = this.#db.prepare("SELECT payload_json FROM event_log WHERE entity_type = 'Relations' AND event_type = 'rebuilt' ORDER BY id DESC LIMIT 1").get();
      if (previous?.payload_json !== JSON.stringify(rebuilt)) this.appendEvent("Relations", "workspace", "rebuilt", rebuilt);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  listRelations(includeInactive = false): Relation[] {
    const where = includeInactive ? "" : "WHERE active = 1";
    const relations = this.#db.prepare(`SELECT * FROM relations ${where} ORDER BY id`).all().map(relationFromRow);
    return includeInactive ? relations : effectiveRelations(relations);
  }

  createDecision(input: Omit<Decision, "createdAt" | "resolvedAt" | "state"> & { state?: Decision["state"] }): Decision {
    const decision: Decision = {
      ...input,
      state: input.state ?? "pending",
      createdAt: now(),
      resolvedAt: null,
    };
    this.#db.prepare(`
      INSERT INTO decisions(id, subject_type, subject_id, kind, state, payload_json, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.subjectType,
      decision.subjectId,
      decision.kind,
      decision.state,
      JSON.stringify(decision.payload),
      decision.createdAt,
      decision.resolvedAt,
    );
    this.appendEvent("Decision", decision.id, "created", decision);
    return decision;
  }

  getDecision(id: string): Decision | null {
    const row = this.#db.prepare("SELECT * FROM decisions WHERE id = ?").get(id);
    return row ? decisionFromRow(row) : null;
  }

  pendingDecisions(): Decision[] {
    return this.#db.prepare("SELECT * FROM decisions WHERE state = 'pending' ORDER BY created_at, id")
      .all().map(decisionFromRow);
  }

  changeSetDecisions(changeSetId: string): Decision[] {
    return this.#db.prepare("SELECT * FROM decisions WHERE subject_type = 'ChangeSet' AND subject_id = ? ORDER BY created_at, id")
      .all(changeSetId).map(decisionFromRow);
  }

  resolveDecision(id: string, state: Exclude<Decision["state"], "pending">): void {
    const decision = this.getDecision(id);
    if (!decision) throw new Error(`unknown Decision: ${id}`);
    if (decision.state !== "pending") throw new Error(`Decision already resolved: ${id}`);
    const resolvedAt = now();
    this.#db.prepare("UPDATE decisions SET state = ?, resolved_at = ? WHERE id = ?").run(state, resolvedAt, id);
    this.appendEvent("Decision", id, "resolved", { state, resolvedAt });
  }

  getChangeSetRuntime(changeSetId: string): ChangeSetRuntimeRecord | null {
    const row = this.#db.prepare("SELECT * FROM work_item_runtime WHERE work_item_id = ?").get(changeSetId);
    if (!row) return null;
    return {
      changeSetId,
      branchName: row.branch_name === null ? null : String(row.branch_name),
      clonePath: row.clone_path === null ? null : String(row.clone_path),
      baseCommit: row.base_commit === null ? null : String(row.base_commit),
      ...(row.base_update_json === null ? {} : { baseUpdate: JSON.parse(String(row.base_update_json)) as BaseUpdate }),
      pullRequestNumber: row.pull_request_number === null ? null : Number(row.pull_request_number),
      pullRequestUrl: row.pull_request_url === null ? null : String(row.pull_request_url),
      pullRequestState: row.pull_request_state === null ? null : String(row.pull_request_state),
      githubChecks: row.github_checks as Exclude<ChangeSetRuntimeRecord["githubChecks"], undefined>,
      githubChecksAt: row.github_checks_at === null ? null : String(row.github_checks_at),
      githubReviewDecision: row.github_review_decision === null ? null : String(row.github_review_decision),
      pullRequestHeadSha: row.pull_request_head_sha === null ? null : String(row.pull_request_head_sha),
      pullRequestBaseSha: row.pull_request_base_sha === null ? null : String(row.pull_request_base_sha),
      mergedCommitSha: row.merged_commit_sha === null ? null : String(row.merged_commit_sha),
      lastIssueState: row.last_issue_state === null ? null : String(row.last_issue_state),
      reviewedDiffHash: row.reviewed_diff_hash === null ? null : String(row.reviewed_diff_hash),
      reviewRound: Number(row.review_round),
      infrastructureRetries: Number(row.infrastructure_retries),
      implementationAttempt: Number(row.implementation_attempt),
      lastReworkTrigger: row.last_rework_trigger === null ? null : String(row.last_rework_trigger),
      lastReconciledAt: row.last_reconciled_at === null ? null : String(row.last_reconciled_at),
    };
  }

  saveChangeSetRuntime(record: ChangeSetRuntimeRecord): void {
    this.#db.prepare(`
      INSERT INTO work_item_runtime(
        work_item_id, branch_name, clone_path, base_commit, pull_request_number, pull_request_url,
        pull_request_state, pull_request_head_sha, pull_request_base_sha, merged_commit_sha, last_issue_state,
        reviewed_diff_hash, review_round, infrastructure_retries, implementation_attempt, last_reconciled_at,
        last_rework_trigger, base_update_json, github_checks, github_checks_at, github_review_decision
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET
        branch_name = excluded.branch_name, clone_path = excluded.clone_path, base_commit = excluded.base_commit,
        pull_request_number = excluded.pull_request_number, pull_request_url = excluded.pull_request_url,
        pull_request_state = excluded.pull_request_state, pull_request_head_sha = excluded.pull_request_head_sha,
        pull_request_base_sha = excluded.pull_request_base_sha, merged_commit_sha = excluded.merged_commit_sha,
        last_issue_state = excluded.last_issue_state, reviewed_diff_hash = excluded.reviewed_diff_hash,
        review_round = excluded.review_round, infrastructure_retries = excluded.infrastructure_retries,
        implementation_attempt = excluded.implementation_attempt, last_reconciled_at = excluded.last_reconciled_at,
        last_rework_trigger = excluded.last_rework_trigger, base_update_json = excluded.base_update_json,
        github_checks = excluded.github_checks, github_checks_at = excluded.github_checks_at,
        github_review_decision = excluded.github_review_decision
    `).run(
      record.changeSetId, record.branchName, record.clonePath, record.baseCommit, record.pullRequestNumber,
      record.pullRequestUrl, record.pullRequestState, record.pullRequestHeadSha, record.pullRequestBaseSha,
      record.mergedCommitSha, record.lastIssueState, record.reviewedDiffHash, record.reviewRound,
      record.infrastructureRetries, record.implementationAttempt, record.lastReconciledAt, record.lastReworkTrigger,
      record.baseUpdate ? JSON.stringify(record.baseUpdate) : null, record.githubChecks ?? null,
      record.githubChecksAt ?? null, record.githubReviewDecision ?? null,
    );
  }

  markPullRequestRework(runtime: ChangeSetRuntimeRecord): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getChangeSet(runtime.changeSetId);
      if (!item || item.state !== "AwaitingMerge") {
        throw new Error(`ChangeSet ${runtime.changeSetId} is not AwaitingMerge`);
      }
      this.saveChangeSetRuntime(runtime);
      this.transitionChangeSet(item.id, "Implementing");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getTaskRuntime(taskId: string): TaskRuntimeRecord | null {
    const row = this.#db.prepare("SELECT * FROM task_runtime WHERE task_id = ?").get(taskId);
    if (!row) return null;
    return {
      taskId,
      runtimeKind: row.runtime_kind === "docker" || row.runtime_kind === "host" ? row.runtime_kind : null,
      tmuxSession: String(row.tmux_session),
      tmuxWindow: String(row.tmux_window),
      paneId: row.pane_id === null ? null : String(row.pane_id),
      windowId: row.window_id === null ? null : String(row.window_id),
      containerId: row.container_id === null ? null : String(row.container_id),
      processPid: row.process_pid === null ? null : Number(row.process_pid),
      processStartedAt: row.process_started_at === null ? null : String(row.process_started_at),
      clonePath: String(row.clone_path),
      taskFilePath: String(row.task_file_path),
      resultPath: String(row.result_path),
      expectedCommit: String(row.expected_commit),
      ...(row.base_update_json === null ? {} : { baseUpdate: JSON.parse(String(row.base_update_json)) as BaseUpdate }),
      startedAt: String(row.started_at),
      cleanupCompletedAt: row.cleanup_completed_at === null ? null : String(row.cleanup_completed_at),
    };
  }

  saveTaskRuntime(record: TaskRuntimeRecord): void {
    this.#db.prepare(`
      INSERT INTO task_runtime(task_id, tmux_session, tmux_window, pane_id, container_id, process_pid, process_started_at, clone_path, task_file_path, result_path, expected_commit, started_at, runtime_kind, base_update_json, window_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        tmux_session = excluded.tmux_session, tmux_window = excluded.tmux_window, pane_id = excluded.pane_id,
        container_id = excluded.container_id, process_pid = excluded.process_pid, process_started_at = excluded.process_started_at,
        clone_path = excluded.clone_path, task_file_path = excluded.task_file_path,
        result_path = excluded.result_path, expected_commit = excluded.expected_commit, started_at = excluded.started_at,
        runtime_kind = excluded.runtime_kind, base_update_json = excluded.base_update_json, window_id = excluded.window_id
    `).run(record.taskId, record.tmuxSession, record.tmuxWindow, record.paneId, record.containerId,
      record.processPid, record.processStartedAt, record.clonePath, record.taskFilePath, record.resultPath, record.expectedCommit, record.startedAt, record.runtimeKind, record.baseUpdate ? JSON.stringify(record.baseUpdate) : null, record.windowId ?? null);
  }

  #objectiveFromRow(row: Record<string, unknown>): Objective {
    const id = String(row.id);
    const projectSlugs = this.#db.prepare(`
      SELECT project_slug FROM objective_projects WHERE objective_id = ? ORDER BY project_slug
    `).all(id).map((link) => String(link.project_slug));
    return {
      id,
      goal: String(row.goal),
      priority: row.priority as Objective["priority"],
      state: row.state as Objective["state"],
      projectSlugs,
      maxReviewRounds: reviewRoundLimit(row.max_review_rounds),
      ...(row.issue_scopes_json === null ? {} : { issueScopes: parseObjectiveIssueScopes(JSON.parse(String(row.issue_scopes_json)), projectSlugs, { allowEmptyFixedSelections: true }) }),
    };
  }

  createChangeSet(item: ChangeSet): void {
    semanticSlug(item.slug);
    if (item.state === "AwaitingLocalMerge" && item.delivery !== "local") {
      throw new Error("AwaitingLocalMerge requires local delivery");
    }
    if (item.issues.some((issue) => issue.projectSlug !== item.projectSlug || !Number.isSafeInteger(issue.number) || issue.number < 1)
      || new Set(issueNumbers(item)).size !== item.issues.length) throw new Error("ChangeSet sources must be distinct positive issue numbers in its Project.");
    const hasBlockedMetadata = item.blockedReason !== null || item.blockedResumeState !== null;
    if (item.state === "Blocked" || item.state === "PublishBlocked") {
      if (item.blockedReason === null || item.blockedResumeState === null) {
        throw new Error("Blocked ChangeSet requires BlockReason and resume state");
      }
    } else if (hasBlockedMetadata) {
      throw new Error("non-Blocked ChangeSet cannot carry Blocked metadata");
    }

    const timestamp = now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO work_items(
          id, project_slug, source_type, source_ref, generation, state, priority,
          ready_since, blocked_reason, blocked_resume_state, created_at, updated_at, slug, delivery, target_branch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id, item.projectSlug, item.issues.length ? "issue" : "local", item.issues.length ? issueNumbers(item).sort((a, b) => a - b).join(",") : item.slug, item.generation, item.state,
        item.priority, item.readySince, item.blockedReason, item.blockedResumeState, timestamp, timestamp,
        this.availableChangeName(changeName(item)), item.delivery ?? "pr", item.targetBranch ?? null,
      );
      this.#db.prepare("INSERT INTO work_item_settings(work_item_id, guidance) VALUES (?, ?)")
        .run(item.id, item.guidance ?? "");
      this.#db.prepare("INSERT INTO work_item_runtime(work_item_id) VALUES (?)").run(item.id);
      this.appendEvent("ChangeSet", item.id, "created", item);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  availableChangeName(name: string, reserved: ReadonlySet<string> = new Set()): string {
    const base = semanticSlug(name);
    let slug = base;
    for (let suffix = 2; reserved.has(slug) || this.#db.prepare("SELECT 1 FROM work_items WHERE slug = ?").get(slug); suffix++) {
      slug = `${base.slice(0, 63 - String(suffix).length)}-${suffix}`;
    }
    return slug;
  }

  findNonTerminalChangeSet(projectSlug: string, numbers: readonly number[]): ChangeSet | null {
    const row = this.#db.prepare(`
      SELECT w.*, s.guidance FROM work_items w
      LEFT JOIN work_item_settings s ON s.work_item_id = w.id
      WHERE w.project_slug = ? AND w.source_type = ? AND w.source_ref = ?
        AND w.state NOT IN ('Done', 'Obsolete', 'Cancelled')
      ORDER BY w.generation DESC LIMIT 1
    `).get(projectSlug, "issue", [...numbers].sort((a, b) => a - b).join(","));
    return row ? changeSetFromRow(row) : null;
  }

  setChangeSetPriority(id: string, priority: ChangeSet["priority"]): void {
    const item = this.getChangeSet(id);
    if (!item) throw new Error(`unknown ChangeSet: ${id}`);
    if (item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") return;
    this.#db.prepare("UPDATE work_items SET priority = ?, updated_at = ? WHERE id = ?").run(priority, now(), id);
    this.appendEvent("ChangeSet", id, "priority_changed", { from: item.priority, to: priority });
  }

  nextGeneration(projectSlug: string, numbers: readonly number[]): number {
    const row = this.#db.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS generation FROM work_items
      WHERE project_slug = ? AND source_type = ? AND source_ref = ?
    `).get(projectSlug, "issue", [...numbers].sort((a, b) => a - b).join(","));
    return Number(row?.generation ?? 0) + 1;
  }

  listChangeSets(objectiveId?: string, inScopeOnly = false): ChangeSet[] {
    const rows = objectiveId === undefined
      ? this.#db.prepare(`
          SELECT w.*, s.guidance FROM work_items w
          LEFT JOIN work_item_settings s ON s.work_item_id = w.id
          ORDER BY w.created_at, w.id
        `).all()
      : this.#db.prepare(`
          SELECT w.*, s.guidance FROM work_items w
          LEFT JOIN work_item_settings s ON s.work_item_id = w.id
          JOIN objective_work_items ow ON ow.work_item_id = w.id
          WHERE ow.objective_id = ? ${inScopeOnly ? "AND ow.in_scope = 1" : ""} ORDER BY w.created_at, w.id
        `).all(objectiveId);
    return rows.map(changeSetFromRow);
  }

  saveChangeSetGuidance(id: string, guidance: string): void {
    this.#db.prepare(`
      INSERT INTO work_item_settings(work_item_id, guidance) VALUES (?, ?)
      ON CONFLICT(work_item_id) DO UPDATE SET guidance = excluded.guidance
    `).run(id, guidance);
    this.appendEvent("ChangeSet", id, "guidance_changed", { guidance });
  }

  attachChangeSet(objectiveId: string, changeSetId: string): void {
    const result = this.#db.prepare(`
      INSERT INTO objective_work_items(objective_id, work_item_id)
      VALUES (?, ?)
      ON CONFLICT(objective_id, work_item_id) DO UPDATE SET in_scope = 1 WHERE in_scope = 0
    `).run(objectiveId, changeSetId);
    if (Number(result.changes) > 0) {
      this.appendEvent("ChangeSet", changeSetId, "attached_to_objective", { objectiveId });
    }
  }

  detachChangeSet(objectiveId: string, changeSetId: string): void {
    // Retain the attachment until the current Task finishes, but stop counting it as ownership immediately.
    const result = this.activeTask(changeSetId)
      ? this.#db.prepare("UPDATE objective_work_items SET in_scope = 0 WHERE objective_id = ? AND work_item_id = ? AND in_scope = 1").run(objectiveId, changeSetId)
      : this.#db.prepare("DELETE FROM objective_work_items WHERE objective_id = ? AND work_item_id = ?").run(objectiveId, changeSetId);
    if (Number(result.changes) === 0) return;
    this.appendEvent("ChangeSet", changeSetId, "detached_from_objective", { objectiveId, deferred: this.activeTask(changeSetId) !== null });
    const item = this.getChangeSet(changeSetId);
    if (!item || item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") return;
    const priorities = this.#db.prepare(`
      SELECT o.priority FROM objectives o JOIN objective_work_items ow ON ow.objective_id = o.id
      WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1
    `).all(changeSetId).map((row) => row.priority as Priority);
    const highest = priorities.sort((left, right) => priorityRank(left) - priorityRank(right))[0];
    if (highest && highest !== item.priority) this.setChangeSetPriority(changeSetId, highest);
  }

  settleScopeDetachments(): void {
    this.#db.prepare(`DELETE FROM objective_work_items WHERE in_scope = 0 AND NOT EXISTS (
      SELECT 1 FROM tasks WHERE tasks.work_item_id = objective_work_items.work_item_id AND tasks.status = 'active'
    )`).run();
  }

  hasActiveObjectiveForChangeSet(changeSetId: string): boolean {
    return this.#db.prepare(`
      SELECT 1 FROM objective_work_items ow JOIN objectives o ON o.id = ow.objective_id
      WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1 LIMIT 1
    `).get(changeSetId) !== undefined;
  }

  getChangeSet(id: string): ChangeSet | null {
    const row = this.#db.prepare(`
      SELECT w.*, s.guidance FROM work_items w
      LEFT JOIN work_item_settings s ON s.work_item_id = w.id
      WHERE w.id = ?
    `).get(id);
    return row ? changeSetFromRow(row) : null;
  }

  getFinalSummary(changeSetId: string): FinalSummaryRecord | null {
    const row = this.#db.prepare("SELECT * FROM final_summaries WHERE work_item_id = ?").get(changeSetId);
    if (!row) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch (error) {
      throw new Error(`invalid final summary for ChangeSet ${changeSetId}`, { cause: error });
    }
    return { changeSetId, payload, createdAt: String(row.created_at) };
  }

  listFinalSummaries(): FinalSummaryRecord[] {
    return this.#db.prepare("SELECT * FROM final_summaries ORDER BY created_at, work_item_id").all()
      .map((row) => {
        const changeSetId = String(row.work_item_id);
        const summary = this.getFinalSummary(changeSetId);
        if (!summary) throw new Error(`missing final summary for ChangeSet ${changeSetId}`);
        return summary;
      });
  }

  completeLocalChangeSet(id: string, commit: string): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getChangeSet(id);
      const review = this.listTasks(id).at(-1);
      if (item?.delivery !== "local" || item.state !== "AwaitingLocalMerge" || this.activeTask(id)
        || review?.role !== "review" || review.outcome !== "pass" || review.reviewedCommit !== commit) {
        throw new Error("Local completion requires the latest passing review and no active Task");
      }
      const runtime = this.getChangeSetRuntime(id);
      if (!runtime) throw new Error("Local completion requires working-copy metadata");
      const approval = this.#db.prepare(`SELECT payload_json FROM decisions
        WHERE subject_type = 'ChangeSet' AND subject_id = ? AND kind = 'local_merge' AND state = 'approved'
        ORDER BY resolved_at DESC, created_at DESC LIMIT 1`).get(id);
      const approvalPayload = approval ? JSON.parse(String(approval.payload_json)) as Record<string, unknown> : null;
      if (!approvalPayload || approvalPayload.reviewedCommit !== commit || approvalPayload.baseCommit !== runtime.baseCommit
        || approvalPayload.targetBranch !== item.targetBranch) {
        throw new Error("Local completion requires approval for the reviewed commit and current target base");
      }
      this.saveChangeSetRuntime({ ...runtime, mergedCommitSha: commit });
      this.transitionChangeSet(id, "Done");
      this.#db.prepare("INSERT INTO final_summaries(work_item_id, payload_json, created_at) VALUES (?, ?, ?)")
        .run(id, JSON.stringify({ change: item.slug, delivery: "local", branch: item.targetBranch, baseCommit: runtime.baseCommit, commit }), now());
      this.appendEvent("ChangeSet", id, "final_summary_written", { createdAt: now() });
      this.appendEvent("ChangeSet", id, "completed", { reason: "local_delivery", commit });
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  completeChangeSetAfterMerge(id: string, payload: unknown): boolean {
    const serialized = JSON.stringify(payload);
    if (serialized === undefined) throw new Error("final summary must be JSON serializable");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const item = this.getChangeSet(id);
      if (!item) throw new Error(`unknown ChangeSet: ${id}`);
      const existing = this.getFinalSummary(id);
      if (existing) {
        if (item.state !== "Done") throw new Error(`ChangeSet ${id} has a final summary but is not Done`);
        this.#db.exec("COMMIT");
        return false;
      }
      if (item.state !== "AwaitingMerge" && item.state !== "Blocked" && item.state !== "PublishBlocked" && item.state !== "Publishing" && item.state !== "Done") {
        throw new Error(`ChangeSet ${id} is not awaiting a pull request merge`);
      }
      if (this.activeTask(id)) throw new Error(`ChangeSet ${id} still has an active Task`);
      const createdAt = now();
      this.#db.prepare("INSERT INTO final_summaries(work_item_id, payload_json, created_at) VALUES (?, ?, ?)")
        .run(id, serialized, createdAt);
      if (item.state !== "Done") {
        this.#db.prepare(`
          UPDATE work_items
          SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
          WHERE id = ?
        `).run(createdAt, id);
        this.appendEvent("ChangeSet", id, "state_changed", {
          from: item.state,
          to: "Done",
          reason: "pull_request_merged",
          blockedReason: null,
          blockedResumeState: null,
        });
      }
      this.appendEvent("ChangeSet", id, "final_summary_written", { createdAt });
      this.#db.exec("COMMIT");
      return true;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  completeChangeSetAfterExternalMerge(id: string): void {
    const item = this.getChangeSet(id);
    if (!item) throw new Error(`unknown ChangeSet: ${id}`);
    if (item.state !== "AwaitingMerge" && item.state !== "Blocked" && item.state !== "PublishBlocked" && item.state !== "Publishing") {
      throw new Error(`ChangeSet ${id} is not awaiting an external pull request merge`);
    }
    if (this.activeTask(id)) throw new Error(`ChangeSet ${id} still has an active Task`);
    this.#db.prepare(`
      UPDATE work_items
      SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    this.appendEvent("ChangeSet", id, "state_changed", {
      from: item.state,
      to: "Done",
      reason: "pull_request_merged_externally",
      blockedReason: null,
      blockedResumeState: null,
    });
  }

  completeChangeSetAfterExternalIssueClosure(id: string): void {
    const item = this.getChangeSet(id);
    if (!item) throw new Error(`unknown ChangeSet: ${id}`);
    if (item.state === "Done") return;
    if (item.state === "Obsolete" || item.state === "Cancelled") return;
    if (this.activeTask(id)) throw new Error(`ChangeSet ${id} still has an active Task`);
    this.#db.prepare(`
      UPDATE work_items
      SET state = 'Done', blocked_reason = NULL, blocked_resume_state = NULL, updated_at = ?
      WHERE id = ?
    `).run(now(), id);
    this.appendEvent("ChangeSet", id, "state_changed", {
      from: item.state,
      to: "Done",
      reason: "issue_closed_externally",
      blockedReason: null,
      blockedResumeState: null,
    });
  }

  transitionChangeSet(id: string, to: ChangeSetState, blockedReason: BlockReason | null = null): void {
    const item = this.getChangeSet(id);
    if (!item) throw new Error(`unknown ChangeSet: ${id}`);

    const blocking = to === "Blocked" || to === "PublishBlocked";
    if (blocking && blockedReason === null) {
      throw new Error("Blocked ChangeSet requires a BlockReason");
    }
    if (!blocking && blockedReason !== null) {
      throw new Error("BlockReason is only valid when entering or updating Blocked");
    }

    assertChangeSetTransition(item.state, to, item.blockedResumeState, item.delivery ?? "pr");
    if (to === "Obsolete" && this.activeTask(id)) {
      throw new Error(`cannot obsolete ChangeSet with an active Task: ${id}`);
    }

    let nextBlockedReason: BlockReason | null = null;
    let nextBlockedResumeState: FlowChangeSetState | null = null;
    if (blocking) {
      nextBlockedReason = blockedReason;
      nextBlockedResumeState = item.state === "Blocked" || item.state === "PublishBlocked"
        ? item.blockedResumeState
        : item.state as FlowChangeSetState;
      if (nextBlockedResumeState === null) {
        throw new Error("Blocked ChangeSet requires a resume state");
      }
    }

    const readySince = to === "Ready" && item.state !== "Ready" && item.state !== "Blocked"
      ? now()
      : item.readySince;
    this.#db.prepare(`
      UPDATE work_items
      SET state = ?, ready_since = ?, blocked_reason = ?, blocked_resume_state = ?, updated_at = ?
      WHERE id = ?
    `).run(to, readySince, nextBlockedReason, nextBlockedResumeState, now(), id);
    this.appendEvent("ChangeSet", id, "state_changed", {
      from: item.state,
      to,
      blockedReason: nextBlockedReason,
      blockedResumeState: nextBlockedResumeState,
    });
  }

  createTask(input: { id: string; changeSetId: string; role: TaskRole; attempt: number; runtime?: TaskRuntimeRecord }): void {
    if (input.runtime && input.runtime.taskId !== input.id) {
      throw new Error("Task runtime identity does not match Task ID");
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO tasks(id, work_item_id, role, attempt, status, started_at)
        VALUES (?, ?, ?, ?, 'active', ?)
      `).run(input.id, input.changeSetId, input.role, input.attempt, now());
      if (input.runtime) this.saveTaskRuntime(input.runtime);
      this.appendEvent("Task", input.id, "created", { ...input, runtime: undefined });
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finalizeTask(input: {
    id: string;
    outcome: TaskOutcome;
    summary: string;
    resultJson: string;
    commitSha?: string | null;
    reviewedCommit?: string | null;
  }): void {
    const row = this.#db.prepare("SELECT role, status FROM tasks WHERE id = ?").get(input.id);
    if (!row) throw new Error(`unknown Task: ${input.id}`);
    if (row.status !== "active") throw new Error(`Task already finalized: ${input.id}`);
    const role = String(row.role);
    const allowed = role === "implement"
      ? new Set<TaskOutcome>(["success", "failed", "cancelled"])
      : new Set<TaskOutcome>(["pass", "reject", "failed", "cancelled"]);
    if (!allowed.has(input.outcome)) throw new Error(`invalid ${role} Task outcome: ${input.outcome}`);

    this.#db.prepare(`
      UPDATE tasks
      SET status = 'finalized', outcome = ?, finalized_at = ?, commit_sha = ?, reviewed_commit = ?, summary = ?, result_json = ?
      WHERE id = ?
    `).run(
      input.outcome,
      now(),
      input.commitSha ?? null,
      input.reviewedCommit ?? null,
      input.summary,
      input.resultJson,
      input.id,
    );
    this.appendEvent("Task", input.id, "finalized", input);
  }

  finalizePassingReview(input: { id: string; summary: string; resultJson: string; reviewedCommit: string }): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const task = this.getTask(input.id);
      if (!task || task.role !== "review") throw new Error("Passing review requires a review Task");
      this.finalizeTask({ ...input, outcome: "pass" });
      this.transitionChangeSet(task.changeSetId, "Reviewed");
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  getTask(id: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? taskFromRow(row) : null;
  }

  listTasks(changeSetId?: string): Task[] {
    const rows = changeSetId === undefined
      ? this.#db.prepare("SELECT * FROM tasks ORDER BY started_at, id").all()
      : this.#db.prepare("SELECT * FROM tasks WHERE work_item_id = ? ORDER BY started_at, id").all(changeSetId);
    return rows.map(taskFromRow);
  }

  listActiveTaskInputPaths(): string[] {
    return this.#db.prepare(`
      SELECT task_runtime.task_file_path FROM tasks
      JOIN task_runtime ON task_runtime.task_id = tasks.id
      WHERE tasks.status = 'active'
    `).all().map((row) => String(row.task_file_path));
  }

  listTasksPendingCleanup(): Task[] {
    // Otherwise SQLite can choose a full scan of immutable Task history.
    return this.#db.prepare(`
      SELECT tasks.* FROM task_runtime INDEXED BY task_runtime_pending_cleanup
      JOIN tasks ON tasks.id = task_runtime.task_id
      WHERE task_runtime.cleanup_completed_at IS NULL AND tasks.status = 'finalized'
      ORDER BY tasks.started_at, tasks.id
    `).all().map(taskFromRow);
  }

  markTaskCleanupCompleted(taskId: string): void {
    const updated = this.#db.prepare(`
      UPDATE task_runtime SET cleanup_completed_at = COALESCE(cleanup_completed_at, ?)
      WHERE task_id = ? AND EXISTS (
        SELECT 1 FROM tasks WHERE tasks.id = task_runtime.task_id AND tasks.status = 'finalized'
      )
    `).run(now(), taskId);
    if (updated.changes !== 1) throw new Error(`cleanup completion requires a finalized Task with runtime: ${taskId}`);
  }

  activeTask(changeSetId: string): Task | null {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE work_item_id = ? AND status = 'active'").get(changeSetId);
    return row ? taskFromRow(row) : null;
  }

  statusSummary(): { projects: number; objectives: number; changeSets: number; activeTasks: number; blockedChangeSets: number } {
    const count = (table: string, where = "") => {
      const row = this.#db.prepare(`SELECT COUNT(*) AS count FROM ${table} ${where}`).get();
      return Number(row?.count ?? 0);
    };
    return {
      projects: count("projects"),
      objectives: count("objectives", "WHERE state = 'Active'"),
      changeSets: count("work_items", "WHERE state NOT IN ('Done','Obsolete','Cancelled')"),
      activeTasks: count("tasks", "WHERE status = 'active'"),
      blockedChangeSets: count("work_items", "WHERE state IN ('Blocked', 'PublishBlocked')"),
    };
  }

  snapshot(): Record<string, Array<Record<string, unknown>>> {
    const tables = [
      "projects", "project_settings", "objectives", "objective_projects", "objective_settings",
      "work_items", "work_item_settings", "work_item_runtime", "objective_work_items",
      "relations", "tasks", "task_runtime", "decisions", "event_log",
    ];
    return Object.fromEntries(tables.map((table) => [table, this.#db.prepare(`SELECT * FROM ${table}`).all()]));
  }

  stopActiveObjectives(objectiveId?: string): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const requested = objectiveId === undefined ? null : this.getObjective(objectiveId);
      if (objectiveId !== undefined && !requested) throw new Error(`unknown Objective: ${objectiveId}`);
      const objectives = requested
        ? requested.state === "Active" ? [requested] : []
        : this.listObjectives().filter((objective) => objective.state === "Active");
      const affectedChangeSetIds = new Set(objectives.flatMap((objective) =>
        this.listChangeSets(objective.id).map((item) => item.id),
      ));
      for (const objective of objectives) this.setObjectiveState(objective.id, "Stopped");

      for (const changeSetId of affectedChangeSetIds) {
        const item = this.getChangeSet(changeSetId);
        if (!item || item.state === "Done" || item.state === "Obsolete" || item.state === "Cancelled") continue;
        if (this.hasActiveObjectiveForChangeSet(item.id)) {
          const priorities = this.#db.prepare(`
            SELECT o.priority FROM objectives o
            JOIN objective_work_items ow ON ow.objective_id = o.id
            WHERE ow.work_item_id = ? AND o.state = 'Active' AND ow.in_scope = 1
          `).all(item.id).map((row) => row.priority as Priority);
          const highest = priorities.sort((left, right) => priorityRank(left) - priorityRank(right))[0];
          if (highest && highest !== item.priority) this.setChangeSetPriority(item.id, highest);
          continue;
        }
        if (this.activeTask(item.id)) continue;
        this.transitionChangeSet(item.id, "Obsolete");
        for (const decision of this.pendingDecisions()) {
          if ((decision.kind === "merge" || decision.kind === "merge_conflict" || decision.kind === "local_merge") && decision.subjectId === item.id) {
            this.resolveDecision(decision.id, "resolved");
          }
        }
      }
      this.#db.exec("COMMIT");
      return objectives.length;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  hasEvent(entityType: string, entityId: string, eventType: string): boolean {
    return Boolean(this.#db.prepare("SELECT 1 FROM event_log WHERE entity_type = ? AND entity_id = ? AND event_type = ? LIMIT 1").get(entityType, entityId, eventType));
  }

  latestBlock(entityId: string): { reason: string; detail: string; retryable: boolean | null } | null {
    const row = this.#db.prepare(`
      SELECT payload_json FROM event_log
      WHERE entity_type = 'ChangeSet' AND entity_id = ? AND event_type = 'blocked'
      ORDER BY id DESC LIMIT 1
    `).get(entityId);
    if (typeof row?.payload_json !== "string") return null;
    try {
      const payload: unknown = JSON.parse(row.payload_json);
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
      const data = payload as Record<string, unknown>;
      if (typeof data.reason !== "string" || typeof data.detail !== "string") return null;
      return { reason: data.reason, detail: data.detail, retryable: typeof data.retryable === "boolean" ? data.retryable : null };
    } catch {
      return null;
    }
  }

  appendEvent(entityType: string, entityId: string, eventType: string, payload: unknown): void {
    this.#db.prepare(`
      INSERT INTO event_log(entity_type, entity_id, event_type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(entityType, entityId, eventType, JSON.stringify(payload), now());
  }
}
