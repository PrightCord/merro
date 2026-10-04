import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, type Stats } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { MerroConfig } from "../config.js";
import type { BaseUpdate, Project, TaskRole } from "../domain/model.js";
import { semanticSlug } from "../domain/names.js";
import type { ProjectSettingsRecord, TaskRuntimeRecord } from "../store/model.js";
import { CommandError, type CommandRunner, systemCommandRunner } from "./commands.js";
import { dockerBindMount } from "./docker-mount.js";

const GENERIC_IMAGE = "merro-worker";
const TASK_MOUNT = "/merro-task";
const CLONE_MOUNT = "/work";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(moduleDirectory);

function findPackageRoot(start: string): string {
  let directory = resolve(start);
  while (true) {
    if (existsSync(join(directory, "package.json")) && existsSync(join(directory, "src"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`cannot locate Merro package root from ${start}`);
    directory = parent;
  }
}

export interface WorkerDependencyMount {
  projectSlug: string;
  checkoutPath: string;
  mountPath: string;
}

export interface WorkerLaunchInput {
  taskId: string;
  changeSetId: string;
  changeSlug: string;
  taskName: string;
  role: TaskRole;
  project: Project;
  clonePath: string;
  taskFile: string;
  /** Additional Worker-only system-prompt context, staged outside the checkout. */
  systemPrompt?: string;
  expectedCommit: string;
  baseUpdate?: BaseUpdate | null;
  projectSettings: ProjectSettingsRecord | null;
  dependencies?: readonly WorkerDependencyMount[];
}

export interface OwnedWorker {
  taskId: string | null;
  projectSlug: string;
  changeSetId: string | null;
  clonePath: string | null;
  tmuxSession: string | null;
  tmuxWindow: string | null;
  paneId: string | null;
  containerId: string | null;
}

export interface WorkerPresence {
  alive: boolean;
  identityMatches: boolean;
  reason: string | null;
  exitStatus?: number | null;
  exitSignal?: number | null;
  diagnosticPath?: string | null;
}

export interface WorkerRuntimeOptions {
  workspacePath: string;
  config: MerroConfig;
  commands?: CommandRunner;
  piConfigPath?: string;
}

function safeName(value: string): string {
  const name = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128);
  if (!name) throw new Error("Task and Project identities must contain a safe tmux name");
  return name;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function projectSession(project: Project, prefix = "merro"): string {
  return `${prefix}-${safeName(project.slug)}`;
}

export function taskWindowName(role: TaskRole, slug: string): string {
  return `${role === "implement" ? "impl" : "rev"}-${semanticSlug(slug)}`;
}

function missingTmuxTarget(error: unknown): boolean {
  const detail = error instanceof CommandError ? error.stderr : String(error);
  return /no such (?:session|window|pane)|missing (?:session|window|pane)|(?:can't|cannot|could not) find (?:session|window|pane)|no server running|error connecting.*(?:No such file|Connection refused)/i.test(detail);
}

function optionalTmuxNumber(value: string): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseDockerInspect(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("docker inspect returned invalid JSON", { cause: error });
  }
  if (!Array.isArray(value) || typeof value[0] !== "object" || value[0] === null) {
    throw new Error("docker inspect returned an unexpected value");
  }
  return value[0] as Record<string, unknown>;
}

function shellScript(environment: Record<string, string>, command: string): string {
  const exports = Object.entries(environment).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  return `#!/bin/sh\nset -eu\nrm -- "$0"\nunset GH_TOKEN GITHUB_TOKEN\n${exports}\nexec ${command}\n`;
}

async function copyTree(source: string, target: string, omitted = new Set<string>()): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (omitted.has(entry.name) || entry.isSymbolicLink()) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to, omitted);
      await chmod(to, 0o700);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, 0o600);
    }
  }
}

