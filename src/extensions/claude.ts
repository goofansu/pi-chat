/**
 * Claude Extension — delegate read-only codebase investigation to Claude Code.
 *
 * Registers a `claude` tool that hands a self-contained investigation task to
 * Claude Code through the Claude Agent SDK and returns its final answer. The SDK
 * spawns the `claude` CLI, which authenticates from its own credential store, so
 * this needs no API key of its own — only a CLI already logged in on the host.
 *
 * The delegated session is strictly read-only: it may read, grep, and glob files
 * under PI_CHAT_PROJECT_DIR and nothing else. No shell, no writes, no network, no
 * subagents, and no configuration inherited from disk. See READ_ONLY_TOOLS,
 * createPathGuardHook, and buildClaudeOptions for how that is enforced and why
 * each layer is there.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import type {
  CanUseTool,
  Options as ClaudeOptions,
  EffortLevel,
  HookCallback,
  SDKMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { projectCwd } from "./utils.ts";

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The only tools the delegated session may use.
 *
 * This is the base tool set, not a permission hint: the SDK's `tools` option
 * defines what exists at all, so a tool absent from here is never in the model's
 * context. It has to be an allowlist rather than a denylist — Claude Code's tool
 * set is open and grows with every release, so naming today's dangerous tools
 * would leave tomorrow's reachable.
 */
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"] as const;

const READ_ONLY_TOOL_SET: ReadonlySet<string> = new Set(READ_ONLY_TOOLS);

/**
 * Tools denied outright, on top of being absent from {@link READ_ONLY_TOOLS}.
 *
 * Two mechanisms on purpose. The allowlist is what fails closed against a tool
 * this CLI version has never heard of; the denylist still holds if a future CLI
 * widens its base set or stops honoring `tools`.
 *
 * `ToolSearch` matters most: it is the gateway to Claude Code's deferred
 * built-in set, so leaving it available would re-open the very set the allowlist
 * exists to close — `CronCreate` schedules a recurring cloud agent, and
 * `RemoteTrigger` launches a remote one, neither of which a support bot should
 * be able to reach. `Agent` and `Task` are two names for the one native
 * delegation tool, so both are named.
 *
 * The list has to cover every way out, not just the obvious ones: `Artifact`
 * publishes a page to claude.ai, which is network egress out of a session
 * documented as having no network, and `EnterWorktree` creates a git worktree,
 * which is a write. Both would be reachable in a CLI that stopped honoring
 * `tools`, which is the only scenario this list exists for.
 */
export const DISALLOWED_TOOLS = [
  // Delegation, scheduling, and reaching other agents.
  "Agent",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "TaskStop",
  "Workflow",
  "ToolSearch",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "RemoteTrigger",
  "SendMessage",
  "EndConversation",
  // Shell and process control.
  "Bash",
  "BashOutput",
  "KillShell",
  "Monitor",
  // Mutation, including the worktree tools a write would reach for.
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "TodoWrite",
  "EnterWorktree",
  "ExitWorktree",
  // Network, and anything that publishes or notifies outward.
  "WebFetch",
  "WebSearch",
  "Artifact",
  "ShareOnboardingGuide",
  "PushNotification",
  "DesignSync",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "ReadMcpResourceDirTool",
  // Anything that runs instructions from elsewhere, or blocks on a human who
  // is not there.
  "Skill",
  "SlashCommand",
  "AskUserQuestion",
] as const;

/** Ceiling on how many agentic turns one delegation may take. */
const DEFAULT_MAX_TURNS = 30;

/**
 * Cost ceiling for one delegation, in USD.
 *
 * There is a default rather than "unlimited unless configured" because the
 * system prompt makes a delegation mandatory for every Slack message, and
 * `executionMode: "sequential"` only serializes within one session — concurrent
 * threads each get their own subprocess. An unconfigured deployment needs a
 * backstop, and a typical investigation costs orders of magnitude less than
 * this. Set PI_CHAT_CLAUDE_MAX_BUDGET_USD to raise it, or to `off` to remove it.
 */
const DEFAULT_MAX_BUDGET_USD = 5;

/**
 * Wall-clock ceiling on one delegation.
 *
 * `maxTurns` and `maxBudgetUsd` are enforced CLI-side and only bite while the
 * session is making progress; neither helps against a subprocess that stalls
 * without emitting a result. Draining the stream is the only exit from
 * `execute`, so without this a wedged child holds the Slack turn open forever.
 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Model for delegations, as an alias rather than a pinned id so it tracks the
 * current generation as the CLI updates. Claude Code resolves `sonnet` itself.
 */
const DEFAULT_MODEL = "sonnet";

/**
 * Reasoning depth for delegations.
 *
 * Claude Code's own default is `high`. This bot delegates on every cross-file
 * support question, and the investigator system prompt already pushes hard
 * toward exhaustive tracing, so `medium` is the better trade here — deep
 * reasoning on every Slack question is not worth what it costs.
 */
const DEFAULT_EFFORT: EffortLevel = "medium";

