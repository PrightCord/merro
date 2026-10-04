import { CommandError, systemCommandRunner, type CommandOptions, type CommandRunner } from "../runtime/commands.js";
import type { IssueQuery, Project } from "../domain/model.js";
import { matchesIssueQuery } from "../domain/objective.js";

export interface GitHubRepository {
  nameWithOwner: string;
  url: string;
  sshUrl: string;
  defaultBranch: string;
}

export function supportsPullRequestRemote(reference: string): boolean {
  const validPath = (owner: string | undefined, repository: string | undefined): boolean => {
    const name = repository?.replace(/\.git$/i, "");
    return Boolean(owner && name && /^[a-z0-9_.-]+$/i.test(owner) && /^[a-z0-9_.-]+$/i.test(name));
  };
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(reference);
  if (scp) return validPath(scp[1], scp[2]);
  try {
    const url = new URL(reference);
    if (!new Set(["http:", "https:", "ssh:", "git:"]).has(url.protocol)
      || url.hostname.toLowerCase() !== "github.com" || url.search || url.hash) return false;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 && validPath(parts[0], parts[1]);
  } catch {
    return false;
  }
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
  updatedAt: string;
  milestone?: string | null;
}

export interface GitHubReview {
  id: string | null;
  author: string;
  state: string;
  submittedAt: string | null;
  commitId: string | null;
}

export interface GitHubCheck {
  name: string;
  state: string;
  conclusion: string | null;
  detailsUrl: string | null;
}

export interface RequiredTeamReviewRequirement {
  teamId: number;
  minimumApprovals: number;
  filePatterns: string[];
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  isDraft: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: string;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  authorLogin: string | null;
  reviewDecision: string | null;
  reviews: GitHubReview[];
  checks: GitHubCheck[];
  changedFiles?: string[];
}

export interface BranchProtection {
  known: true;
  requiredStatusChecks: string[];
  requiredApprovingReviewCount: number;
  requireCodeOwnerReviews: boolean;
  dismissStaleApprovals: boolean;
  requiredTeamReviews: RequiredTeamReviewRequirement[];
}

export interface UnknownBranchProtection {
  known: false;
  reason: string;
  retryable: boolean;
}

export type BranchPolicy = BranchProtection | UnknownBranchProtection;

