/**
 * Web Search Extension — Brave LLM Context grounding for pi.
 *
 * Registers a web-search tool that searches the web using Brave LLM Context and
 * returns extracted page content, snippets, structured data, and sources for
 * grounded answers. The main agent should use it for current information,
 * recent events, external facts, product/docs lookups, or anything that benefits
 * from web grounding. Also provides a /web-search command for direct use.
 *
 * Requires BRAVE_SEARCH_API_KEY from https://api.search.brave.com.
 */

import { StringEnum, Type } from "@mariozechner/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";

const BRAVE_LLM_CONTEXT_ENDPOINT =
  "https://api.search.brave.com/res/v1/llm/context";

interface SearchParams {
  query: string;
  count?: number;
  max_tokens?: number;
  threshold?: "strict" | "balanced" | "lenient";
  goggles?: string;
}

interface SearchSource {
  url: string;
  title?: string;
  hostname?: string;
  age?: unknown;
}

interface BraveGroundingItem {
  url?: string;
  title?: string;
  name?: string;
  snippets?: unknown[];
}

interface BraveApiResponse {
  grounding?: {
    generic?: BraveGroundingItem[];
    map?: BraveGroundingItem[];
    poi?: BraveGroundingItem;
  };
  sources?: Record<
    string,
    { title?: string; hostname?: string; age?: unknown }
  >;
}

interface SearchDetails {
  query: string;
  count: number;
  max_tokens: number;
  threshold: string;
  goggles?: string;
  sources: SearchSource[];
}

function truncateText(text: string, maxBytes = 50 * 1024): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes)
    truncated = truncated.slice(0, -1);
  return `${truncated}\n\n[web-search output truncated to ${maxBytes} bytes. Refine the query or lower max_tokens for a smaller result.]`;
}

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.round(value)
      : fallback;
  return Math.max(min, Math.min(max, n));
}

function extractSources(data: BraveApiResponse): SearchSource[] {
  const sources: SearchSource[] = [];
  const seen = new Set<string>();

  for (const item of data?.grounding?.generic ?? []) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const meta = data?.sources?.[item.url] ?? {};
    sources.push({
      url: item.url,
      title: item.title ?? meta.title,
      hostname: meta.hostname,
      age: meta.age,
    });
  }

  for (const item of data?.grounding?.map ?? []) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    const meta = data?.sources?.[item.url] ?? {};
    sources.push({
      url: item.url,
      title: item.title ?? item.name ?? meta.title,
      hostname: meta.hostname,
      age: meta.age,
    });
  }

  const poi = data?.grounding?.poi;
  if (poi?.url && !seen.has(poi.url)) {
    const meta = data?.sources?.[poi.url] ?? {};
    sources.push({
      url: poi.url,
      title: poi.title ?? poi.name ?? meta.title,
      hostname: meta.hostname,
      age: meta.age,
    });
  }

  return sources;
}

function formatSnippetList(snippets: unknown): string {
  if (!Array.isArray(snippets) || snippets.length === 0) return "";
  return snippets
    .map((snippet) =>
      typeof snippet === "string" ? snippet.trim() : JSON.stringify(snippet),
    )
    .filter(Boolean)
    .map((snippet) => `- ${snippet}`)
    .join("\n");
}

function formatSearchResult(
  data: BraveApiResponse,
  sources: SearchSource[],
): string {
  const parts: string[] = [];
  const generic = data?.grounding?.generic ?? [];

  for (let i = 0; i < generic.length; i++) {
    const item = generic[i];
    if (!item) continue;
    const title = item.title || item.url || `Result ${i + 1}`;
    parts.push(`## ${i + 1}. ${title}\n${item.url ?? ""}`.trim());
    const snippets = formatSnippetList(item.snippets);
    if (snippets) parts.push(snippets);
  }

  const poi = data?.grounding?.poi;
  if (poi) {
    parts.push(
      `## Point of interest: ${poi.name ?? poi.title ?? "Result"}\n${poi.url ?? ""}`.trim(),
    );
    const snippets = formatSnippetList(poi.snippets);
    if (snippets) parts.push(snippets);
  }

  for (const item of data?.grounding?.map ?? []) {
    parts.push(
      `## Map result: ${item.name ?? item.title ?? "Result"}\n${item.url ?? ""}`.trim(),
    );
    const snippets = formatSnippetList(item.snippets);
    if (snippets) parts.push(snippets);
  }

  if (parts.length === 0) return "No web-search results found.";

  const sourceList =
    sources.length > 0
      ? sources
          .map(
            (source, i) =>
              `${i + 1}. ${source.title ?? source.hostname ?? source.url}\n   ${source.url}`,
          )
          .join("\n")
      : "No sources returned.";

  return `${parts.join("\n\n")}\n\n---\n\n## Sources\n${sourceList}`;
}