async function taskExcludeFile(clonePath: string): Promise<void> {
  const excludePath = join(clonePath, ".git", "info", "exclude");
  await mkdir(dirname(excludePath), { recursive: true });
  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch (error) {
    if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!current.split(/\r?\n/).includes("/.merro-task.md")) {
    await writeFile(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}/.merro-task.md\n`, "utf8");
  }
}

export class WorkerRuntime {
  readonly #workspacePath: string;
  readonly #config: MerroConfig;
  readonly #commands: CommandRunner;
  readonly #piConfigPath: string;
  readonly #resolvedImages = new Map<string, string>();

  constructor(options: WorkerRuntimeOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#config = options.config;
    this.#commands = options.commands ?? systemCommandRunner;
    this.#piConfigPath = options.piConfigPath ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  }

  async prepareClone(project: Project, clonePath: string, settings: ProjectSettingsRecord | null): Promise<void> {
    const sandbox = settings?.sandbox ?? this.#config.sandbox;
    const network = settings?.network ?? this.#config.network;
    if (sandbox === "none" && network === "off") throw new Error("network=off requires Docker sandboxing");
    if (!settings?.setupCommand?.trim()) return;
    if (sandbox === "none") {
      await this.#commands.run("bash", ["-lc", settings.setupCommand], { cwd: clonePath });
      return;
    }
    const image = await this.#resolveImage(project, settings);
    const args = ["run", "--rm", "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--env", "HOME=/tmp", "--workdir", CLONE_MOUNT, ...dockerBindMount(resolve(clonePath), CLONE_MOUNT)];
    if (network === "off") args.push("--network", "none");
    args.push(image, "sh", "-lc", settings.setupCommand);
    await this.#commands.run("docker", args);
  }

  plan(input: WorkerLaunchInput): TaskRuntimeRecord {
    const sandbox = input.projectSettings?.sandbox ?? this.#config.sandbox;
    const network = input.projectSettings?.network ?? this.#config.network;
    if (sandbox === "none" && network === "off") {
      throw new Error("network=off requires Docker sandboxing");
    }
    const scratchPath = join(this.#workspacePath, "tasks", safeName(input.taskName));
    return {
      taskId: input.taskId,
      runtimeKind: sandbox === "docker" ? "docker" : "host",
      tmuxSession: projectSession(input.project, this.#config.tmux.session),
      tmuxWindow: taskWindowName(input.role, input.changeSlug),
      paneId: null,
      containerId: null,
      processPid: null,
      processStartedAt: null,
      clonePath: resolve(input.clonePath),
      taskFilePath: join(resolve(input.clonePath), ".merro-task.md"),
      resultPath: join(scratchPath, ".merro-result.json"),
      expectedCommit: input.expectedCommit,
      ...(input.baseUpdate ? { baseUpdate: input.baseUpdate } : {}),
      startedAt: new Date().toISOString(),
    };
  }

  async launch(input: WorkerLaunchInput, plan = this.plan(input)): Promise<TaskRuntimeRecord> {
    const sandbox = input.projectSettings?.sandbox ?? this.#config.sandbox;
    const network = input.projectSettings?.network ?? this.#config.network;
    const startedAt = plan.startedAt;
    const owner = await this.#workspaceOwner();
    const scratchPath = dirname(plan.resultPath);
    const secretRoot = join(this.#workspacePath, "launch-secrets");
    const scratchConfigPath = join(scratchPath, "pi-config");
    const extensionRoot = join(scratchPath, "merro-runtime");
    const homePath = join(scratchPath, "home");
    const resultPath = plan.resultPath;
    const taskFilePath = plan.taskFilePath;
    const workerGuidance = input.systemPrompt?.trim() ?? "";
    const workerGuidancePath = join(scratchPath, "worker-guidance.md");
    const session = plan.tmuxSession;
    const window = plan.tmuxWindow;

    await mkdir(scratchPath, { recursive: true, mode: 0o700 });
    await mkdir(homePath, { recursive: true, mode: 0o700 });
    await taskExcludeFile(input.clonePath);
    await writeFile(taskFilePath, input.taskFile, { encoding: "utf8", mode: 0o600 });
    if (workerGuidance) await writeFile(workerGuidancePath, workerGuidance, { encoding: "utf8", mode: 0o600 });
    if (sandbox === "docker") await this.#copyPiConfig(scratchConfigPath);
    await this.#copyWorkerExtension(extensionRoot);

    const environment: Record<string, string> = {
      HOME: join(TASK_MOUNT, "home"),
      PI_CODING_AGENT_DIR: join(TASK_MOUNT, "pi-config"),
      MERRO_RUNTIME: "worker",
      MERRO_TASK_ID: input.taskId,
      MERRO_TASK_ROLE: input.role,
      MERRO_RESULT_PATH: join(TASK_MOUNT, ".merro-result.json"),
      MERRO_TASK_SCRATCH: TASK_MOUNT,
      ...(workerGuidance ? { MERRO_WORKER_GUIDANCE_PATH: sandbox === "docker" ? join(TASK_MOUNT, "worker-guidance.md") : workerGuidancePath } : {}),
    };
    const workerGithub = input.projectSettings?.workerGithub ?? this.#config.worker_github === "on";
    if (workerGithub) {
      const token = (await this.#commands.run("gh", ["auth", "token"], { cwd: input.project.path })).stdout.trim();
      if (!token || /[\r\n]/.test(token)) throw new Error("gh auth token returned an invalid worker token");
      environment.GH_TOKEN = token;
    }

    const settings = input.role === "implement" ? this.#config.worker : this.#config.reviewer;
    const roleArguments = [
      ...(settings.model ? ["--model", settings.model] : []),
      ...(settings.thinking ? ["--thinking", settings.thinking] : []),
    ];
    const commonPiArgs = ["--no-session", "--tui-mode", "regular", "--approve", ...roleArguments];
    const piArgs = [
      "pi", ...commonPiArgs,
      "--extension", join(TASK_MOUNT, "merro-runtime", "tools", "worker-result.js"),
      "--extension", join(TASK_MOUNT, "merro-runtime", "tools", "worker-lifecycle.js"),
      ...(workerGuidance ? ["--extension", join(TASK_MOUNT, "merro-runtime", "tools", "worker-guidance.js")] : []),
      "--", `@${CLONE_MOUNT}/.merro-task.md`,
    ];
    const cidPath = join(this.#workspacePath, "container-ids", `${safeName(input.taskName)}.cid`);
    let paneId: string | null = null;
    let windowId: string | null = null;
    let containerId: string | null = null;
    let processPid: number | null = null;
    let processStartedAt: string | null = null;
    let launchCommand: string;
    let launchSecretPath: string | null = null;
    let launchSucceeded = false;
    let windowLaunchAttempted = false;

    try {
      if (sandbox === "docker") {
        const image = await this.#resolveImage(input.project, input.projectSettings);
        await mkdir(dirname(cidPath), { recursive: true, mode: 0o700 });
        await rm(cidPath, { force: true });
        const environmentPath = join(secretRoot, `${safeName(input.taskName)}.env`);
        launchSecretPath = environmentPath;
        await mkdir(secretRoot, { recursive: true, mode: 0o700 });
        await writeFile(environmentPath, `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
        const dependencyMounts = (input.dependencies ?? []).flatMap((dependency) => {
          const checkoutPath = resolve(dependency.checkoutPath);
          const checkoutRelative = relative(scratchPath, checkoutPath);
          if (!checkoutRelative || checkoutRelative === ".." || checkoutRelative.startsWith(`..${sep}`) || isAbsolute(checkoutRelative)) {
            throw new Error(`dependency checkout must be inside Task scratch: ${checkoutPath}`);
          }
          if (!/^\/merro-dependencies\/[1-9][0-9]*$/.test(dependency.mountPath)) {
            throw new Error(`invalid dependency mount path: ${dependency.mountPath}`);
          }
          return dockerBindMount(checkoutPath, dependency.mountPath, { readOnly: true });
        });
        const dockerArgs = [
          "run", "--rm", "--cidfile", cidPath,
          "--name", `merro-${safeName(input.taskName)}`, "--interactive", "--tty",
          "--label", `merro.task_id=${input.taskId}`,
          "--label", `merro.project=${input.project.slug}`,
          "--label", `merro.owner=${owner}`,
          "--label", `merro.work_item_id=${input.changeSetId}`,
          "--label", `merro.clone_path=${resolve(input.clonePath)}`,
          "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          "--workdir", CLONE_MOUNT,
          ...dockerBindMount(resolve(input.clonePath), CLONE_MOUNT, { readOnly: input.role === "review" }),
          ...dockerBindMount(scratchPath, TASK_MOUNT),
          ...dependencyMounts,
          "--network", network === "off" ? "none" : "bridge",
          "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=1g",
          "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
          "--pids-limit", "256", "--env-file", environmentPath,
          image,
          ...piArgs,
        ];
        launchCommand = `exec ${["docker", ...dockerArgs].map(shellQuote).join(" ")}`;
      } else {
        // Host workers inherit HOME, Pi packages, auth, models, settings, and environment.
        const { HOME: _home, PI_CODING_AGENT_DIR: _config, ...workerEnvironment } = environment;
        const inherited = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
          && key !== "TMUX" && key !== "TMUX_PANE" && key !== "GH_TOKEN" && key !== "GITHUB_TOKEN"));
        const hostEnvironment = {
          ...inherited as Record<string, string>, ...workerEnvironment,
          MERRO_RESULT_PATH: resultPath,
          MERRO_TASK_SCRATCH: scratchPath,
        };
        const hostArgs = [
          "pi", ...commonPiArgs,
          "--extension", join(extensionRoot, "tools", "worker-result.js"),
          "--extension", join(extensionRoot, "tools", "worker-lifecycle.js"),
          ...(workerGuidance ? ["--extension", join(extensionRoot, "tools", "worker-guidance.js")] : []),
          "--", `@${taskFilePath}`,
        ];
        const command = hostArgs.map(shellQuote).join(" ");
        const scriptPath = join(secretRoot, `${safeName(input.taskName)}.sh`);
        launchSecretPath = scriptPath;
        await mkdir(secretRoot, { recursive: true, mode: 0o700 });
        await writeFile(scriptPath, shellScript(hostEnvironment, command), { encoding: "utf8", mode: 0o700 });
        await chmod(scriptPath, 0o700);
        launchCommand = `exec ${shellQuote(scriptPath)}`;
      }

      const existingSession = await this.#sessionExists(session, input.project);
      const sessionMarkers = existingSession ? [] : [
        ";", "set-option", "-t", `=${session}`, "@merro_project", input.project.slug,
        ";", "set-option", "-t", `=${session}`, "@merro_owner", owner,
        ";", "set-environment", "-t", `=${session}`, "MERRO_PROJECT", input.project.slug,
        ";", "set-environment", "-t", `=${session}`, "MERRO_OWNER", owner,
      ];
      windowLaunchAttempted = true;
      // The first Task is the session's first window. Mark ownership in the same server command queue.
      const paneResult = await this.#commands.run("tmux", [
        existingSession ? "new-window" : "new-session", "-d", "-P", "-F", "#{pane_id}",
        existingSession ? "-t" : "-s", existingSession ? `=${session}` : session,
        "-n", window, "-c", sandbox === "none" ? resolve(input.clonePath) : input.project.path,
        launchCommand,
        ...sessionMarkers,
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "automatic-rename", "off",
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "allow-rename", "off",
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "remain-on-exit", sandbox === "none" ? "on" : "off",
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "@merro_task_id", input.taskId,
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "@merro_work_item_id", input.changeSetId,
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "@merro_clone_path", resolve(input.clonePath),
        ";", "set-option", "-w", "-t", `=${session}:${window}`, "@merro_runtime_kind", sandbox === "docker" ? "docker" : "host",
      ]);
      paneId = paneResult.stdout.trim() || null;
      if (!paneId || !/^%\d+$/.test(paneId)) throw new Error("tmux did not return an exact worker pane identity.");
      windowId = (await this.#commands.run("tmux", ["display-message", "-p", "-t", paneId, "#{window_id}"])).stdout.trim();
      if (!/^@\d+$/.test(windowId)) throw new Error("tmux did not return a stable worker window identity.");

      if (sandbox === "docker") {
        containerId = await this.#waitForContainerId(cidPath);
        try {
          const inspect = parseDockerInspect((await this.#commands.run("docker", ["inspect", containerId])).stdout);
          const state = typeof inspect.State === "object" && inspect.State !== null
            ? inspect.State as Record<string, unknown>
            : {};
          processPid = 1;
          processStartedAt = typeof state.StartedAt === "string" ? state.StartedAt : startedAt;
        } catch {
          processPid = 1;
          processStartedAt = startedAt;
        }
      } else {
        const pane = (await this.#commands.run("tmux", ["display-message", "-p", "-t", paneId, "#{pane_pid}"])).stdout.trim();
        processPid = Number(pane);
        if (!Number.isSafeInteger(processPid) || processPid < 1) throw new Error(`invalid pane PID for Task ${input.taskId}`);
        processStartedAt = await this.#hostProcessStartedAt(processPid);
      }

      launchSucceeded = true;
      return {
        taskId: input.taskId,
        runtimeKind: sandbox === "docker" ? "docker" : "host",
        tmuxSession: session,
        tmuxWindow: window,
        paneId,
        windowId,
        containerId,
        processPid,
        processStartedAt,
        clonePath: resolve(input.clonePath),
        taskFilePath,
        resultPath,
        expectedCommit: input.expectedCommit,
        ...(input.baseUpdate ? { baseUpdate: input.baseUpdate } : {}),
        startedAt,
      };
    } catch (error) {
      const partial = { ...plan, paneId, windowId, containerId, processPid, processStartedAt };
      try {
        if (windowLaunchAttempted) {
          const target = paneId ?? `=${session}:${window}`;
          await this.#commands.run("tmux", ["kill-window", "-t", target]).catch(async (killError: unknown) => {
            if (missingTmuxTarget(killError)) return;
            try {
              await this.#commands.run("tmux", ["display-message", "-p", "-t", target, "#{pane_id}"]);
            } catch (lookupError) {
              if (missingTmuxTarget(lookupError)) return;
              throw new AggregateError([killError, lookupError], "Cannot verify tmux rollback target");
            }
            throw killError;
          });
          if (sandbox === "docker") {
            try {
              const container = containerId ?? `merro-${safeName(input.taskName)}`;
              const inspected = parseDockerInspect((await this.#commands.run("docker", ["inspect", container])).stdout);
              const labels = (inspected.Config as { Labels?: Record<string, string> } | undefined)?.Labels;
              if (labels?.["merro.task_id"] !== input.taskId) throw new Error("Cannot verify container ownership during rollback");
              if ((inspected.State as { Running?: boolean } | undefined)?.Running) {
                await this.#commands.run("docker", ["stop", "--time", "10", container]);
              }
            } catch (rollbackError) {
              if (!(rollbackError instanceof CommandError && /no such (?:object|container)/i.test(rollbackError.stderr))) throw rollbackError;
            }
          }
        }
        await this.cleanup(partial);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Worker launch failed and rollback failed: ${String(error)}; ${String(rollbackError)}`);
      }
      throw error;
    } finally {
      if (launchSecretPath !== null && (!launchSucceeded || sandbox === "docker")) {
        await rm(launchSecretPath, { force: true });
      }
    }
  }

  async listOwnedWorkers(project: Project, settings: ProjectSettingsRecord | null = null,
    recordedRuntimes: readonly TaskRuntimeRecord[] = []): Promise<OwnedWorker[]> {
    const sessions = new Set([projectSession(project, this.#config.tmux.session), ...recordedRuntimes.map((record) => record.tmuxSession)]);
    const owner = await this.#workspaceOwner();
    const workers: OwnedWorker[] = [];
    let dockerPane = false;
    for (const session of sessions) {
      if (!await this.#sessionExists(session, project, recordedRuntimes)) continue;
      const panes = (await this.#commands.run("tmux", ["list-panes", "-s", "-t", `=${session}`, "-F", "#{pane_id} #{pane_dead}"])).stdout.trim();
      for (const row of panes ? panes.split("\n") : []) {
        const [paneId, dead] = row.split(" ");
        if (!paneId || !/^%\d+$/.test(paneId) || !/^[01]$/.test(dead ?? "")) throw new Error("tmux returned invalid pane inventory");
        if (dead === "1") continue;
        const option = async (name: string): Promise<string | null> =>
          (await this.#commands.run("tmux", ["show-option", "-wqv", "-t", paneId, name])).stdout.replace(/\r?\n$/, "") || null;
        const [taskId, changeSetId, clonePath, kind, window] = await Promise.all([
          option("@merro_task_id"), option("@merro_work_item_id"), option("@merro_clone_path"), option("@merro_runtime_kind"),
          this.#commands.run("tmux", ["display-message", "-p", "-t", paneId, "#{window_name}"]),
        ]);
        dockerPane ||= kind === "docker";
        workers.push({ taskId, projectSlug: project.slug, changeSetId, clonePath,
          tmuxSession: session, tmuxWindow: window.stdout.replace(/\r?\n$/, ""), paneId, containerId: null });
      }
    }
    // Host-only installations do not require Docker. Prior launch artifacts still require an inventory.
    const cids = await readdir(join(this.#workspacePath, "container-ids")).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    const requireDocker = (settings?.sandbox ?? this.#config.sandbox) === "docker" || dockerPane || cids.some((name) => name.endsWith(".cid"));
    let containers: string;
    try {
      containers = (await this.#commands.run("docker", ["ps", "--quiet", "--no-trunc", "--filter", "label=merro.task_id"])).stdout.trim();
    } catch (error) {
      if (!requireDocker && error instanceof CommandError && (error.causeCode === "ENOENT" || /cannot connect|is the docker daemon running|failed to connect/i.test(error.stderr))) return workers;
      throw error;
    }
    for (const containerId of containers ? containers.split("\n") : []) {
      if (!/^[0-9a-f]{12,64}$/i.test(containerId)) throw new Error("Docker returned invalid container inventory");
      let inspect: Record<string, unknown>;
      try {
        inspect = parseDockerInspect((await this.#commands.run("docker", ["inspect", containerId])).stdout);
      } catch (error) {
        // A worker can exit between enumeration and inspection, but a failed live scan is not an empty inventory.
        if ((await this.#commands.run("docker", ["ps", "--quiet", "--filter", `id=${containerId}`])).stdout.trim()) throw error;
        continue;
      }
      const state = inspect.State as { Running?: boolean } | undefined;
      if (state?.Running !== true) continue;
      const labels = (inspect.Config as { Labels?: Record<string, string> } | undefined)?.Labels ?? {};
      const taskId = labels["merro.task_id"];
      if (!taskId) continue;
      const mounts = Array.isArray(inspect.Mounts) ? inspect.Mounts as Array<{ Source?: string; Destination?: string }> : [];
      // Old path-hash owners change when a Project moves. Their Task mount proves workspace ownership.
      const legacyOwner = !labels["merro.owner"] || /^[0-9a-f]{64}$/.test(labels["merro.owner"]);
      const legacyOwned = legacyOwner && (mounts.some((mount) => mount.Destination === TASK_MOUNT
        && mount.Source === join(this.#workspacePath, "tasks", safeName(taskId)))
        || recordedRuntimes.some((record) => record.taskId === taskId && record.containerId === inspect.Id));
      if (!legacyOwned && (labels["merro.owner"] !== owner || labels["merro.project"] !== project.slug)) continue;
      if (legacyOwned && labels["merro.project"] && labels["merro.project"] !== project.slug) continue;
      workers.push({ taskId, projectSlug: project.slug, changeSetId: labels["merro.work_item_id"] ?? null,
        clonePath: labels["merro.clone_path"] ?? mounts.find((mount) => mount.Destination === CLONE_MOUNT)?.Source ?? null,
        tmuxSession: null, tmuxWindow: null, paneId: null, containerId });
    }
    return workers;
  }

  async inspect(record: TaskRuntimeRecord, taskId: string): Promise<WorkerPresence> {
    const runtimeKind = record.runtimeKind ?? (record.containerId || this.#config.sandbox === "docker" ? "docker" : "host");
    if (runtimeKind === "docker") {
      const container = record.containerId ?? `merro-${safeName(basename(dirname(record.resultPath)))}`;
      let inspect: Record<string, unknown>;
      try {
        inspect = parseDockerInspect((await this.#commands.run("docker", ["inspect", container])).stdout);
      } catch (error) {
        if (error instanceof CommandError && /no such (?:object|container)/i.test(error.stderr)) {
          return { alive: false, identityMatches: false, reason: "Worker container is missing" };
        }
        throw error;
      }
      const state = typeof inspect.State === "object" && inspect.State !== null
        ? inspect.State as Record<string, unknown>
        : {};
      const config = typeof inspect.Config === "object" && inspect.Config !== null
        ? inspect.Config as Record<string, unknown>
        : {};
      const labels = typeof config.Labels === "object" && config.Labels !== null
        ? config.Labels as Record<string, unknown>
        : {};
      const actualId = typeof inspect.Id === "string" ? inspect.Id : null;
      const alive = state.Running === true;
      const identityMatches = actualId !== null && (!record.containerId || actualId === record.containerId)
        && labels["merro.task_id"] === taskId;
      if (!alive) return { alive: false, identityMatches, reason: "Docker container is not running" };
      if (!identityMatches) return { alive: true, identityMatches: false, reason: "Docker container identity does not match the active Task" };
      try {
        const output = await this.#commands.run("docker", ["exec", actualId, "sh", "-lc", "tr '\\0' ' ' </proc/1/cmdline"]);
        if (!/\b(?:pi|cli\.js)\b/.test(output.stdout) || !output.stdout.includes("--tui-mode regular")) return { alive: true, identityMatches: false, reason: "container PID 1 is not the expected Pi process" };
      } catch (error) {
        return { alive: true, identityMatches: false, reason: `cannot verify Pi process identity: ${String(error)}` };
      }
      return { alive: true, identityMatches: true, reason: null };
    }

    let paneFound = false;
    try {
      const format = [
        "#{pane_id}", "#{pane_pid}", "#{pane_dead}", "#{pane_current_command}", "#{session_name}",
        "#{window_name}", "#{window_id}", "#{window_panes}", "#{pane_dead_status}", "#{pane_dead_signal}",
      ].join("\t");
      const output = (await this.#commands.run("tmux", [
        "display-message", "-p", "-t", record.paneId ?? `=${record.tmuxSession}:${record.tmuxWindow}`, format,
      ])).stdout.replace(/\r?\n$/, "");
      if (!output) return { alive: false, identityMatches: false, reason: "Worker pane is missing" };
      paneFound = true;
      const result = output.split("\t");
      if (!/^%\d+$/.test(result[0] ?? "") || result.length !== 10 || !/^[01]$/.test(result[2] ?? "")) {
        throw new Error("Cannot read exact worker pane identity");
      }
      const pid = Number(result[1]);
      const taskWindowMatches = (await this.#commands.run("tmux", ["show-option", "-wqv", "-t", result[0]!, "@merro_task_id"])).stdout.trim() === taskId;
      const stableIdentityMatches = taskWindowMatches && record.paneId !== null
        && result[0] === record.paneId
        && result[4] === record.tmuxSession && result[5] === record.tmuxWindow && result[7] === "1"
        && (!record.windowId || result[6] === record.windowId)
        && (record.processPid === null || pid === record.processPid);
      if (result[2] === "1") {
        const exitStatus = optionalTmuxNumber(result[8] ?? "");
        const exitSignal = optionalTmuxNumber(result[9] ?? "");
        const diagnosticPath = stableIdentityMatches
          ? await this.#retainDeadPaneDiagnostics(record, exitStatus, exitSignal)
          : null;
        const exitDetail = exitSignal !== null && exitSignal > 0
          ? `signal ${exitSignal}`
          : exitStatus !== null ? `status ${exitStatus}` : "unknown status";
        return {
          alive: false,
          identityMatches: stableIdentityMatches,
          reason: stableIdentityMatches
            ? `Worker process exited before submitting a result (${exitDetail})${diagnosticPath ? `; diagnostics retained at ${diagnosticPath}` : ""}`
            : "Exited worker pane identity does not match the active Task",
          exitStatus,
          exitSignal,
          diagnosticPath,
        };
      }
      const startedAt = record.processStartedAt === null ? null : await this.#hostProcessStartedAt(pid);
      const identityMatches = stableIdentityMatches
        && (record.processStartedAt === null || startedAt === record.processStartedAt)
        && await this.#foregroundPi(pid, result[3]!);
      return identityMatches
        ? { alive: true, identityMatches: true, reason: null }
        : { alive: true, identityMatches: false, reason: "Worker pane or foreground Pi identity is ambiguous; inspect it before retrying." };
    } catch (error) {
      if (paneFound || !missingTmuxTarget(error)) throw error;
      return { alive: false, identityMatches: false, reason: `tmux pane is gone: ${String(error)}` };
    }
  }

  async stop(record: TaskRuntimeRecord, taskId: string): Promise<void> {
    const presence = await this.inspect(record, taskId);
    if (!presence.alive) return;
    if (!presence.identityMatches) {
      throw new Error(`refusing to stop a worker whose identity does not match Task ${taskId}`);
    }
    const runtimeKind = record.runtimeKind ?? (record.containerId || this.#config.sandbox === "docker" ? "docker" : "host");
    if (runtimeKind === "docker") {
      const container = record.containerId ?? `merro-${safeName(basename(dirname(record.resultPath)))}`;
      await this.#commands.run("docker", ["stop", "--time", "10", container]);
      return;
    }
    await this.#commands.run("tmux", ["kill-window", "-t", record.windowId ?? record.paneId!]);
  }

  async #retainDeadPaneDiagnostics(record: TaskRuntimeRecord, exitStatus: number | null, exitSignal: number | null): Promise<string | null> {
    if (!record.paneId) return null;
    let paneOutput = "";
    try {
      paneOutput = (await this.#commands.run("tmux", ["capture-pane", "-p", "-S", "-200", "-t", record.paneId])).stdout;
    } catch (error) {
      paneOutput = `[capture unavailable: ${String(error)}]\n`;
    }
    const directory = join(this.#workspacePath, "diagnostics");
    const path = join(directory, `${safeName(basename(dirname(record.resultPath)))}.log`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(path, [
        "Merro worker exit diagnostics",
        `status=${exitStatus ?? "unknown"}`,
        `signal=${exitSignal && exitSignal > 0 ? exitSignal : "none"}`,
        "",
        paneOutput,
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      return path;
    } catch {
      return null;
    }
  }

  async #cleanupRetainedHostPane(record: TaskRuntimeRecord): Promise<void> {
    const runtimeKind = record.runtimeKind ?? (record.containerId || this.#config.sandbox === "docker" ? "docker" : "host");
    const windowId = record.windowId;
    if (runtimeKind !== "host" || !record.paneId || !windowId) return;
    try {
      const output = (await this.#commands.run("tmux", [
        "display-message", "-p", "-t", record.paneId, "#{pane_id}\t#{window_id}\t#{pane_dead}",
      ])).stdout.replace(/\r?\n$/, "");
      const parts = output.split("\t");
      if (parts.length !== 3 || !/^%\d+$/.test(parts[0] ?? "") || !/^@\d+$/.test(parts[1] ?? "") || !/^[01]$/.test(parts[2] ?? "")) {
        throw new Error("Cannot read retained worker pane identity during cleanup");
      }
      const taskWindowMatches = (await this.#commands.run("tmux", [
        "show-option", "-wqv", "-t", parts[0]!, "@merro_task_id",
      ])).stdout.trim() === record.taskId;
      const identityMatches = taskWindowMatches && parts[0] === record.paneId && parts[1] === windowId;
      if (!identityMatches) throw new Error(`refusing to clean retained pane for Task ${record.taskId}: identity does not match`);
      if (parts[2] !== "1") throw new Error(`refusing to clean live worker pane for Task ${record.taskId}`);
      await this.#commands.run("tmux", ["kill-window", "-t", windowId]);
    } catch (error) {
      if (missingTmuxTarget(error)) return;
      throw error;
    }
  }

  async cleanup(record: TaskRuntimeRecord, options: { preserveResult?: boolean; preserveTaskInput?: boolean } = {}): Promise<void> {
    await this.#cleanupRetainedHostPane(record);
    const scratch = dirname(record.resultPath);
    await this.#makeWritable(scratch);
    if (options.preserveResult) {
      const entries = await readdir(scratch).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (join(scratch, entry) !== record.resultPath) await rm(join(scratch, entry), { recursive: true, force: true });
      }
    } else {
      await rm(scratch, { recursive: true, force: true });
    }
    // Main preserves the shared input while a successor Task owns this clone.
    if (!options.preserveTaskInput) await rm(record.taskFilePath, { force: true });
    const name = basename(scratch);
    await rm(join(this.#workspacePath, "container-ids", `${name}.cid`), { force: true });
    await rm(join(this.#workspacePath, "launch-secrets", `${name}.env`), { force: true });
    await rm(join(this.#workspacePath, "launch-secrets", `${name}.sh`), { force: true });
  }

  async #makeWritable(path: string): Promise<void> {
    let details: Stats;
    try {
      details = await lstat(path);
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (details.isSymbolicLink()) return;
    if (details.isDirectory()) {
      for (const entry of await readdir(path)) await this.#makeWritable(join(path, entry));
      await chmod(path, details.mode | 0o700);
    } else if (details.isFile()) {
      await chmod(path, details.mode | 0o600);
    }
  }

  async #copyPiConfig(target: string): Promise<void> {
    await mkdir(target, { recursive: true, mode: 0o700 });
    await copyTree(this.#piConfigPath, target, new Set(["sessions", "logs", "cache", "tmp"]));
    await chmod(target, 0o700);
  }

  async #copyWorkerExtension(target: string): Promise<void> {
    const tools = join(target, "tools");
    const protocol = join(target, "protocol");
    const compiledSource = join(packageRoot, "dist", "src");
    await mkdir(tools, { recursive: true, mode: 0o700 });
    await mkdir(protocol, { recursive: true, mode: 0o700 });
    const workerExtension = join(compiledSource, "tools", "worker-result.js");
    const resultProtocol = join(compiledSource, "protocol", "result.js");
    if (!existsSync(workerExtension) || !existsSync(resultProtocol)) {
      throw new Error("compiled worker extension is missing; run npm run build before launching Tasks");
    }
    await copyFile(workerExtension, join(tools, "worker-result.js"));
    await copyFile(resultProtocol, join(protocol, "result.js"));
    await copyFile(join(compiledSource, "tools", "worker-lifecycle.js"), join(tools, "worker-lifecycle.js"));
    await copyFile(join(compiledSource, "tools", "worker-guidance.js"), join(tools, "worker-guidance.js"));
    await copyFile(join(compiledSource, "protocol", "worker-state.js"), join(protocol, "worker-state.js"));
    await writeFile(join(target, "package.json"), '{"type":"module"}\n', { encoding: "utf8", mode: 0o600 });
  }

  async #foregroundPi(panePid: number, currentCommand: string): Promise<boolean> {
    if (!["pi", "node"].includes(currentCommand)) return false;
    const group = Number((await this.#commands.run("ps", ["-p", String(panePid), "-o", "tpgid="])).stdout.trim());
    if (!Number.isSafeInteger(group) || group < 1) return false;
    const output = (await this.#commands.run("ps", ["-eo", "pid=,pgid=,comm=,args="])).stdout;
    const foreground = output.split("\n").map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line))
      .filter((row) => row && Number(row[2]) === group);
    return foreground.filter((row) => row && this.#piCommand(row[3]!, row[4]!)).length === 1;
  }

  #piCommand(comm: string, args: string): boolean {
    const argv = args.trim().split(/\s+/);
    const executable = comm.split("/").at(-1);
    return executable === "pi" || executable === "node" && Boolean(argv[1]
      && (/\/(?:pi|pi\.js)$/.test(argv[1]) || /\/pi-coding-agent\/dist\/cli\.js$/.test(argv[1])));
  }

  async capturePane(record: TaskRuntimeRecord, taskId: string): Promise<string> {
    const presence = await this.inspect(record, taskId);
    if (!presence.identityMatches || !presence.alive || !record.paneId) throw new Error("Worker identity is ambiguous; capture refused.");
    return (await this.#commands.run("tmux", ["capture-pane", "-p", "-t", record.paneId, "-S", "-200"])).stdout;
  }

  async #hostProcessStartedAt(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid host worker PID");
    // tmux has no pane_start_time format. ps works on both Linux and macOS.
    const output = await this.#commands.run("ps", ["-p", String(pid), "-o", "lstart="], { env: { LC_ALL: "C", TZ: "UTC" } });
    const time = Date.parse(`${output.stdout.trim()} UTC`);
    if (!Number.isFinite(time)) throw new Error(`cannot read start time for host worker PID ${pid}`);
    return new Date(time).toISOString();
  }

  async #workspaceOwner(): Promise<string> {
    const path = join(this.#workspacePath, "workspace-owner");
    try {
      const owner = (await readFile(path, "utf8")).trim();
      if (!/^workspace:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(owner)) {
        throw new Error(`invalid Merro workspace owner: ${path}`);
      }
      return owner;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(this.#workspacePath, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `workspace:${randomUUID()}\n`, { flag: "wx", mode: 0o600 });
      // Publish complete content atomically; concurrent runtimes use the first published identity.
      await link(temporary, path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    } finally {
      await rm(temporary, { force: true });
    }
    return this.#workspaceOwner();
  }

  async #sessionExists(session: string, project: Project, recordedRuntimes: readonly TaskRuntimeRecord[] = []): Promise<boolean> {
    const owner = await this.#workspaceOwner();
    try {
      await this.#commands.run("tmux", ["has-session", "-t", `=${session}`]);
    } catch (error) {
      if (missingTmuxTarget(error)) return false;
      throw error;
    }

    const [storedProject, storedOwner] = await Promise.all([
      this.#commands.run("tmux", ["show-option", "-qv", "-t", `=${session}`, "@merro_project"]),
      this.#commands.run("tmux", ["show-option", "-qv", "-t", `=${session}`, "@merro_owner"]),
    ]);
    if (storedProject.stdout.trim() === project.slug) {
      if (storedOwner.stdout.trim() === owner) return true;
      if (/^[0-9a-f]{64}$/.test(storedOwner.stdout.trim())) {
        for (const record of recordedRuntimes) {
          if (record.tmuxSession !== session || !record.paneId
            || (!record.containerId && (record.runtimeKind !== "host" || record.processPid === null || record.processStartedAt === null))) continue;
          try {
            const pane = await this.#commands.run("tmux", ["display-message", "-p", "-t", `=${session}:${record.tmuxWindow}`, "#{pane_id}"]);
            if (pane.stdout.trim() !== record.paneId) continue;
            const presence = await this.inspect(record, record.taskId);
            if (!presence.alive || !presence.identityMatches) continue;
          } catch (error) {
            if (missingTmuxTarget(error)) continue;
            throw error;
          }
          // Migrate namespace metadata only after proving ownership. Task status and processes are untouched.
          await this.#commands.run("tmux", ["set-option", "-t", `=${session}`, "@merro_owner", owner,
            ";", "set-environment", "-t", `=${session}`, "MERRO_OWNER", owner]);
          return true;
        }
      }
    }
    throw new Error(`refusing to adopt unowned tmux session ${session}`);
  }

  async #waitForContainerId(path: string): Promise<string> {
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      try {
        const id = (await readFile(path, "utf8")).trim();
        if (/^[0-9a-f]{12,64}$/i.test(id)) return id;
      } catch (error) {
        if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    throw new Error(`Docker did not start a container (missing cidfile ${path})`);
  }

  async #resolveImage(project: Project, settings: ProjectSettingsRecord | null): Promise<string> {
    const configured = settings?.image?.trim();
    if (configured) {
      const localDockerfile = isAbsolute(configured) ? configured : resolve(project.path, configured);
      try {
        const details = await stat(localDockerfile);
        if (details.isFile()) {
          const tag = `merro-${safeName(project.slug).toLowerCase()}:${Buffer.from(localDockerfile).toString("hex").slice(0, 12)}`;
          const cached = this.#resolvedImages.get(localDockerfile);
          if (cached) return cached;
          await this.#commands.run("docker", ["build", "--tag", tag, "--file", localDockerfile, project.path]);
          this.#resolvedImages.set(localDockerfile, tag);
          return tag;
        }
      } catch (error) {
        if (typeof error !== "object" || error === null || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await this.#commands.run("docker", ["image", "inspect", configured]);
      return configured;
    }

    const piVersion = (await this.#commands.run("pi", ["--version"])).stdout.trim();
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(piVersion)) {
      throw new Error(`pi --version returned an unsupported version: ${piVersion || "empty output"}`);
    }
    const image = `${GENERIC_IMAGE}:pi-${piVersion}`;
    const cached = this.#resolvedImages.get(image);
    if (cached) return cached;
    try {
      await this.#commands.run("docker", ["image", "inspect", image]);
    } catch {
      await this.#commands.run("docker", [
        "build", "--tag", image, "--build-arg", `PI_VERSION=${piVersion}`,
        "--file", join(packageRoot, "docker", "worker.Dockerfile"), packageRoot,
      ]);
    }
    this.#resolvedImages.set(image, image);
    return image;
  }
}