const EFFORT_LEVELS: ReadonlySet<string> = new Set<EffortLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * How long a cancelled run waits for its stream to end before giving up on it.
 *
 * Cancellation asks the SDK to close, which normally ends the stream well inside
 * this. But draining is the only exit from `execute`, so a transport that never
 * settles would otherwise leave the pi turn waiting forever on a run whose
 * answer is already discarded.
 */
const ABORT_TEARDOWN_GRACE_MS = 5_000;

/** Cap on captured child stderr, so a noisy retry loop cannot grow it forever. */
const MAX_STDERR_BYTES = 8 * 1024;

const SYSTEM_PROMPT = `You are a read-only investigator working inside a codebase on behalf of another agent.

You can only read, search, and list files. You cannot run commands, edit anything, browse the web, or delegate to another agent. Do not offer to do those things or describe them as next steps.

Investigate thoroughly before answering:
- Finding one matching snippet is a lead, not a conclusion. Never answer a behaviour question from a single file.
- For any "what happens when X" question, inspect every relevant state transition: the path that enters the state, the path that exits it, and the path that triggers the behaviour itself. Skipping the exit path is the most common cause of a wrong answer.
- Before giving any negative answer, open the code that would perform the thing you are saying does not happen and confirm the absence directly. Do not infer absence from a guard in an unrelated file.
- Follow the call graph outward from any key function, and search across layers: controllers, services, workers, schedulers, and event handlers.

Answer with what the code shows, citing the paths you actually opened. State plainly which parts you verified and which you did not. A hedged correct answer is better than a confident wrong one.`;

interface ClaudeParams {
  prompt: string;
}

export interface ClaudeToolCall {
  name: string;
  /** Raw tool input, kept so the renderer can format it the way pi does. */
  args: Record<string, unknown>;
}

