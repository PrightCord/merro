import type { Relation, SchedulingInput, ChangeSet } from "./model.js";
import { priorityRank } from "./model.js";
import { effectiveRelations, findRequiresCycle } from "./relations.js";

export interface ScheduleResult {
  selected: ChangeSet[];
  cycle: string[] | null;
}

function transitiveDownstreamCount(id: string, relations: readonly Relation[]): number {
  const reverse = new Map<string, string[]>();
  for (const relation of relations) {
    if (relation.kind !== "Requires") continue;
    const dependents = reverse.get(relation.to) ?? [];
    dependents.push(relation.from);
    reverse.set(relation.to, dependents);
  }

  const seen = new Set<string>();
  const queue = [...(reverse.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    queue.push(...(reverse.get(next) ?? []));
  }
  return seen.size;
}

function requirementsSatisfied(
  item: ChangeSet,
  byId: ReadonlyMap<string, ChangeSet>,
  relations: readonly Relation[],
  reviewedIds: ReadonlySet<string>,
): boolean {
  for (const relation of relations) {
    if (relation.kind !== "Requires" || relation.from !== item.id) continue;
    const prerequisite = byId.get(relation.to);
    if (!prerequisite) return false;
    if ((relation.gate ?? "done") === "reviewed") {
      if (prerequisite.state !== "Done" && !reviewedIds.has(prerequisite.id)) return false;
    } else if (prerequisite.state !== "Done") return false;
  }
  return true;
}

function conflictsWithAny(itemId: string, peerIds: ReadonlySet<string>, relations: readonly Relation[]): boolean {
  for (const relation of relations) {
    if (relation.kind !== "Conflicts") continue;
    const peer = relation.from === itemId ? relation.to : relation.to === itemId ? relation.from : null;
    if (peer && peerIds.has(peer)) return true;
  }
  return false;
}

export function schedule(input: SchedulingInput): ScheduleResult {
  const relations = effectiveRelations(input.relations);
  const cycle = findRequiresCycle(relations);
  const byId = new Map(input.changeSets.map((item) => [item.id, item]));
  const available = input.maxConcurrentTasks === "unlimited"
    ? Number.POSITIVE_INFINITY
    : Math.max(0, input.maxConcurrentTasks - input.activeTaskCount);

  const activeIds = input.activeChangeSetIds
    ? new Set(input.activeChangeSetIds)
    : new Set(input.changeSets.filter((item) => item.state === "Implementing" || item.state === "Reviewing").map((item) => item.id));
  const reviewedIds = new Set(input.reviewedChangeSetIds ?? []);

  const candidates = input.changeSets
    .filter((item) => item.state === "Ready" || item.state === "Implementing" || item.state === "Reviewing")
    .filter((item) => !activeIds.has(item.id))
    .filter((item) => requirementsSatisfied(item, byId, relations, reviewedIds))
    .filter((item) => !conflictsWithAny(item.id, activeIds, relations))
    .sort((left, right) => {
      const priority = priorityRank(left.priority) - priorityRank(right.priority);
      if (priority !== 0) return priority;
      const downstream = transitiveDownstreamCount(right.id, relations) - transitiveDownstreamCount(left.id, relations);
      if (downstream !== 0) return downstream;
      const leftReady = left.readySince ?? "9999";
      const rightReady = right.readySince ?? "9999";
      const ready = leftReady.localeCompare(rightReady);
      if (ready !== 0) return ready;
      return left.id.localeCompare(right.id);
    });

  const selected: ChangeSet[] = [];
  const selectedIds = new Set<string>();
  for (const candidate of candidates) {
    if (selected.length >= available) break;
    if (conflictsWithAny(candidate.id, selectedIds, relations)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }

  return { selected, cycle };
}
