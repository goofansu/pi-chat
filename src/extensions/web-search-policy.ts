import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_DOMAINS = 20;

function normalizeDomain(value: string): string {
  const candidate = value.trim();
  if (!candidate) throw new Error("web search domains must not be empty");

  let url: URL;
  try {
    url = new URL(
      candidate.includes("://") ? candidate : `https://${candidate}`,
    );
  } catch (error) {
    throw new Error(`Invalid web search domain: ${JSON.stringify(candidate)}`, {
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Web search domain must use HTTP or HTTPS: ${JSON.stringify(candidate)}`,
    );
  }
  if (
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Web search domain must be a hostname without credentials, port, path, query, or fragment: ${JSON.stringify(candidate)}`,
    );
  }

  return url.hostname.toLowerCase();
}

/** Parse the required comma-separated web-search domain allowlist. */
export function parseWebSearchDomains(value: string | undefined): string[] {
  if (!value?.trim()) {
    throw new Error("PI_CHAT_WEB_SEARCH_DOMAINS is required");
  }

  const domains = [...new Set(value.split(",").map(normalizeDomain))];
  if (domains.length > MAX_DOMAINS) {
    throw new Error(
      `PI_CHAT_WEB_SEARCH_DOMAINS accepts at most ${MAX_DOMAINS} domains`,
    );
  }
  return domains;
}

/** Build a Brave inline Goggle that discards everything except the configured sites. */
export function domainAllowlistGoggle(domains: readonly string[]): string {
  return ["$discard", ...domains.map((domain) => `$boost,site=${domain}`)].join(
    "%0A",
  );
}

function sourceIsAllowed(
  value: unknown,
  domains: ReadonlySet<string>,
): boolean {
  if (typeof value !== "string") return false;
  try {
    return domains.has(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Enforce the server-owned allowlist regardless of arguments chosen by the model. */
export function webSearchPolicyExtension(
  domains: readonly string[],
): (pi: ExtensionAPI) => void {
  const goggles =
    domains.length > 0 ? domainAllowlistGoggle(domains) : undefined;
  const allowedDomains = new Set(domains);

  return (pi) => {
    if (!goggles) return;
    const fetchedUrls = new Set<string>();
    pi.on("session_start", () => fetchedUrls.clear());

    pi.on("tool_call", (event) => {
      if (event.toolName === "web_search") {
        event.input.goggles = goggles;
        return;
      }
      if (event.toolName !== "web_fetch") return;
      if (!sourceIsAllowed(event.input.url, allowedDomains)) {
        return {
          block: true,
          reason:
            "web_fetch URL is outside PI_CHAT_WEB_SEARCH_DOMAINS and cannot be fetched",
        };
      }

      const url = new URL(String(event.input.url)).href;
      if (fetchedUrls.has(url)) {
        return {
          block: true,
          reason:
            "This URL was already fetched in the current session. Use the existing result instead of spending another Firecrawl request.",
        };
      }
      fetchedUrls.add(url);
    });

    // Provider-side filtering and redirect handling both need a fail-closed
    // boundary before any unexpected source content reaches the model.
    pi.on("tool_result", (event) => {
      if (event.isError) return;

      if (event.toolName === "web_fetch") {
        const details = event.details as { source_url?: unknown } | undefined;
        if (sourceIsAllowed(details?.source_url, allowedDomains)) return;
        return {
          content: [
            {
              type: "text" as const,
              text: "Web fetch resolved outside the configured domain allowlist; the result was discarded.",
            },
          ],
          details: { source_url: "[discarded]" },
          isError: true,
        };
      }

      if (event.toolName !== "web_search") return;
      const details = event.details as
        | { sources?: Array<{ url?: unknown }> }
        | undefined;
      if (!Array.isArray(details?.sources)) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Web search returned unverifiable source metadata; the result was discarded.",
            },
          ],
          isError: true,
        };
      }

      const rejected = details.sources.find(
        (source) => !sourceIsAllowed(source?.url, allowedDomains),
      );
      if (!rejected) return;

      return {
        content: [
          {
            type: "text" as const,
            text: "Web search returned a source outside the configured domain allowlist; the result was discarded.",
          },
        ],
        details: { ...details, returned_sources: 0, sources: [] },
        isError: true,
      };
    });
  };
}
