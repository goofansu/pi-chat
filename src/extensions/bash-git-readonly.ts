import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { projectCwd } from "./utils.ts";

const execFileAsync = promisify(execFile);

const ALLOWED_SUBCOMMANDS = new Set(["log", "show"]);

const UNSAFE_TOKEN_PATTERN = /[;&|<>`$()\n\r]/;
const UNSAFE_OPTIONS = new Set(["--output", "-o"]);

interface GitReadonlyParams {
  args: string[];
}

interface GitReadonlyDetails {
  command: string;
  args: string[];
  cwd: string;
  stderr?: string;
  truncated: boolean;
}

export function validateGitReadonlyArgs(args: string[]): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("args must start with an allowed git subcommand");
  }

  const normalized = args.map((arg) => String(arg));
  const [subcommand] = normalized;
  if (!subcommand || subcommand.startsWith("-") || subcommand.includes("/")) {
    throw new Error("args must start with an allowed git subcommand");
  }

  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new Error(`git subcommand '${subcommand}' is not allowed`);
  }

  for (let i = 0; i < normalized.length; i++) {
    const arg = normalized[i];
    if (!arg) throw new Error("Unsafe empty git argument");
    if (UNSAFE_TOKEN_PATTERN.test(arg)) {
      throw new Error(`Unsafe git argument: ${arg}`);
    }

    const [optionName] = arg.split("=", 1);
    if (UNSAFE_OPTIONS.has(optionName)) {
      throw new Error(`Unsafe git option: ${optionName}`);
    }
  }

  return normalized;
}

function truncateText(
  text: string,
  maxBytes = 50 * 1024,
): {
  text: string;
  truncated: boolean;
} {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }

  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) {
    truncated = truncated.slice(0, -1);
  }

  return {
    text: `${truncated}\n\n[git-readonly output truncated to ${maxBytes} bytes. Narrow the git query for more specific output.]`,
    truncated: true,
  };
}

export async function runGitReadonly(
  args: string[],
  signal?: AbortSignal,
): Promise<{ text: string; details: GitReadonlyDetails }> {
  const safeArgs = validateGitReadonlyArgs(args);
  const cwd = projectCwd();

  const { stdout, stderr } = await execFileAsync("git", safeArgs, {
    cwd,
    signal,
    maxBuffer: 1024 * 1024,
  });

  const combined = stderr ? `${stdout}\n\n[stderr]\n${stderr}` : stdout;
  const truncated = truncateText(
    combined || "(git command produced no output)",
  );

  return {
    text: truncated.text,
    details: {
      command: `git ${safeArgs.join(" ")}`,
      args: safeArgs,
      cwd,
      stderr: stderr || undefined,
      truncated: truncated.truncated,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "git-readonly",
    label: "Git Readonly",
    description:
      "Inspect repository history with an allowlisted git log or git show command.",
    promptSnippet: "Inspect repository history with git log or git show",
    promptGuidelines: [
      "Use git-readonly when recent commits or historical changes help answer a project question.",
      "Pass arguments as an array without the leading 'git', for example ['log', '--oneline', '-10'] or ['show', 'HEAD', '--stat'].",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        description:
          "Git arguments without the leading 'git'. Must start with log or show. Examples: ['log','--oneline','-10'], ['show','HEAD','--stat'].",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      const result = await runGitReadonly(
        (params as GitReadonlyParams).args,
        signal,
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      const gitArgs = Array.isArray((args as GitReadonlyParams).args)
        ? (args as GitReadonlyParams).args.join(" ")
        : "";
      const preview =
        gitArgs.length > 80 ? `${gitArgs.slice(0, 77)}...` : gitArgs;
      return new Text(
        theme.fg("toolTitle", theme.bold("git-readonly ")) +
          theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const details = result.details as
        | GitReadonlyDetails
        | { error?: string }
        | undefined;
      const isError = Boolean(details && "error" in details && details.error);
      const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
      const title = `${icon} ${theme.fg("toolTitle", theme.bold("git-readonly"))}`;
      const text = result.content[0];
      const body = text?.type === "text" ? text.text : "";

      if (details && "command" in details) {
        return new Text(
          `${title} ${theme.fg("dim", details.command)}\n${theme.fg("muted", body)}`,
          0,
          0,
        );
      }

      return new Text(`${title}\n${body}`, 0, 0);
    },
  });
}
