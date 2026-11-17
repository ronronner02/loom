import nodePath from "node:path";
import { createHash } from "node:crypto";
import { launchManagedHarness, checkManagedReady, type WorkerLauncher } from "./worker-launcher.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile,
  InstalledResource, StartupDeliveryResult, ReadinessResult,
  HarnessLaunchResult,
} from "../domain/runtime-adapter.js";

export interface ClaudeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
}

/** Native Claude adapter. Provider turns are always handed to DirectWorkerLauncher. */
export class ClaudeCodeAdapter implements RuntimeAdapter {
  readonly runtime = "claude-code";
  readonly managedTransport = "direct" as const;
  readonly claudeManagedLaunch = undefined;
  private readonly workerLauncher?: WorkerLauncher;
  private readonly fs: ClaudeAdapterFsOps;

  constructor(deps: {
    fsOps: ClaudeAdapterFsOps;
    workerLauncher?: WorkerLauncher;
    [key: string]: unknown;
  }) {
    this.workerLauncher = deps.workerLauncher;
    this.fs = deps.fsOps;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const root = nodePath.join(binding.cwd, ".claude", "skills");
    if (!this.fs.exists(root) || !this.fs.listFiles) return [];
    return this.fs.listFiles(root).map(file => ({ effectiveId: file, category: "skill", installedPath: nodePath.join(root, file) }));
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const failed: Array<{ path: string; error: string }> = [];
    let delivered = 0;
    for (const file of files) {
      try {
        const target = nodePath.isAbsolute(file.path) ? file.path : nodePath.join(binding.cwd, file.path);
        this.fs.mkdirp(nodePath.dirname(target));
        this.fs.writeFile(target, this.fs.readFile(file.absolutePath));
        delivered++;
      } catch (error) { failed.push({ path: file.path, error: error instanceof Error ? error.message : String(error) }); }
    }
    return { delivered, failed };
  }

  async launchHarness(binding: NodeBinding, opts: { name: string; resumeToken?: string; continueSessionId?: string; forkSource?: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } }): Promise<HarnessLaunchResult> {
    if (!binding.managedAttempt) return { ok: false, error: "Managed worker launch is unavailable" };
    return launchManagedHarness(this.workerLauncher, this.runtime === "claude-code" ? "claude-code" : "claude-code", binding, opts);
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    return binding.managedAttempt ? checkManagedReady(this.workerLauncher, binding.managedAttempt) : { ready: false, code: "managed_launch_unavailable" };
  }
}

/** Retained for callers that used the old activity probe; native turns have no pane report. */
export function readClaudeSelfReportEvidence(): null { return null; }

const CLAUDE_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC = 5;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hookCommand = (value: unknown): string | null => {
  if (!isRecord(value) || value.type !== "command" || typeof value.command !== "string") return null;
  return value.command;
};
const isChannelHookGroup = (value: unknown, relayCommand: string): boolean =>
  isRecord(value) && Array.isArray(value.hooks) && value.hooks.some((hook) => hookCommand(hook) === relayCommand);
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
};

export function upsertClaudeNativeChannelHook(settingsText: string, relayCommand: string): string {
  let settings: Record<string, unknown>;
  try {
    const parsed: unknown = settingsText.trim() === "" ? {} : JSON.parse(settingsText);
    if (!isRecord(parsed)) return settingsText;
    settings = parsed;
  } catch { return settingsText; }
  const hooks = isRecord(settings.hooks) ? { ...settings.hooks } : {};
  const groups = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  hooks.PostToolUse = [
    ...groups.filter((group) => !isChannelHookGroup(group, relayCommand)),
    { hooks: [{ type: "command", command: relayCommand, timeout: CLAUDE_NATIVE_CHANNEL_HOOK_TIMEOUT_SEC }] },
  ];
  return `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`;
}

export function claudeNativeChannelDigest(scopes: readonly (string | null)[], relayCommand: string): string | null {
  const hookSets: unknown[] = [];
  let channelGroups = 0;
  for (const text of scopes) {
    if (text === null || text.trim() === "") { hookSets.push(null); continue; }
    let settings: unknown;
    try { settings = JSON.parse(text); } catch { return null; }
    if (!isRecord(settings)) return null;
    const hooks = settings.hooks ?? null;
    if (hooks !== null && !isRecord(hooks)) return null;
    const post = hooks?.PostToolUse;
    if (Array.isArray(post)) channelGroups += post.filter((group) => isChannelHookGroup(group, relayCommand)).length;
    hookSets.push({ hooks, disableAllHooks: settings.disableAllHooks ?? null });
  }
  if (channelGroups !== 1) return null;
  return createHash("sha256").update(JSON.stringify(canonicalJson(hookSets))).digest("hex");
}