export interface ClaudeUsage {
  turns?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

export interface ClaudeDetails {
  prompt: string;
  sessionId?: string;
  durationMs?: number;
  model?: string;
  effort?: EffortLevel;
  usage: ClaudeUsage;
  toolCalls: ClaudeToolCall[];
  /**
   * Tools the sandbox refused. Worth recording rather than dropping: a session
   * repeatedly denied is one whose answer may be incomplete, and it is the
   * signal that shows whether the confinement is doing anything.
   */
  deniedTools: string[];
  truncated: boolean;
  /** Set while the run is still streaming, for the partial render. */
  running?: boolean;
  errorMessage?: string;
}

// ── Project directory and output shaping ─────────────────────────────────────

export function truncateText(
  text: string,
  maxBytes = 50 * 1024,
): {
  text: string;
  truncated: boolean;
} {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  // Cut on a UTF-8 character boundary: walk back off any continuation byte
  // (0b10xxxxxx) so the last character is kept whole rather than decoded as
  // U+FFFD. Trimming by JS code units instead would be quadratic on multi-byte
  // text, and could leave a lone surrogate from a split emoji.
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  const truncated = encoded.subarray(0, end).toString("utf8");

  return {
    text: `${truncated}\n\n[claude output truncated to ${maxBytes} bytes. Ask claude a narrower question for a smaller answer.]`,
    truncated: true,
  };
}

function appendStderr(current: string, chunk: string): string {
  if (current.length >= MAX_STDERR_BYTES) return current;
  return (current + chunk).slice(0, MAX_STDERR_BYTES);
}

// ── CLI binary discovery ─────────────────────────────────────────────────────

/**
 * The packages the SDK looks in for its CLI binary. Mirrors the resolution
 * `query()` performs, because the binary is not part of the SDK package: it
 * ships in a per-platform optional dependency, which an install can be missing
 * — a platform with no prebuilt, or `npm install --omit=optional` — while the
 * SDK itself imports fine.
 *
 * The order matters because the winner is handed to the SDK as
 * `pathToClaudeCodeExecutable`: on Linux the two builds link against different
 * libc implementations, and a musl binary launched on a glibc host fails for
 * want of its dynamic loader. {@link preferMusl} mirrors the SDK's own probe.
 */
export function claudeBinaryCandidates(
  platform: string = process.platform,
  arch: string = process.arch,
  musl: boolean = preferMusl(platform),
): string[] {
  const binary = platform === "win32" ? "claude.exe" : "claude";
  const glibcPackage = `${SDK_PACKAGE}-linux-${arch}`;
  const muslPackage = `${SDK_PACKAGE}-linux-${arch}-musl`;
  const packages =
    platform === "android"
      ? [`${SDK_PACKAGE}-linux-${arch}-android`]
      : platform === "linux"
        ? musl
          ? [muslPackage, glibcPackage]
          : [glibcPackage, muslPackage]
        : [`${SDK_PACKAGE}-${platform}-${arch}`];
  return packages.map((name) => `${name}/${binary}`);
}

/**
 * Whether this host is musl-based, detected the way the SDK detects it: a glibc
 * runtime reports its version in the process report, and musl does not.
 */
export function preferMusl(platform: string = process.platform): boolean {
  if (platform !== "linux") return false;
  const report =
    typeof process.report?.getReport === "function"
      ? (process.report.getReport() as {
          header?: { glibcVersionRuntime?: string };
        })
      : undefined;
  return report != null && report.header?.glibcVersionRuntime === undefined;
}

/**
 * Path to the CLI the SDK drives, or undefined when it is not installed.
 *
 * Resolution starts from the SDK's own location, as the SDK's does, so a nested
 * install is found where resolving from this file would miss it.
 */
export function findClaudeBinary(
  resolve: (specifier: string, from?: string) => string = (specifier, from) =>
    createRequire(from ?? import.meta.url).resolve(specifier),
  exists: (filePath: string) => boolean = fs.existsSync,
  candidates: readonly string[] = claudeBinaryCandidates(),
): string | undefined {
  let sdkPath: string;
  try {
    sdkPath = resolve(SDK_PACKAGE);
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    try {
      const binaryPath = resolve(candidate, sdkPath);
      if (exists(binaryPath)) return binaryPath;
    } catch {
      /* this platform package is not installed */
    }
  }
  return undefined;
}

// ── SDK options ──────────────────────────────────────────────────────────────

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Reasoning depth for a delegation, falling back to {@link DEFAULT_EFFORT} for
 * anything unrecognized — an unusable value must not silently disable the knob.
 *
 * Read from PI_CHAT_CLAUDE_EFFORT. The prefix is what keeps it distinct from
 * CLAUDE_EFFORT, which is not ours to consume: Claude Code *exports* that name
 * to its hook commands and Bash children to tell them the level it picked, so
 * an unprefixed read would mean a pi-chat started from inside a Claude Code
 * session silently adopted the outer session's effort.
 *
 * Note `xhigh` and `max` are model-gated: on a model that does not support the
 * level the CLI silently downgrades it, so setting one is a request, not a
 * guarantee.
 */
export function resolveEffort(value: string | undefined): EffortLevel {
  const level = value?.trim().toLowerCase();
  return level && EFFORT_LEVELS.has(level)
    ? (level as EffortLevel)
    : DEFAULT_EFFORT;
}

/**
 * Cost ceiling for one delegation, or undefined for none.
 *
 * Unlike the other knobs this one can be turned off outright, because the sane
 * default is a limit and the escape hatch has to be explicit rather than a
 * value that happens to parse as falsy.
 */
export function resolveMaxBudgetUsd(
  value: string | undefined,
): number | undefined {
  const raw = value?.trim().toLowerCase();
  if (raw === "off" || raw === "none") return undefined;
  return positiveInt(value) ?? DEFAULT_MAX_BUDGET_USD;
}

/** Wall-clock ceiling for one delegation, in milliseconds. */
export function resolveTimeoutMs(value: string | undefined): number {
  return positiveInt(value) ?? DEFAULT_TIMEOUT_MS;
}

/**
 * Deny anything outside the read-only set, and anything that only reached us
 * because it touched a path outside the project directory.
 *
 * `allowedTools` is deliberately never set, because a tool named there is
 * auto-approved and skips this handler entirely. Routing everything here is
 * what makes `blockedPath` usable: `Read` is a permitted tool, but a `Read`
 * the CLI itself flagged as out of bounds arrives with `blockedPath` set.
 *
 * This is a backstop, not the path guard. Reads are auto-approved under
 * `permissionMode: "default"` and never reach a permission prompt at all, so
 * confinement is enforced by {@link createPathGuardHook}, which runs earlier.
 */
export function createCanUseTool(cwd: string): CanUseTool {
  return async (toolName, _input, { blockedPath }) => {
    if (blockedPath) {
      return {
        behavior: "deny",
        message: `Reading outside ${cwd} is not permitted.`,
      };
    }
    if (!READ_ONLY_TOOL_SET.has(toolName)) {
      return {
        behavior: "deny",
        message: `${toolName} is not available to this read-only session.`,
      };
    }
    return { behavior: "allow" };
  };
}

// ── Path confinement ─────────────────────────────────────────────────────────

/**
 * Which input keys name a filesystem target, per tool.
 *
 * This has to be per-tool because `pattern` means opposite things either side
 * of it. For `Glob` it is a path expression — `/Users/**` reaches outside the
 * project without ever setting `path`, and so does `../../**` — so it is
 * checked like any other path. For `Grep` it is a regular expression, and
 * treating it as a path would deny a search for a literal `/api/v1/users`,
 * quietly taking away the investigator's main tool for exactly the strings a
 * support question is about.
 */
const TOOL_PATH_KEYS: Record<string, readonly string[]> = {
  Read: ["file_path", "notebook_path"],
  Glob: ["pattern", "path"],
  // `glob` filters the names ripgrep walked; it cannot widen the search root.
  Grep: ["path"],
};

/**
 * Keys checked for a tool this list does not know, which means a CLI that
 * widened its base set. Every candidate is treated as a path: a false positive
 * denies a tool that three other layers already deny, a false negative is a way
 * out of the project directory.
 */
const FALLBACK_PATH_KEYS = ["file_path", "path", "notebook_path", "pattern"];

/** Expand a leading `~`, which `path.resolve` does not treat as HOME. */
function expandHome(target: string): string {
  if (target === "~") return process.env.HOME ?? target;
  if (target.startsWith("~/"))
    return path.join(process.env.HOME ?? "~", target.slice(2));
  return target;
}

/**
 * Canonicalize a path for comparison, resolving symlinks.
 *
 * A target that does not exist yet has no realpath, so the nearest existing
 * ancestor is canonicalized instead and the remainder appended. Without this a
 * symlinked project directory (or macOS's `/tmp` -> `/private/tmp`) would make
 * every in-project path look like an escape.
 */
function canonicalize(target: string): string {
  let current = path.resolve(target);
  const trailing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Whether a tool argument stays inside the project directory.
 *
 * Both sides are canonicalized so a symlink cannot be used to step outside, and
 * the separator check is what stops `/srv/project-secrets` from passing as a
 * prefix match on `/srv/project`.
 */
export function isPathWithin(cwd: string, target: string): boolean {
  const root = canonicalize(cwd);
  const resolved = canonicalize(path.resolve(root, expandHome(target)));
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Every path-like argument in a tool input, in the order they were found.
 *
 * Relative values are returned along with absolute ones. They resolve against
 * cwd, which is not the same as staying under it: `../../**` is relative and
 * still walks out of the project.
 */
export function extractPaths(input: unknown, toolName?: string): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const keys = (toolName && TOOL_PATH_KEYS[toolName]) || FALLBACK_PATH_KEYS;
  const found: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    found.push(value);
  }
  return found;
}

/**
 * Deny any tool call naming a path outside the project directory.
 *
 * This is a `PreToolUse` hook rather than part of `canUseTool` because reads are
 * auto-approved under `permissionMode: "default"` and never reach the permission
 * prompt — a smoke test confirmed an unguarded session happily reads
 * `~/.ssh/id_rsa` and `~/.claude/.credentials.json`. `PreToolUse` runs before
 * that auto-approval, so it is the only gate the read path cannot skip.
 */
export function createPathGuardHook(cwd: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    for (const target of extractPaths(input.tool_input, input.tool_name)) {
      if (isPathWithin(cwd, target)) continue;
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: `${target} is outside the project directory. This session may only read files under ${cwd}.`,
        },
      };
    }
    return {};
  };
}