async function braveLlmContext(
  params: SearchParams,
  signal?: AbortSignal,
): Promise<{ text: string; details: SearchDetails }> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");

  const query = params.query.trim();
  if (!query) throw new Error("query is required");

  const count = clampInt(params.count, 20, 1, 50);
  const maxTokens = clampInt(params.max_tokens, 8192, 1024, 32768);
  const threshold = params.threshold ?? "balanced";
  const goggles = params.goggles?.trim() || undefined;

  const response = await fetch(BRAVE_LLM_CONTEXT_ENDPOINT, {
    method: "POST",
    signal,
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "Content-Type": "application/json",
      "X-Subscription-Token": apiKey,
    },
    body: JSON.stringify({
      q: query,
      count,
      maximum_number_of_urls: count,
      maximum_number_of_tokens: maxTokens,
      context_threshold_mode: threshold,
      ...(goggles ? { goggles } : {}),
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Brave LLM Context failed: ${response.status}${detail ? ` — ${detail.slice(0, 500)}` : ""}`,
    );
  }

  const data = (await response.json()) as BraveApiResponse;
  const sources = extractSources(data);
  return {
    text: truncateText(formatSearchResult(data, sources)),
    details: {
      query,
      count,
      max_tokens: maxTokens,
      threshold,
      goggles,
      sources,
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web-search",
    label: "Web Search",
    description:
      "Search the web with Brave LLM Context. Use when the user asks for current information, recent events, external facts, product/docs lookups, or web-grounded research.",
    promptSnippet:
      "Search the web with Brave LLM Context and return extracted content plus sources",
    promptGuidelines: [
      "Use web-search when the user asks for current information, recent events, external facts, product/docs lookups, or anything that benefits from web grounding.",
      "When using web-search, rewrite the user's request into a concise effective search query before calling the tool, then cite the returned sources in your answer.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description:
          "Required web search query (1-400 characters, max 50 words).",
      }),
      count: Type.Optional(
        Type.Number({
          description:
            "Search results to consider, 1-50. Default: 20. Use 5 for simple factual lookups, 20 for standard queries, and 50 for complex research.",
        }),
      ),
      max_tokens: Type.Optional(
        Type.Number({
          description:
            "Approximate maximum context tokens, 1024-32768. Default: 8192. Use 2048 for simple factual lookups, 8192 for standard queries, and 16384 for complex research.",
        }),
      ),
      threshold: Type.Optional(
        StringEnum(["strict", "balanced", "lenient"] as const, {
          description:
            "Relevance threshold for included content. Default: balanced. Use strict when precision matters more than recall; use lenient when broader coverage is needed.",
        }),
      ),
      goggles: Type.Optional(
        Type.String({
          description:
            "Optional Brave Goggles URL or inline rules for custom ranking/filtering. Use to restrict, boost, downrank, or discard sources when the user asks for specific/authoritative sources. Inline syntax: $boost=N / $downrank=N (1–10), $discard, $site=example.com. Combine with commas: $site=example.com,boost=3. Separate rules with %0A.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const result = await braveLlmContext(params as SearchParams, signal);
      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
      };
    },

    renderCall(args, theme) {
      const query = String((args as SearchParams).query ?? "");
      const preview = query.length > 80 ? `${query.slice(0, 77)}...` : query;
      return new Text(
        theme.fg("toolTitle", theme.bold("web-search ")) +
          theme.fg("dim", preview),
        0,
        0,
      );
    },

    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as
        | SearchDetails
        | { error?: string }
        | undefined;
      const isError = Boolean(details && "error" in details && details.error);
      const icon = isPartial
        ? theme.fg("warning", "⏳")
        : isError
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
      const title = `${icon} ${theme.fg("toolTitle", theme.bold("web-search"))}`;

      if (expanded) {
        const container = new Container();
        container.addChild(
          new Text(
            title + (isError ? ` ${theme.fg("error", "[error]")}` : ""),
            0,
            0,
          ),
        );
        if (details && "query" in details) {
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(theme.fg("muted", `Query: ${details.query}`), 0, 0),
          );
          container.addChild(
            new Text(
              theme.fg(
                "dim",
                `${details.sources.length} source(s), count=${details.count}, max_tokens=${details.max_tokens}, goggles=${details.goggles ? "yes" : "no"}`,
              ),
              0,
              0,
            ),
          );
        }
        container.addChild(new Spacer(1));
        const text = result.content[0];
        container.addChild(
          new Markdown(
            text?.type === "text" ? text.text : "",
            0,
            0,
            getMarkdownTheme(),
          ),
        );
        return container;
      }

      if (details && "query" in details) {
        const sourcePreview = details.sources
          .slice(0, 5)
          .map((source) => `→ ${source.hostname ?? source.title ?? source.url}`)
          .join("\n");
        return new Text(
          `${title} ${theme.fg("dim", `${details.sources.length} source(s)`)}${sourcePreview ? `\n${theme.fg("muted", sourcePreview)}` : ""}\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`,
          0,
          0,
        );
      }

      const text = result.content[0];
      return new Text(
        `${title}\n${text?.type === "text" ? text.text : ""}`,
        0,
        0,
      );
    },
  });

  pi.registerCommand("web-search", {
    description:
      "Search the web with Brave LLM Context; the main agent rewrites the query and calls the web-search tool",
    handler: async (args, ctx: ExtensionContext) => {
      let request = args?.trim() || "";

      if (!request) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /web-search <query>", "error");
          return;
        }

        const input = await ctx.ui.editor("What do you want to search?");
        if (!input?.trim()) {
          ctx.ui.notify("Cancelled", "info");
          return;
        }
        request = input.trim();
      }

      pi.sendUserMessage(`Use the web-search tool to research: ${request}`, {
        deliverAs: "followUp",
      });
    },
  });
}
