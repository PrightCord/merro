export type DeliveryMode = "local" | "pr";
export type Priority = "high" | "normal" | "low";
export type ObjectiveState = "Active" | "Done" | "Stopped";
export type FlowChangeSetState = "Planned" | "Ready" | "Implementing" | "Reviewing" | "Reviewed" | "AwaitingLocalMerge" | "Publishing" | "AwaitingMerge";
export type ChangeSetState =
  | FlowChangeSetState
  | "Blocked"
  | "PublishBlocked"
  | "Done"
  | "Obsolete"
  | "Cancelled";
export type BlockReason =
  | "review_cap"
  | "cycle"
  | "task_failed"
  | "clone_lost"
  | "policy_unknown"
  | "github_unavailable"
  | "structural_rejected"
  | "merge_rejected"
  | "merge_failed"
  | "pr_closed"
  | "remote_branch_deleted"
  | "project_unavailable"
  | "publication_failed";
export type TaskRole = "implement" | "review";
export type TaskOutcome = "success" | "failed" | "cancelled" | "pass" | "reject";
export type RelationKind = "Requires" | "Conflicts";
export type RelationConfidence = "explicit" | "high";
export type RequiresGate = "reviewed" | "done";
export type ReviewRoundLimit = number | "unlimited";
export type DecisionState = "pending" | "approved" | "rejected" | "resolved";

export interface Project {
  slug: string;
  path: string;
  baseRemote: string;
  pushRemote: string;
  defaultBranch: string;
}

export interface IssueQuery {
  labels?: readonly string[];
  milestone?: string;
}

export type ObjectiveIssueScope =
  | { projectSlug: string; numbers: number[] }
  | { projectSlug: string; query: IssueQuery };

export interface BaseUpdate {
  baseRefName: string;
  baseCommit: string;
}

export interface Objective {
  id: string;
  goal: string;
  priority: Priority;
  state: ObjectiveState;
  projectSlugs: string[];
  maxReviewRounds?: ReviewRoundLimit | null;
  issueScopes?: ObjectiveIssueScope[];
}

export interface SourceRef {
  projectSlug: string;
  number: number;
}

export interface ChangeSet {
  id: string;
  slug: string;
  projectSlug: string;
  delivery?: DeliveryMode;
  targetBranch?: string;
  issues: SourceRef[];
  generation: number;
  state: ChangeSetState;
  priority: Priority;
  readySince: string | null;
  blockedReason: BlockReason | null;
  blockedResumeState: FlowChangeSetState | null;
  guidance?: string;
}

export interface Task {
  id: string;
  changeSetId: string;
  role: TaskRole;
  attempt: number;
  status: "active" | "finalized";
  outcome: TaskOutcome | null;
  startedAt: string;
  finalizedAt: string | null;
  commitSha: string | null;
  reviewedCommit: string | null;
  summary: string | null;
  resultJson: string | null;
}

export interface Decision {
  id: string;
  subjectType: string;
  subjectId: string;
  kind: string;
  state: DecisionState;
  payload: unknown;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Relation {
  kind: RelationKind;
  from: string;
  to: string;
  confidence: RelationConfidence;
  rationale: string;
  evidence: string;
  gate?: RequiresGate;
  consumedReviewedCommit?: string | null;
}

export interface SchedulingInput {
  changeSets: readonly ChangeSet[];
  relations: readonly Relation[];
  reviewedChangeSetIds?: readonly string[];
  activeTaskCount: number;
  maxConcurrentTasks: number | "unlimited";
  activeChangeSetIds?: readonly string[];
}

export const FLOW_CHANGE_SET_STATES = new Set<FlowChangeSetState>([
  "Planned",
  "Ready",
  "Implementing",
  "Reviewing",
  "Reviewed",
  "AwaitingLocalMerge",
  "Publishing",
  "AwaitingMerge",
]);

export const TERMINAL_CHANGE_SET_STATES = new Set<ChangeSetState>([
  "Done",
  "Obsolete",
  "Cancelled",
]);

export function priorityRank(priority: Priority): number {
  return priority === "high" ? 0 : priority === "normal" ? 1 : 2;
}