/**
 * The prefix on every environment variable this application reads.
 *
 * One prefix is the whole reason the names are what they are. It means a
 * configuration variable added later is withheld from the delegated session by
 * construction, rather than by someone remembering to add it to a list — and
 * the child is the part of this system that reads attacker-influenceable text.
 * One that cannot exfiltrate a secret can still recite it into the answer pi
 * relays back to Slack.
 */
export const ENV_PREFIX = "PI_CHAT_";

/**
 * process.env minus this application's own configuration.
 *
 * Everything else is inherited on purpose: HOME, PATH, and the keychain access
 * the CLI needs to run at all, plus the `ANTHROPIC_*` and `CLAUDE_CODE_*`
 * family, which is its own authentication surface — a host that logs in that
 * way would stop working without them.
 */
export function delegatedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const delegated: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(ENV_PREFIX)) continue;
    delegated[key] = value;
  }
  return delegated;
}

export interface BuildClaudeOptionsInput {
  cwd?: string;
  abortController?: AbortController;
  onStderr?: (data: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Resolved CLI path, so the SDK does not repeat the same lookup. */
  executablePath?: string;
}

export function buildClaudeOptions({
  cwd = projectCwd(),
  abortController,
  onStderr,
  env = process.env,
  executablePath,
}: BuildClaudeOptionsInput = {}): ClaudeOptions {
  const model = env.PI_CHAT_CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
  const effort = resolveEffort(env.PI_CHAT_CLAUDE_EFFORT);
  const maxTurns =
    positiveInt(env.PI_CHAT_CLAUDE_MAX_TURNS) ?? DEFAULT_MAX_TURNS;
  const maxBudgetUsd = resolveMaxBudgetUsd(env.PI_CHAT_CLAUDE_MAX_BUDGET_USD);

  return {
    cwd,
    // Replacing the preset also drops the environment context it supplies,
    // which leaves the agent unable to say where it is. State the directory so
    // relative paths resolve. JSON-encoded because the path is data: a checkout
    // name someone else chose could otherwise land as its own system-level line.
    systemPrompt: `${SYSTEM_PROMPT}\n\nYour working directory is this JSON-encoded path: ${JSON.stringify(cwd)}. Resolve relative paths against it.`,

    // Layer 1: the base tool set — what exists at all.
    tools: [...READ_ONLY_TOOLS],
    // Layer 2: still denied even if a future CLI widens its base set.
    disallowedTools: [...DISALLOWED_TOOLS],
    // Layer 3: never bypass. A delegated session has nobody to ask, so anything
    // that would prompt is refused rather than waved through.
    permissionMode: "default",
    // Layer 4: confine every path argument to the project directory. This is
    // the layer that actually scopes reads: they are auto-approved and never
    // reach a permission prompt, so a hook running before that approval is the
    // only gate they cannot skip — see createPathGuardHook.
    hooks: { PreToolUse: [{ hooks: [createPathGuardHook(cwd)] }] },
    // Layer 5: the final gate, for anything that still reaches a prompt. Note
    // `allowedTools` is intentionally absent — see createCanUseTool.
    canUseTool: createCanUseTool(cwd),

    // Nothing from disk. `[]` is the SDK's isolation mode: no settings.json, no
    // CLAUDE.md, no filesystem-defined hooks, agents, or skills. Authentication
    // is unaffected — the CLI reads its own credential store, not settings.
    settingSources: [],
    // A .mcp.json entry is itself a command to launch, so ignore project MCP
    // config and pass none of our own.
    mcpServers: {},
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    // Omitting `skills` is not "skills off" — the CLI's own defaults still
    // apply — so it is set explicitly.
    skills: [],

    // Grant no directory beyond cwd. This is already the default, and it is not
    // what scopes reads — layer 4 is. It is set so that widening the session
    // later is a deliberate edit here rather than an omission.
    additionalDirectories: [],
    // No transcript under ~/.claude/projects.
    persistSession: false,

    // Runaway guards, on top of the wall-clock timeout runClaude applies.
    maxTurns,
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),

    model,
    effort,

    ...(abortController ? { abortController } : {}),
    ...(onStderr ? { stderr: onStderr } : {}),
    // Skip the SDK's own binary lookup when the caller already did it.
    ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}),

    // The SDK REPLACES the subprocess environment with this value rather than
    // merging it, so it is spread from the parent's — dropping HOME, PATH, or
    // the keychain access would leave the CLI unable to authenticate. What the
    // spread leaves out is the point: see delegatedEnv.
    env: delegatedEnv(env),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────