function parseJson(text: string, context: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON`, { cause: error });
  }
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} returned an unexpected JSON value`);
  }
  return value as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`${context} is missing string field ${key}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function statusCheckNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const checks = value as Record<string, unknown>;
  return [
    ...stringArray(checks.contexts),
    ...(Array.isArray(checks.checks)
      ? checks.checks.flatMap((check) => {
        if (typeof check !== "object" || check === null) return [];
        const row = check as Record<string, unknown>;
        const name = typeof row.context === "string" ? row.context : row.name;
        return typeof name === "string" ? [name] : [];
      })
      : []),
  ];
}

function hasPinnedCheckIdentity(value: unknown, field: "app_id" | "integration_id"): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((check) => {
    if (typeof check !== "object" || check === null) return false;
    const identity = (check as Record<string, unknown>)[field];
    return identity !== undefined && identity !== null;
  });
}

function ruleParameterEnabled(parameters: Record<string, unknown>, name: string): boolean {
  const value = parameters[name];
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error(`ruleset pull_request has invalid ${name} parameter`);
  return value;
}

function rejectUnknownRuleParameters(parameters: Record<string, unknown>, supported: ReadonlySet<string>): void {
  const unsupported = Object.keys(parameters).find((name) => !supported.has(name));
  if (unsupported) throw new Error(`ruleset contains unsupported merge requirement '${unsupported}'`);
}

function isNotFound(error: unknown): boolean {
  const text = error instanceof CommandError ? `${error.message} ${error.stderr}` : String(error);
  return /\b404\b/i.test(text);
}

function parseRepository(value: unknown): GitHubRepository {
  const row = object(value, "gh repo view");
  const branch = object(row.defaultBranchRef, "gh repo view.defaultBranchRef");
  return {
    nameWithOwner: stringField(row, "nameWithOwner", "gh repo view"),
    url: stringField(row, "url", "gh repo view"),
    sshUrl: stringField(row, "sshUrl", "gh repo view"),
    defaultBranch: stringField(branch, "name", "gh repo view.defaultBranchRef"),
  };
}

function parseIssue(value: unknown): GitHubIssue {
  const row = object(value, "gh issue list item");
  if (!Number.isSafeInteger(row.number) || Number(row.number) < 1) throw new Error("GitHub issue has an invalid number");
  if (!Array.isArray(row.labels)) throw new Error("GitHub issue has invalid labels");
  if (!("milestone" in row)) throw new Error("GitHub issue is missing milestone information");
  const state = stringField(row, "state", "GitHub issue").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED") throw new Error(`GitHub issue has unsupported state '${state}'`);
  const labels = row.labels.map((label) => stringField(object(label, "GitHub issue label"), "name", "GitHub issue label"));
  return {
    number: typeof row.number === "number" ? row.number : Number.NaN,
    title: stringField(row, "title", "gh issue list item"),
    body: typeof row.body === "string" ? row.body : "",
    url: stringField(row, "url", "gh issue list item"),
    state,
    labels,
    updatedAt: stringField(row, "updatedAt", "gh issue list item"),
    milestone: row.milestone === null ? null
      : stringField(object(row.milestone, "GitHub issue milestone"), "title", "GitHub issue milestone"),
  };
}

function parseReview(value: unknown): GitHubReview {
  const row = object(value, "gh pr view review");
  const author = typeof row.author === "object" && row.author !== null
    ? nullableString((row.author as Record<string, unknown>).login)
    : null;
  const commitId = typeof row.commit === "object" && row.commit !== null
    ? nullableString((row.commit as Record<string, unknown>).oid)
    : nullableString(row.commit);
  return {
    id: typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : null,
    author: author ?? "",
    state: typeof row.state === "string" ? row.state : "",
    submittedAt: nullableString(row.submittedAt),
    commitId,
  };
}

function parseCheck(value: unknown): GitHubCheck {
  const row = object(value, "gh pr view statusCheckRollup item");
  return {
    name: typeof row.name === "string" ? row.name : typeof row.context === "string" ? row.context : "",
    state: typeof row.state === "string" ? row.state : typeof row.status === "string" ? row.status : "",
    conclusion: nullableString(row.conclusion),
    detailsUrl: nullableString(row.detailsUrl),
  };
}

function parsePullRequest(value: unknown): GitHubPullRequest {
  const row = object(value, "gh pr view");
  const reviews = Array.isArray(row.reviews) ? row.reviews.map(parseReview) : [];
  const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup.map(parseCheck) : [];
  return {
    number: typeof row.number === "number" ? row.number : Number.NaN,
    title: typeof row.title === "string" ? row.title : "",
    body: typeof row.body === "string" ? row.body : "",
    url: stringField(row, "url", "gh pr view"),
    state: typeof row.state === "string" ? row.state : "",
    isDraft: row.isDraft === true,
    mergedAt: nullableString(row.mergedAt),
    mergeCommitSha: typeof row.mergeCommit === "object" && row.mergeCommit !== null
      ? nullableString((row.mergeCommit as Record<string, unknown>).oid)
      : null,
    mergeable: typeof row.mergeable === "string" ? row.mergeable : "UNKNOWN",
    headRefName: typeof row.headRefName === "string" ? row.headRefName : "",
    baseRefName: typeof row.baseRefName === "string" ? row.baseRefName : "",
    headRefOid: typeof row.headRefOid === "string" ? row.headRefOid : "",
    baseRefOid: typeof row.baseRefOid === "string" ? row.baseRefOid : "",
    authorLogin: typeof row.author === "object" && row.author !== null
      ? nullableString((row.author as Record<string, unknown>).login)
      : null,
    reviewDecision: nullableString(row.reviewDecision),
    reviews,
    checks,
    ...(Array.isArray(row.files) ? { changedFiles: row.files.flatMap((file) => {
      if (typeof file !== "object" || file === null || typeof (file as Record<string, unknown>).path !== "string") return [];
      return [(file as Record<string, unknown>).path as string];
    }) } : {}),
  };
}

export class GitHubMergeError extends Error {
  constructor(readonly kind: "unavailable" | "rejected", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitHubMergeError";
  }
}

type RetryDecision<T> = { type: "retry" } | { type: "fail" } | { type: "done"; value: T };

export function isTransientGitHubFailure(error: unknown): boolean {
  const code = error instanceof CommandError ? error.causeCode : null;
  if (code && /^(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED)$/.test(code)) return true;
  const message = error instanceof CommandError ? `${error.stderr} ${error.message}` : error instanceof Error ? error.message : String(error);
  return /\b(?:ECONNRESET|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|ECONNABORTED)\b/.test(message)
    || /(?:HTTP|status|response(?: code)?)[^\n]*\b(?:408|429|500|502|503|504)\b/i.test(message)
    || /API rate limit exceeded|secondary rate limit|GitHub server error|error connecting to api\.github\.com\b/i.test(message)
    || /TLS handshake timeout|dial tcp[^\n]*(?:i\/o timeout|connection (?:reset|refused))|read tcp[^\n]*(?:i\/o timeout|connection reset)|unexpected EOF|connection reset by peer|net\/http: request canceled[^\n]*timeout/i.test(message);
}

function isGitHubAvailabilityFailure(error: unknown): boolean {
  const message = error instanceof CommandError
    ? `${error.message} ${error.stderr} ${error.causeCode ?? ""}`
    : error instanceof Error ? error.message : String(error);
  return isTransientGitHubFailure(error)
    || /\bENOENT\b|\b401\b|rate limit|timed? ?out|network|connection (?:reset|refused|closed)|could not resolve|failed to connect|not logged in|authentication token/i.test(message);
}

export class GitHubClient {
  readonly #commands: CommandRunner;
  readonly #repositoryCache = new Map<string, Promise<GitHubRepository>>();
  readonly #reviewerPermissionCache = new Map<string, { expiresAt: number; result: Promise<boolean> }>();

  constructor(commands: CommandRunner = systemCommandRunner) {
    this.#commands = commands;
  }

  beginPass(): void {
    this.#repositoryCache.clear();
  }

  async #retry<T>(
    operation: () => Promise<T>,
    afterTransientFailure?: (error: unknown) => Promise<RetryDecision<T>>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= 2 || !isTransientGitHubFailure(error)) throw error;
        const backoff = 250 * 2 ** attempt + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        if (afterTransientFailure) {
          let decision: RetryDecision<T>;
          try {
            decision = await afterTransientFailure(error);
          } catch {
            decision = { type: "fail" };
          }
          if (decision.type === "done") return decision.value;
          if (decision.type === "fail") throw error;
        }
      }
    }
  }

  async #read(args: readonly string[], options?: CommandOptions) {
    return this.#retry(() => this.#commands.run("gh", args, options));
  }

  async repository(reference: string): Promise<GitHubRepository> {
    let pending = this.#repositoryCache.get(reference);
    if (!pending) {
      pending = this.#read([
        "repo", "view", reference,
        "--json", "nameWithOwner,url,sshUrl,defaultBranchRef",
      ]).then((result) => parseRepository(parseJson(result.stdout, "gh repo view")));
      this.#repositoryCache.set(reference, pending);
    }
    try {
      return await pending;
    } catch (error) {
      if (this.#repositoryCache.get(reference) === pending) this.#repositoryCache.delete(reference);
      throw error;
    }
  }

  async repositoryInDirectory(path: string): Promise<GitHubRepository> {
    const result = await this.#read([
      "repo", "view", "--json", "nameWithOwner,url,sshUrl,defaultBranchRef",
    ], { cwd: path });
    return parseRepository(parseJson(result.stdout, "gh repo view"));
  }

  async listOpenIssues(project: Project, query: IssueQuery = {}): Promise<GitHubIssue[]> {
    const repository = await this.repository(project.baseRemote);
    const result = await this.#read([
      "api", "--paginate", "--slurp", `repos/${repository.nameWithOwner}/issues?state=open&per_page=100`,
    ], { cwd: project.path });
    const pages = parseJson(result.stdout, "gh api issues");
    if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) throw new Error("gh api issues returned invalid pages");
    const issues = new Map<number, GitHubIssue>();
    for (const value of pages.flat()) {
      const row = object(value, "gh api issue");
      if (row.pull_request !== undefined) continue;
      const issue = parseIssue({ ...row, url: row.html_url, updatedAt: row.updated_at, state: stringField(row, "state", "gh api issue").toUpperCase() });
      if (issue.state === "OPEN" && matchesIssueQuery(query, issue)) issues.set(issue.number, issue);
    }
    return [...issues.values()].sort((a, b) => a.number - b.number);
  }

  async issue(project: Project, number: number): Promise<GitHubIssue> {
    const [issue] = await this.issues(project, [number]);
    if (!issue) throw new Error(`GitHub issue #${number} was not returned`);
    return issue;
  }

  async issues(project: Project, numbers: readonly number[]): Promise<GitHubIssue[]> {
    const unique = [...new Set(numbers)];
    if (unique.some((number) => !Number.isSafeInteger(number) || number < 1)) throw new Error("GitHub issue numbers must be positive integers");
    if (unique.length === 0) return [];
    const repository = await this.repository(project.baseRemote);
    const [owner, name, ...extra] = repository.nameWithOwner.split("/");
    if (!owner || !name || extra.length) throw new Error(`invalid GitHub repository identity: ${repository.nameWithOwner}`);
    const issues = new Map<number, GitHubIssue>();
    for (let offset = 0; offset < unique.length; offset += 50) {
      const batch = unique.slice(offset, offset + 50);
      const variables = batch.map((_, index) => `$number_${index}: Int!`).join(", ");
      const fields = batch.map((_, index) => `issue_${index}: issue(number: $number_${index}) { number title body url state updatedAt labels(first: 100) { nodes { name } } milestone { title } }`).join(" ");
      const query = `query($owner: String!, $name: String!, ${variables}) { repository(owner: $owner, name: $name) { ${fields} } }`;
      const args = ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`];
      batch.forEach((number, index) => {
        args.push("-F", `number_${index}=${number}`);
      });
      const result = await this.#read(args, { cwd: project.path });
      const response = object(parseJson(result.stdout, "gh api graphql issues"), "gh api graphql issues");
      if (Array.isArray(response.errors) && response.errors.length) {
        const message = response.errors.map((error) => typeof error === "object" && error !== null
          && typeof (error as Record<string, unknown>).message === "string" ? (error as Record<string, unknown>).message : "GraphQL query failed").join("; ");
        throw new Error(`gh api graphql issues: ${message}`);
      }
      const data = object(response.data, "gh api graphql issues.data");
      const row = object(data.repository, "gh api graphql issues.repository");
      batch.forEach((number, index) => {
        const value = row[`issue_${index}`];
        if (value === null || value === undefined) throw new Error(`GitHub issue #${number} was not found`);
        const issue = object(value, "gh api graphql issue");
        const labels = object(issue.labels, "gh api graphql issue.labels");
        const normalized = { ...issue, labels: labels.nodes, milestone: issue.milestone };
        issues.set(number, parseIssue(normalized));
      });
    }
    return unique.map((number) => {
      const issue = issues.get(number);
      if (!issue) throw new Error(`GitHub issue #${number} was not returned`);
      return issue;
    });
  }

  async findPullRequest(project: Project, branchName: string): Promise<GitHubPullRequest | null> {
    const base = await this.repository(project.baseRemote);
    const head = await this.repository(project.pushRemote);
    const owner = head.nameWithOwner.split("/")[0];
    if (!owner) throw new Error(`cannot determine GitHub head owner for ${head.nameWithOwner}`);
    const result = await this.#read([
      "pr", "list", "--repo", base.nameWithOwner, "--state", "all",
      "--head", `${owner}:${branchName}`,
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,author,reviewDecision,reviews,statusCheckRollup,files",
      "--limit", "100",
    ], { cwd: project.path });
    const value = parseJson(result.stdout, "gh pr list");
    if (!Array.isArray(value)) throw new Error("gh pr list returned a non-array value");
    const pullRequest = value.map(parsePullRequest).find((candidate) => candidate.headRefName === branchName);
    return pullRequest ?? null;
  }

  async pullRequest(project: Project, number: number): Promise<GitHubPullRequest> {
    const repository = await this.repository(project.baseRemote);
    const result = await this.#read([
      "pr", "view", String(number), "--repo", repository.nameWithOwner,
      "--json", "number,title,body,url,state,isDraft,mergedAt,mergeCommit,mergeable,headRefName,baseRefName,headRefOid,baseRefOid,author,reviewDecision,reviews,statusCheckRollup,files",
    ], { cwd: project.path });
    return parsePullRequest(parseJson(result.stdout, "gh pr view"));
  }

  async syncPullRequestContent(
    project: Project,
    pullRequest: GitHubPullRequest,
    body: string,
    reviewNotes: string,
  ): Promise<void> {
    const repository = await this.repository(project.baseRemote);
    if (pullRequest.body !== body) {
      await this.#retry(() => this.#commands.run("gh", [
        "pr", "edit", String(pullRequest.number), "--repo", repository.nameWithOwner, "--body", body,
      ], { cwd: project.path }));
    }

    const endpoint = `repos/${repository.nameWithOwner}/issues/${pullRequest.number}/comments`;
    const listed = await this.#read([
      "api", endpoint, "--paginate", "--jq", ".[] | {id, body, created_at}",
    ], { cwd: project.path });
    const comments = listed.stdout.trim()
      ? listed.stdout.trim().split(/\r?\n/).map((line) => object(parseJson(line, "gh api pull request comments"), "gh api pull request comment"))
        .flatMap((row) => typeof row.body === "string" && (typeof row.id === "number" || typeof row.id === "string")
          ? [{ id: String(row.id), body: row.body, createdAt: typeof row.created_at === "string" ? row.created_at : "" }]
          : [])
      : [];
    const canonical = comments.filter((comment) => comment.body.includes("<!-- merro:review-notes -->"))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).at(-1);
    if (!canonical) {
      await this.#postReviewComment(project, repository.nameWithOwner, pullRequest.number, reviewNotes);
      return;
    }
    if (canonical.body === reviewNotes) return;
    try {
      await this.#retry(() => this.#commands.run("gh", [
        "api", "--method", "PATCH", `repos/${repository.nameWithOwner}/issues/comments/${canonical.id}`,
        "--field", `body=${reviewNotes}`,
      ], { cwd: project.path }));
    } catch {
      await this.#postReviewComment(project, repository.nameWithOwner, pullRequest.number, reviewNotes);
    }
  }

  async #postReviewComment(project: Project, repository: string, number: number, body: string): Promise<void> {
    const endpoint = `repos/${repository}/issues/${number}/comments`;
    await this.#retry(async () => {
      await this.#commands.run("gh", [
        "pr", "comment", String(number), "--repo", repository, "--body", body,
      ], { cwd: project.path });
    }, async () => {
      try {
        const listed = await this.#read(["api", endpoint, "--paginate", "--jq", ".[] | {body}"], { cwd: project.path });
        const exists = listed.stdout.trim().split(/\r?\n/).some((line) => {
          try {
            return object(parseJson(line, "gh api pull request comments"), "gh api pull request comment").body === body;
          } catch {
            return false;
          }
        });
        return exists ? { type: "done", value: undefined } : { type: "retry" };
      } catch {
        return { type: "fail" };
      }
    });
  }

  async createPullRequest(
    project: Project,
    branchName: string,
    title: string,
    body: string,
  ): Promise<GitHubPullRequest> {
    const existing = await this.findPullRequest(project, branchName);
    if (existing) return existing;

    const [base, head] = await Promise.all([
      this.repository(project.baseRemote),
      this.repository(project.pushRemote),
    ]);
    const owner = head.nameWithOwner.split("/")[0];
    if (!owner) throw new Error(`cannot determine GitHub head owner for ${head.nameWithOwner}`);
    const headRef = base.nameWithOwner === head.nameWithOwner ? branchName : `${owner}:${branchName}`;
    return this.#retry(async () => {
      const result = await this.#commands.run("gh", [
        "pr", "create", "--repo", base.nameWithOwner,
        "--head", headRef, "--base", project.defaultBranch,
        "--title", title, "--body", body,
      ], { cwd: project.path });
      const url = result.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
      const number = url ? Number(url.match(/\/pull\/(\d+)/)?.[1]) : Number.NaN;
      if (!Number.isSafeInteger(number) || number < 1) throw new Error(`gh pr create returned no pull request URL: ${result.stdout.trim()}`);
      return this.pullRequest(project, number);
    }, async () => {
      try {
        const existing = await this.findPullRequest(project, branchName);
        return existing ? { type: "done", value: existing } : { type: "retry" };
      } catch {
        return { type: "fail" };
      }
    });
  }

  async hasWritePermission(project: Project, username: string): Promise<boolean> {
    const normalizedUsername = username.trim().toLowerCase();
    if (!normalizedUsername) return false;
    const key = `${project.baseRemote.toLowerCase()}\0${normalizedUsername}`;
    const cached = this.#reviewerPermissionCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.result;

    const result = (async () => {
      const repository = await this.repository(project.baseRemote);
      const path = `repos/${repository.nameWithOwner}/collaborators/${encodeURIComponent(username)}/permission`;
      try {
        const response = await this.#read(["api", path], { cwd: project.path });
        const row = object(parseJson(response.stdout, "gh api collaborator permission"), "gh api collaborator permission");
        const permission = typeof row.permission === "string" ? row.permission.toLowerCase() : "none";
        return permission === "write" || permission === "maintain" || permission === "admin";
      } catch (error) {
        if (isNotFound(error)) return false;
        throw error;
      }
    })();
    this.#reviewerPermissionCache.set(key, { expiresAt: Date.now() + 30_000, result });
    try {
      return await result;
    } catch (error) {
      if (this.#reviewerPermissionCache.get(key)?.result === result) this.#reviewerPermissionCache.delete(key);
      throw error;
    }
  }

  async branchProtection(project: Project, branchName = project.defaultBranch): Promise<BranchPolicy> {
    const repository = await this.repository(project.baseRemote);
    const branch = encodeURIComponent(branchName);
    const classicPath = `repos/${repository.nameWithOwner}/branches/${branch}/protection`;
    const rulesPath = `repos/${repository.nameWithOwner}/rules/branches/${branch}`;
    let classicOutput: string | null = null;
    try {
      classicOutput = (await this.#read(["api", classicPath], { cwd: project.path })).stdout;
    } catch (error) {
      if (!isNotFound(error)) return { known: false, reason: error instanceof Error ? error.message : String(error), retryable: true };
    }

    let classicChecks: string[] = [];
    let classicApprovals = 0;
    let classicCodeOwners = false;
    let dismissStaleApprovals = false;
    if (classicOutput !== null) {
      try {
        const row = object(parseJson(classicOutput, "gh api branch protection"), "gh api branch protection");
        if (hasPinnedCheckIdentity((row.required_status_checks as Record<string, unknown> | null)?.checks, "app_id")) {
          throw new Error("classic branch protection pins required checks to an unsupported GitHub App identity");
        }
        const conversationResolution = typeof row.required_conversation_resolution === "object" && row.required_conversation_resolution !== null
          ? row.required_conversation_resolution as Record<string, unknown>
          : {};
        if (conversationResolution.enabled === true) throw new Error("classic branch protection requires unsupported review-thread resolution");
        classicChecks = statusCheckNames(row.required_status_checks);
        const reviews = typeof row.required_pull_request_reviews === "object" && row.required_pull_request_reviews !== null
          ? row.required_pull_request_reviews as Record<string, unknown>
          : {};
        if (reviews.require_last_push_approval === true) throw new Error("classic branch protection requires unsupported last-push approval");
        classicApprovals = typeof reviews.required_approving_review_count === "number" ? reviews.required_approving_review_count : 0;
        classicCodeOwners = reviews.require_code_owner_reviews === true;
        dismissStaleApprovals = reviews.dismiss_stale_reviews === true;
      } catch (error) {
        return { known: false, reason: error instanceof Error ? error.message : String(error), retryable: false };
      }
    }

    let rulesOutput: string;
    try {
      rulesOutput = (await this.#read(["api", rulesPath], { cwd: project.path })).stdout;
    } catch (error) {
      return { known: false, reason: error instanceof Error ? error.message : String(error), retryable: true };
    }

    try {
      const rules = parseJson(rulesOutput, "gh api branch rules");
      if (!Array.isArray(rules)) throw new Error("gh api branch rules returned a non-array value");
      const requiredStatusChecks = [...classicChecks];
      let requiredApprovingReviewCount = classicApprovals;
      let requireCodeOwnerReviews = classicCodeOwners;
      let dismissStale = dismissStaleApprovals;
      const requiredTeamReviews: RequiredTeamReviewRequirement[] = [];
      for (const value of rules) {
        const rule = object(value, "gh api branch rule");
        const parameters = typeof rule.parameters === "object" && rule.parameters !== null
          ? rule.parameters as Record<string, unknown>
          : {};
        if (rule.type === "required_status_checks") {
          rejectUnknownRuleParameters(parameters, new Set([
            "required_status_checks", "strict_required_status_checks_policy", "do_not_enforce_on_create",
          ]));
          if (hasPinnedCheckIdentity(parameters.required_status_checks, "integration_id")) {
            throw new Error("ruleset pins required checks to an unsupported GitHub App identity");
          }
          requiredStatusChecks.push(...statusCheckNames({ checks: parameters.required_status_checks }));
        } else if (rule.type === "pull_request") {
          rejectUnknownRuleParameters(parameters, new Set([
            "dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval",
            "required_approving_review_count", "required_review_thread_resolution", "required_reviewers",
          ]));
          if (ruleParameterEnabled(parameters, "require_last_push_approval")) throw new Error("ruleset requires unsupported last-push approval");
          if (ruleParameterEnabled(parameters, "required_review_thread_resolution")) throw new Error("ruleset requires unsupported review-thread resolution");
          if (typeof parameters.required_approving_review_count === "number" && parameters.required_approving_review_count < 0) {
            throw new Error("ruleset has an invalid required approval count");
          }
          if (typeof parameters.required_approving_review_count === "number") {
            requiredApprovingReviewCount = Math.max(requiredApprovingReviewCount, parameters.required_approving_review_count);
          }
          requireCodeOwnerReviews ||= parameters.require_code_owner_review === true
            || parameters.require_code_owner_reviews === true;
          dismissStale ||= parameters.dismiss_stale_reviews_on_push === true;
          if (parameters.required_reviewers !== undefined) {
            if (!Array.isArray(parameters.required_reviewers)) throw new Error("ruleset has invalid required_reviewers parameter");
            for (const value of parameters.required_reviewers) {
              const requirement = object(value, "ruleset pull_request.required_reviewers entry");
              const reviewer = object(requirement.reviewer, "ruleset required reviewer");
              if (reviewer.type !== "Team" || !Number.isSafeInteger(reviewer.id) || Number(reviewer.id) < 1) {
                throw new Error("ruleset required reviewer must identify a team by numeric id");
              }
              if (!Number.isSafeInteger(requirement.minimum_approvals) || Number(requirement.minimum_approvals) < 0) {
                throw new Error("ruleset required reviewer has invalid minimum_approvals");
              }
              if (requirement.file_patterns !== undefined
                && (!Array.isArray(requirement.file_patterns) || requirement.file_patterns.some((pattern) => typeof pattern !== "string" || !pattern.trim()))) {
                throw new Error("ruleset required reviewer has invalid file_patterns");
              }
              requiredTeamReviews.push({ teamId: Number(reviewer.id), minimumApprovals: Number(requirement.minimum_approvals),
                filePatterns: Array.isArray(requirement.file_patterns) ? requirement.file_patterns as string[] : [] });
            }
          }
        } else if (rule.type === "required_reviewers" || rule.type === "required_review_thread_resolution") {
          throw new Error(`ruleset contains unsupported merge requirement '${String(rule.type)}'`);
        } else if (rule.type !== "creation" && rule.type !== "deletion" && rule.type !== "non_fast_forward") {
          throw new Error(`ruleset contains unsupported branch rule '${String(rule.type)}'`);
        }
      }
      return {
        known: true,
        requiredStatusChecks: [...new Set(requiredStatusChecks)],
        requiredApprovingReviewCount,
        requireCodeOwnerReviews,
        dismissStaleApprovals: dismissStale,
        requiredTeamReviews,
      };
    } catch (error) {
      return { known: false, reason: error instanceof Error ? error.message : String(error), retryable: false };
    }
  }

  async mergeSquash(project: Project, number: number, expectedHeadCommit: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/i.test(expectedHeadCommit)) {
      throw new Error(`invalid expected pull request head SHA: ${expectedHeadCommit}`);
    }
    try {
      const repository = await this.repository(project.baseRemote);
      await this.#retry(async () => {
        await this.#commands.run("gh", [
          "pr", "merge", String(number), "--repo", repository.nameWithOwner,
          "--squash", "--match-head-commit", expectedHeadCommit,
        ], { cwd: project.path });
      }, async () => {
        try {
          const pullRequest = await this.pullRequest(project, number);
          if (pullRequest.mergedAt && pullRequest.headRefOid.toLowerCase() === expectedHeadCommit.toLowerCase()) {
            return { type: "done", value: undefined };
          }
          return pullRequest.state === "OPEN" && pullRequest.headRefOid.toLowerCase() === expectedHeadCommit.toLowerCase()
            ? { type: "retry" }
            : { type: "fail" };
        } catch {
          return { type: "fail" };
        }
      });
    } catch (error) {
      throw new GitHubMergeError(
        isGitHubAvailabilityFailure(error) ? "unavailable" : "rejected",
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }
}