//
// Mirrors the pi-subagent renderer so a delegated run reads the same way as any
// other subagent row: an arrow-prefixed tool call list, a usage stats line, and
// an expand hint when collapsed.

/** The row renderer prepends this, so reserve its columns when truncating. */
export const TOOL_CALL_ARROW_PREFIX = "→ ";

/** How many tool calls the collapsed view shows before summarising the rest. */
export const COLLAPSED_ITEM_COUNT = 10;

const COLLAPSED_TOOL_CALL_WIDTH = 72;

/** Collapse control characters to spaces so one argument cannot break the row. */
function sanitizeInlineText(value: string): string {
  let sanitized = "";
  let replacedPrevious = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029;
    if (isControl) {
      if (!replacedPrevious) sanitized += " ";
      replacedPrevious = true;
    } else {
      sanitized += character;
      replacedPrevious = false;
    }
  }
  return sanitized;
}

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatDuration(milliseconds: number): string {
  const clamped = Math.max(0, milliseconds);
  const tenths = Math.round(clamped / 100);
  if (tenths < 60 * 10) return `${(tenths / 10).toFixed(1)}s`;

  const wholeSeconds = Math.round(clamped / 1000);
  if (wholeSeconds < 60 * 60) {
    return `${Math.floor(wholeSeconds / 60)}m ${wholeSeconds % 60}s`;
  }
  const hours = Math.floor(wholeSeconds / (60 * 60));
  return `${hours}h ${Math.floor((wholeSeconds % (60 * 60)) / 60)}m`;
}

/** Compact one-line accounting: turns, tokens, cost, model, effort. */
export function formatUsageStats(details: ClaudeDetails): string {
  const { usage } = details;
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (details.model) parts.push(details.model);
  if (details.effort) parts.push(`effort:${details.effort}`);
  return parts.join(" ");
}

/** Status suffix: `[running for 4.2s]`, `[completed in 12.1s]`, `[failed]`. */
export function formatLifecycleStatus(details: ClaudeDetails): string {
  const duration =
    details.durationMs !== undefined && Number.isFinite(details.durationMs)
      ? formatDuration(details.durationMs)
      : undefined;
  if (details.running) return duration ? `running for ${duration}` : "running";
  if (details.errorMessage)
    return duration ? `failed after ${duration}` : "failed";
  return duration ? `completed in ${duration}` : "completed";
}

/**
 * One tool call as a line. The delegated session only ever calls Read, Grep, and
 * Glob, but an unrecognized name still renders rather than disappearing.
 */
export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  collapsed: boolean,
): string {
  const home = process.env.HOME;
  const shorten = (p: string) =>
    home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  const str = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value) return sanitizeInlineText(value);
    }
    return undefined;
  };

  const name = sanitizeInlineText(toolName).toLowerCase();
  let line: string;
  switch (name) {
    case "read": {
      const target = shorten(str("file_path", "path") ?? "...");
      const offset = typeof args.offset === "number" ? args.offset : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      let range = "";
      if (offset !== undefined || limit !== undefined) {
        const start = offset ?? 1;
        range = `:${start}${limit !== undefined ? `-${start + limit - 1}` : ""}`;
      }
      line = `read ${target}${range}`;
      break;
    }
    case "grep": {
      const pattern = str("pattern") ?? "...";
      const scope = str("path", "glob");
      line = `grep ${pattern}${scope ? ` in ${shorten(scope)}` : ""}`;
      break;
    }
    case "glob": {
      const pattern = str("pattern") ?? "...";
      const scope = str("path");
      line = `glob ${pattern}${scope ? ` in ${shorten(scope)}` : ""}`;
      break;
    }
    default:
      line =
        `${sanitizeInlineText(toolName)} ${str(...Object.keys(args)) ?? ""}`.trim();
  }

  if (!collapsed) return line;
  const width = COLLAPSED_TOOL_CALL_WIDTH - TOOL_CALL_ARROW_PREFIX.length;
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

// ── Run ──────────────────────────────────────────────────────────────────────

function resultFailureMessage(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success") {
    const errors = result.errors.filter((error) => error.trim()).join("\n");
    return (
      errors || result.stop_reason || `Claude Code ended with ${result.subtype}`
    );
  }
  // `subtype: "success"` and `is_error: true` coexist — the subtype says the
  // session reached a result, the flag says that result is a failure, whose
  // text (an API error such as a rate limit) lands in `result`. Ignoring the
  // flag would hand "Rate limit exceeded" back as an answer.
  if (result.is_error) {
    return result.result.trim() || "Claude Code reported an error";
  }
  return undefined;
}

type ClaudeUpdate = (partial: {
  content: { type: "text"; text: string }[];
  details: ClaudeDetails;
}) => void;

/**
 * The slice of the SDK's `Query` this file uses.
 *
 * Narrowed to an injection seam: the real `query` spawns a subprocess, so
 * without it the abort race, the teardown deadline, and the result-to-error
 * mapping — the riskiest code here — could only be exercised by running the
 * CLI for real.
 */
export type ClaudeStream = AsyncIterable<SDKMessage> & { close: () => void };

export type ClaudeQuery = (params: {
  prompt: string;
  options: ClaudeOptions;
}) => ClaudeStream;

export interface RunClaudeDeps {
  query?: ClaudeQuery;
  findBinary?: () => string | undefined;
  timeoutMs?: number;
}

export async function runClaude(
  prompt: string,
  signal: AbortSignal | undefined,
  onUpdate: ClaudeUpdate | undefined,
  deps: RunClaudeDeps = {},
): Promise<{ text: string; details: ClaudeDetails }> {
  const startQuery = deps.query ?? (query as ClaudeQuery);
  const findBinary = deps.findBinary ?? findClaudeBinary;
  const timeoutMs =
    deps.timeoutMs ?? resolveTimeoutMs(process.env.PI_CHAT_CLAUDE_TIMEOUT_MS);

  const task = prompt.trim();
  if (!task) throw new Error("prompt is required");

  const executablePath = findBinary();
  if (!executablePath) {
    throw new Error(
      `The Claude Code CLI could not be found. It ships in a per-platform optional dependency of ${SDK_PACKAGE} (${claudeBinaryCandidates().join(", ")}); reinstall dependencies without --omit=optional to restore it.`,
    );
  }

  if (signal?.aborted) throw new Error("claude was aborted");

  const cwd = projectCwd();
  const abortController = new AbortController();
  const toolCalls: ClaudeToolCall[] = [];
  const seenFrames = new Set<string>();
  const countedResponses = new Set<string>();
  const startedAt = Date.now();
  let liveUsage: ClaudeUsage = {};
  let stderr = "";
  let assistantText = "";
  let resultMessage: SDKResultMessage | undefined;
  let wasAborted = false;

  const options = buildClaudeOptions({
    cwd,
    abortController,
    executablePath,
    onStderr: (data) => {
      stderr = appendStderr(stderr, data);
    },
  });
  const model = options.model;
  const effort = options.effort;

  /**
   * The run so far, as a self-contained value.
   *
   * Everything mutable is copied. `liveUsage` in particular is reassigned and
   * mutated as later frames arrive, so handing it out by reference would let a
   * partial the renderer already published change underneath it.
   */
  const snapshot = (overrides: Partial<ClaudeDetails> = {}): ClaudeDetails => ({
    prompt: task,
    model,
    effort,
    usage: { ...liveUsage },
    toolCalls: [...toolCalls],
    deniedTools: [],
    truncated: false,
    durationMs: Date.now() - startedAt,
    ...overrides,
  });

  /**
   * Report a failed run before throwing.
   *
   * The last partial this tool emitted said `running: true`, and pi replaces a
   * throwing tool's details with `{}` — so without a closing update the run's
   * final recorded state is one that never stopped running.
   */
  const reportFailure = (message: string): Error => {
    onUpdate?.({
      content: [{ type: "text", text: message }],
      details: snapshot({ running: false, errorMessage: message }),
    });
    return new Error(message);
  };

  const stream = startQuery({ prompt: task, options });

  // A deadline that only exists once an abort has landed. A healthy run may
  // legitimately go quiet for longer than the grace — a large search, a slow
  // read — so arming it unconditionally would cut off work that was going fine.
  let teardownTimer: ReturnType<typeof setTimeout> | undefined;
  let armTeardownDeadline = (): void => {};
  const teardownDeadline = new Promise<void>((resolve) => {
    armTeardownDeadline = () => {
      if (teardownTimer) return;
      teardownTimer = setTimeout(resolve, ABORT_TEARDOWN_GRACE_MS);
      teardownTimer.unref?.();
    };
  });

  const abort = () => {
    wasAborted = true;
    abortController.abort();
    stream.close();
    armTeardownDeadline();
  };

  if (signal) {
    signal.addEventListener("abort", abort, { once: true });
    // A cancellation that landed while query() was setting the run up fired
    // before there was a listener to hear it, and addEventListener does not
    // replay it on an already-aborted signal. `abort` is idempotent.
    if (signal.aborted) abort();
  }

  // The wall-clock ceiling. Cancelling through `abort` rather than racing the
  // drain directly is what makes the child actually go away: the teardown grace
  // it arms is the fallback for a transport that ignores the close.
  let timedOut = false;
  const runTimer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  runTimer.unref?.();

  const drained = (async () => {
    for await (const message of stream as AsyncIterable<SDKMessage>) {
      // Closing the stream does not empty it: frames already queued when the
      // abort landed still arrive, and applying them would record output
      // produced after cancellation on a run whose answer is discarded.
      if (wasAborted) break;

      // Sidechain traffic belongs to a nested agent with its own context. Inert
      // as things stand — no allowed tool can start one — but keeping it out
      // means a nested agent's text can never be mistaken for this run's answer.
      if (
        "parent_tool_use_id" in message &&
        message.parent_tool_use_id != null
      ) {
        continue;
      }

      if (message.type === "result") {
        resultMessage = message;
        continue;
      }

      if (message.type !== "assistant") continue;

      // The CLI emits one frame per content block, each repeating the same
      // message.id, so identity has to come from the per-frame uuid.
      if (seenFrames.has(message.uuid)) continue;
      seenFrames.add(message.uuid);

      // Usage repeats across the frames of one response, so take rather than
      // accumulate it — the running figures are only for the partial render.
      const usage = message.message.usage;
      if (usage) {
        liveUsage = {
          turns: liveUsage.turns,
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        };
      }
      if (!countedResponses.has(message.message.id)) {
        countedResponses.add(message.message.id);
        liveUsage.turns = countedResponses.size;
      }

      for (const block of message.message.content) {
        if (block.type === "text") {
          assistantText += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            name: block.name,
            args: (block.input ?? {}) as Record<string, unknown>,
          });
          const details = snapshot({ running: true });
          onUpdate?.({
            content: [
              {
                type: "text",
                text:
                  TOOL_CALL_ARROW_PREFIX +
                  formatToolCall(
                    block.name,
                    details.toolCalls.at(-1)?.args ?? {},
                    true,
                  ),
              },
            ],
            details,
          });
        }
      }
    }
  })().catch((cause: unknown) => {
    // Handled here rather than around the await: a drain the deadline abandoned
    // would otherwise reject with nobody listening, and an unhandled rejection
    // takes down the process over a run already reported.
    if (!wasAborted && !resultMessage) {
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  });

  try {
    await Promise.race([drained, teardownDeadline]);
  } finally {
    clearTimeout(runTimer);
    clearTimeout(teardownTimer);
    signal?.removeEventListener("abort", abort);
    stream.close();
  }

  // Checked before `wasAborted`, which the timeout sets on its way through.
  if (timedOut) {
    throw reportFailure(
      `claude timed out after ${formatDuration(timeoutMs)}. Raise PI_CHAT_CLAUDE_TIMEOUT_MS, or ask a narrower question.`,
    );
  }

  if (wasAborted) throw new Error("claude was aborted");

  if (!resultMessage) {
    throw reportFailure(
      `Claude Code ended without reporting a result. ${stderr.trim() || "No further detail was available."}`,
    );
  }

  const failure = resultFailureMessage(resultMessage);
  if (failure) throw reportFailure(failure);

  // The SDK's own `result` is the authoritative final answer; accumulated
  // assistant text is the fallback for a run that reported none.
  const finalText =
    (resultMessage.subtype === "success" ? resultMessage.result.trim() : "") ||
    assistantText.trim();
  if (!finalText) throw reportFailure("claude returned no output");

  const truncated = truncateText(finalText);
  const finalUsage = resultMessage.usage;
  return {
    text: truncated.text,
    details: {
      prompt: task,
      sessionId: resultMessage.session_id,
      durationMs: resultMessage.duration_ms,
      model,
      effort,
      usage: {
        turns: resultMessage.num_turns,
        input: finalUsage?.input_tokens ?? 0,
        output: finalUsage?.output_tokens ?? 0,
        cacheRead: finalUsage?.cache_read_input_tokens ?? 0,
        cacheWrite: finalUsage?.cache_creation_input_tokens ?? 0,
        cost: resultMessage.total_cost_usd,
      },
      toolCalls,
      deniedTools: resultMessage.permission_denials.map(
        (denial) => denial.tool_name,
      ),
      truncated: truncated.truncated,
    },
  };
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "claude",
    label: "Claude",
    description:
      "Delegate a deep, read-only codebase investigation to Claude Code. Claude can only read, grep, and glob files under the project directory — it cannot run commands, edit files, access the network, or spawn subagents. Returns its final written answer.",
    promptSnippet:
      "Delegate a multi-file, read-only codebase investigation to Claude Code",
    promptGuidelines: [
      "Use claude for investigations that need tracing across many files — call graphs, state transitions, or 'what happens when X' questions — rather than many read/grep round trips.",
      "Give claude a self-contained task: what to find out, which behaviour matters, and what a complete answer must cover. It cannot see the conversation.",
      "Delegate any question about behaviour, features, or how the product works, including one that looks like a single-file lookup. Use read, grep, find, and ls only to confirm a specific detail claude reported, or for a trivial lookup that needs no investigation.",
      "Restate claude's findings in your own words. Never pass its raw output, file paths, or class names straight through to the user.",
    ],
    // One claude subprocess at a time; tool calls otherwise run in parallel.
    executionMode: "sequential",
    parameters: Type.Object({
      prompt: Type.String({
        description:
          "Self-contained investigation task for Claude. State the question, the behaviour that matters, and what a complete answer must cover. Claude sees only this text and the project files.",
      }),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await runClaude(
        (params as ClaudeParams).prompt,
        signal,
        onUpdate,
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },

    renderCall(args, theme, context) {
      const prompt = String((args as ClaudeParams).prompt ?? "");
      // Expanded shows the whole task; collapsed shows just enough to know what
      // was asked, since a delegation prompt is deliberately several lines long.
      const preview = context.expanded
        ? prompt
        : prompt.split("\n").slice(0, 3).join("\n");
      return new Text(
        `${theme.fg("toolTitle", theme.bold("claude"))}\n${theme.fg("dim", preview)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as ClaudeDetails | undefined;
      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";
      // pi's own verdict comes first: a delegation that threw is reported as an
      // error by the framework, and arrives here with `details` replaced by an
      // empty object, so the tool's own errorMessage is not always there to
      // read.
      const isError = context.isError || Boolean(details?.errorMessage);

      if (!details || !("toolCalls" in details)) {
        if (isError) {
          return new Text(
            `${theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold("claude"))} ${theme.fg("error", "[failed]")}\n${theme.fg("error", body || "(no detail)")}`,
            0,
            0,
          );
        }
        return new Text(body || "(no output)", 0, 0);
      }

      const running = !isError && (isPartial || Boolean(details.running));
      const errorText = details.errorMessage || body || "(no detail)";
      const icon = running
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");

      const lifecycle = `[${formatLifecycleStatus({
        ...details,
        running,
        ...(isError ? { errorMessage: errorText } : {}),
      })}]`;
      let header = `${icon} ${theme.fg("toolTitle", theme.bold("claude"))} `;
      header += running
        ? theme.fg("warning", lifecycle)
        : isError
          ? theme.fg("error", lifecycle)
          : theme.fg("success", lifecycle);
      if (details.deniedTools.length > 0) {
        header += ` ${theme.fg("warning", `[${details.deniedTools.length} denied]`)}`;
      }

      const usageStr = formatUsageStats(details);
      const emptyOutput = running ? "(running...)" : "(no output)";

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));

        if (isError) {
          container.addChild(
            new Text(theme.fg("error", `Error: ${errorText}`), 0, 0),
          );
        }

        if (details.toolCalls.length > 0) {
          container.addChild(new Spacer(1));
          for (const call of details.toolCalls) {
            container.addChild(
              new Text(
                theme.fg("muted", TOOL_CALL_ARROW_PREFIX) +
                  theme.fg(
                    "toolOutput",
                    formatToolCall(call.name, call.args, false),
                  ),
                0,
                0,
              ),
            );
          }
        }

        container.addChild(new Spacer(1));
        if (body) {
          container.addChild(
            new Markdown(body.trim(), 0, 0, getMarkdownTheme()),
          );
        } else {
          container.addChild(new Text(theme.fg("muted", emptyOutput), 0, 0));
        }

        if (usageStr) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
        }
        return container;
      }

      // Collapsed / running view: the most recent calls, then the stats line.
      let collapsed = header;
      if (isError) {
        collapsed += `\n${theme.fg("error", `Error: ${errorText}`)}`;
      } else if (details.toolCalls.length === 0) {
        collapsed += `\n${theme.fg("muted", emptyOutput)}`;
      } else {
        const shown = details.toolCalls.slice(-COLLAPSED_ITEM_COUNT);
        const skipped = details.toolCalls.length - shown.length;
        if (skipped > 0) {
          collapsed += `\n${theme.fg("muted", `... ${skipped} earlier call${skipped > 1 ? "s" : ""}`)}`;
        }
        for (const call of shown) {
          collapsed +=
            `\n${theme.fg("muted", TOOL_CALL_ARROW_PREFIX)}` +
            theme.fg("toolOutput", formatToolCall(call.name, call.args, true));
        }
      }

      if (usageStr) collapsed += `\n${theme.fg("dim", usageStr)}`;
      collapsed += `\n${theme.fg("dim", `(${keyHint("app.tools.expand", "to expand")})`)}`;

      return new Text(collapsed, 0, 0);
    },
  });
}
