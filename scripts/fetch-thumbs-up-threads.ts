import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WebClient } from "@slack/web-api";

/**
 * Fetch Slack parent threads containing at least one message with a native `+1`
 * reaction. Requires `SLACK_BOT_TOKEN` in the environment.
 *
 * Usage:
 *   pnpm fetch-thumbs-up-threads -- --since <date> [--until <date>] [--channel <name-or-id>] [--markdown <path>]
 *
 * Examples:
 *   pnpm fetch-thumbs-up-threads -- --since 2026-04-01
 *   pnpm fetch-thumbs-up-threads -- --since 2026-04-01 --until 2026-04-14 --channel support
 *   pnpm fetch-thumbs-up-threads -- --since 2026-04-01 --channel support --markdown thumbs-up.md
 *
 * `--since` is normalized to 00:00:00 local time, and `--until` is
 * normalized to 23:59:59 local time. Both filter by Slack message timestamp,
 * not reaction timestamp.
 * `--markdown` writes:
 *   ## <parent thread text>
 *
 *   [Open parent thread](<permalink>)
 *
 *   ### Answer
 *
 *   [Open answer in Slack](<message permalink>)
 *
 *   <matched message block text>
 */
interface Args {
	channel?: string;
	markdown?: string;
	since: string;
	until?: string;
}

interface SlackReaction {
	count?: number;
	name?: string;
	users?: string[];
}

interface SlackTextObject {
	text?: string;
}

interface SlackRichTextElement {
	elements?: SlackRichTextElement[];
	name?: string;
	text?: string;
	type?: string;
	url?: string;
	user_id?: string;
}

interface SlackBlock {
	elements?: SlackRichTextElement[];
	rows?: SlackTextObject[][];
	text?: SlackTextObject;
	type?: string;
}

interface SlackMessage {
	blocks?: SlackBlock[];
	reactions?: SlackReaction[];
	reply_count?: number;
	text?: string;
	thread_ts?: string;
	ts?: string;
	user?: string;
	username?: string;
}

interface SlackChannel {
	id: string;
	name: string;
}

interface MatchingThread {
	channel: string;
	channelName: string;
	matchedMessages: {
		blockText?: string;
		permalink?: string;
		reactions: string[];
		text?: string;
		ts: string;
		user?: string;
		userName?: string;
	}[];
	permalink: string;
	question?: string;
	threadTs: string;
}

const THUMBS_UP_REACTION = "+1";

class UserNameCache {
	#names = new Map<string, string>();
	#slack: WebClient;

	constructor(slack: WebClient) {
		this.#slack = slack;
	}

	async get(userId?: string): Promise<string | undefined> {
		if (!userId) return undefined;
		const cachedName = this.#names.get(userId);
		if (cachedName) return cachedName;

		const response = await this.#slack.users.info({ user: userId });
		const user = response.user as
			| {
					name?: string;
					profile?: {
						display_name?: string;
						real_name?: string;
					};
					real_name?: string;
			  }
			| undefined;
		const name =
			user?.profile?.display_name ||
			user?.profile?.real_name ||
			user?.real_name ||
			user?.name;
		if (name) this.#names.set(userId, name);
		return name;
	}
}

function usage(exitCode = 1): never {
	console.error(`Usage:
  pnpm fetch-thumbs-up-threads -- --since <date> [--until <date>] [--channel <name-or-id>] [--markdown <path>]

Examples:
  pnpm fetch-thumbs-up-threads -- --since 2026-04-01
  pnpm fetch-thumbs-up-threads -- --since 2026-04-01 --until 2026-04-14 --channel support
  pnpm fetch-thumbs-up-threads -- --since "2026-04-01T09:00:00+08:00" --channel C1234567890
  pnpm fetch-thumbs-up-threads -- --since 2026-04-01 --channel support --markdown thumbs-up.md`);
	process.exit(exitCode);
}

function parseArgs(argv: string[]): Args {
	const args: Partial<Args> = {};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			continue;
		}
		if (arg === "--since") {
			args.since = argv[++i];
			if (!args.since || args.since.startsWith("--")) {
				console.error("--since requires a date value");
				usage();
			}
		} else if (arg === "--until") {
			args.until = argv[++i];
			if (!args.until || args.until.startsWith("--")) {
				console.error("--until requires a date value");
				usage();
			}
		} else if (arg === "--channel") {
			args.channel = argv[++i]?.replace(/^#/, "");
			if (!args.channel || args.channel.startsWith("--")) {
				console.error("--channel requires a channel name or ID");
				usage();
			}
		} else if (arg === "--markdown") {
			args.markdown = argv[++i];
			if (!args.markdown || args.markdown.startsWith("--")) {
				console.error("--markdown requires a file path");
				usage();
			}
		} else if (arg === "--help" || arg === "-h") {
			usage(0);
		} else {
			console.error(`Unknown argument: ${arg}`);
			usage();
		}
	}

	if (!args.since) usage();
	return args as Args;
}

function parseDateAtBoundary(value: string, boundary: "start" | "end"): number {
	const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
	let date: Date;

	if (dateOnly) {
		const [, year, month, day] = dateOnly;
		date = new Date(Number(year), Number(month) - 1, Number(day));
	} else {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) {
			throw new Error(`Invalid date: ${value}`);
		}
		date = new Date(timestamp);
	}

	if (boundary === "start") {
		date.setHours(0, 0, 0, 0);
	} else {
		date.setHours(23, 59, 59, 999);
	}

	return date.getTime() / 1000;
}

function parseSince(since: string): number {
	return parseDateAtBoundary(since, "start");
}

function parseUntil(until?: string): string | undefined {
	return until ? parseDateAtBoundary(until, "end").toString() : undefined;
}

function hasThumbsUp(message: SlackMessage): boolean {
	return (
		message.reactions?.some(
			(reaction) =>
				typeof reaction.name === "string" &&
				reaction.name === THUMBS_UP_REACTION,
		) ?? false
	);
}

function matchingReactionNames(message: SlackMessage): string[] {
	return (
		message.reactions
			?.filter(
				(reaction) =>
					typeof reaction.name === "string" &&
					reaction.name === THUMBS_UP_REACTION,
			)
			.map((reaction) => `${reaction.name}:${reaction.count ?? 0}`) ?? []
	);
}

function extractRichTextInline(elements: SlackRichTextElement[] = []): string {
	return elements
		.map((element) => {
			if (typeof element.text === "string") return element.text;
			if (element.type === "link") return element.url ?? "";
			if (element.type === "emoji" && element.name) return `:${element.name}:`;
			if (element.type === "user" && element.user_id)
				return `<@${element.user_id}>`;
			if (element.elements) return extractRichTextInline(element.elements);
			return "";
		})
		.join("");
}

function extractRichText(elements: SlackRichTextElement[] = []): string {
	const lines: string[] = [];

	for (const element of elements) {
		if (element.type === "rich_text_preformatted") {
			lines.push("```");
			lines.push(extractRichTextInline(element.elements));
			lines.push("```");
		} else if (element.type === "rich_text_list") {
			for (const item of element.elements ?? []) {
				lines.push(`- ${extractRichTextInline(item.elements)}`);
			}
		} else if (element.type === "rich_text_quote") {
			lines.push(`> ${extractRichTextInline(element.elements)}`);
		} else if (element.elements) {
			lines.push(extractRichTextInline(element.elements));
		} else {
			lines.push(extractRichTextInline([element]));
		}
	}

	return lines.filter(Boolean).join("\n");
}

function escapeTableCell(text: string): string {
	return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function extractTable(rows: SlackTextObject[][] = []): string | undefined {
	if (rows.length === 0) return undefined;

	const columnCount = Math.max(...rows.map((row) => row.length));
	const [header = [], ...body] = rows;
	const formatRow = (row: SlackTextObject[]): string => {
		const cells = Array.from({ length: columnCount }, (_, index) =>
			escapeTableCell(row[index]?.text ?? ""),
		);
		return `| ${cells.join(" | ")} |`;
	};

	return [
		formatRow(header),
		`| ${Array.from({ length: columnCount }, () => "---").join(" | ")} |`,
		...body.map(formatRow),
	].join("\n");
}

function extractBlockText(blocks?: SlackBlock[]): string | undefined {
	const lines: string[] = [];

	for (const block of blocks ?? []) {
		if (block.type === "table") {
			const table = extractTable(block.rows);
			if (table) lines.push(table);
		} else if (block.text?.text) {
			lines.push(block.text.text);
		} else if (block.elements) {
			const text = extractRichText(block.elements);
			if (text) lines.push(text);
		}
	}

	const text = lines.join("\n\n").trim();
	return text || undefined;
}

function messageText(message: SlackMessage): string | undefined {
	return extractBlockText(message.blocks) ?? message.text;
}

function slackLink(label: string, url?: string): string {
	return url ? `[${label}](${url})` : label;
}

function formatMarkdown(threads: MatchingThread[]): string {
	const lines: string[] = [];

	for (const [threadIndex, thread] of threads.entries()) {
		if (threadIndex > 0) {
			lines.push("---");
			lines.push("");
		}

		const heading = (thread.question ?? "").replace(/<@[A-Z0-9]+>\s*/g, "");
		lines.push(`## ${heading}`);
		lines.push("");
		lines.push(slackLink("Open parent thread", thread.permalink));
		lines.push("");

		const hasMultipleAnswers = thread.matchedMessages.length > 1;
		for (const [index, message] of thread.matchedMessages.entries()) {
			lines.push(hasMultipleAnswers ? `### Answer ${index + 1}` : "### Answer");
			lines.push("");
			lines.push(
				slackLink(
					hasMultipleAnswers
						? `Open answer ${index + 1} in Slack`
						: "Open answer in Slack",
					message.permalink,
				),
			);
			lines.push("");
			lines.push(message.blockText ?? message.text ?? "");
			lines.push("");
		}
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

async function saveMarkdown(path: string, contents: string): Promise<void> {
	const directory = dirname(path);
	if (directory !== ".") await mkdir(directory, { recursive: true });
	await writeFile(path, contents, "utf8");
}

function asSlackMessage(value: unknown): SlackMessage | null {
	if (!value || typeof value !== "object") return null;
	const message = value as SlackMessage;
	return typeof message.ts === "string" ? message : null;
}

function normalizeChannelName(channelName: string): string {
	return channelName.replace(/^#/, "").toLowerCase();
}

function channelMatches(channel: SlackChannel, requested?: string): boolean {
	if (!requested) return true;
	const normalized = normalizeChannelName(requested);
	return channel.id === requested || channel.name.toLowerCase() === normalized;
}

async function listChannels(
	slack: WebClient,
	channelNameOrId?: string,
): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor: string | undefined;

	do {
		const response = await slack.conversations.list({
			cursor,
			exclude_archived: true,
			limit: 1000,
			types: "public_channel,private_channel",
		});

		for (const channel of response.channels ?? []) {
			if (!channel.id || !channel.name) continue;
			const slackChannel = { id: channel.id, name: channel.name };
			if (channelMatches(slackChannel, channelNameOrId)) {
				channels.push(slackChannel);
			}
		}

		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);

	if (channelNameOrId && channels.length === 0) {
		throw new Error(`Channel not found: ${channelNameOrId}`);
	}

	return channels;
}

async function* fetchChannelMessages(
	slack: WebClient,
	channel: string,
	oldest: string,
	latest?: string,
): AsyncGenerator<SlackMessage> {
	let cursor: string | undefined;

	do {
		const response = await slack.conversations.history({
			channel,
			cursor,
			latest,
			limit: 200,
			oldest,
		});

		for (const rawMessage of response.messages ?? []) {
			const message = asSlackMessage(rawMessage);
			if (message) yield message;
		}

		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);
}

async function* fetchThreadReplies(
	slack: WebClient,
	channel: string,
	threadTs: string,
	oldest: string,
	latest?: string,
): AsyncGenerator<SlackMessage> {
	let cursor: string | undefined;

	do {
		const response = await slack.conversations.replies({
			channel,
			cursor,
			latest,
			limit: 200,
			oldest,
			ts: threadTs,
		});

		for (const rawMessage of response.messages ?? []) {
			const message = asSlackMessage(rawMessage);
			if (message && message.ts !== threadTs) yield message;
		}

		cursor = response.response_metadata?.next_cursor || undefined;
	} while (cursor);
}

async function findMatchingThreads(
	slack: WebClient,
	userNames: UserNameCache,
	channel: SlackChannel,
	oldest: string,
	latest?: string,
): Promise<MatchingThread[]> {
	const matches = new Map<string, MatchingThread>();

	for await (const message of fetchChannelMessages(
		slack,
		channel.id,
		oldest,
		latest,
	)) {
		const threadTs = message.thread_ts ?? message.ts;
		if (!threadTs) continue;

		const candidateMessages = [message];
		if ((message.reply_count ?? 0) > 0) {
			for await (const reply of fetchThreadReplies(
				slack,
				channel.id,
				threadTs,
				oldest,
				latest,
			)) {
				candidateMessages.push(reply);
			}
		}

		for (const candidate of candidateMessages) {
			if (!hasThumbsUp(candidate) || !candidate.ts) continue;

			let thread = matches.get(threadTs);
			if (!thread) {
				const permalink = await slack.chat.getPermalink({
					channel: channel.id,
					message_ts: threadTs,
				});

				thread = {
					channel: channel.id,
					channelName: channel.name,
					matchedMessages: [],
					permalink: permalink.permalink ?? "",
					question: messageText(message),
					threadTs,
				};
				matches.set(threadTs, thread);
			}

			const messagePermalink = await slack.chat.getPermalink({
				channel: channel.id,
				message_ts: candidate.ts,
			});

			thread.matchedMessages.push({
				blockText: messageText(candidate),
				permalink: messagePermalink.permalink ?? "",
				reactions: matchingReactionNames(candidate),
				text: candidate.text,
				ts: candidate.ts,
				user: candidate.user ?? candidate.username,
				userName: await userNames.get(candidate.user),
			});
		}
	}

	return [...matches.values()];
}

const args = parseArgs(process.argv.slice(2));
async function main(): Promise<void> {
	const token = process.env.SLACK_BOT_TOKEN;
	if (!token) throw new Error("SLACK_BOT_TOKEN env variable is required");

	const oldest = parseSince(args.since).toString();
	const latest = parseUntil(args.until);
	const slack = new WebClient(token);
	const userNames = new UserNameCache(slack);
	const channels = await listChannels(slack, args.channel);
	const threads: MatchingThread[] = [];

	for (const channel of channels) {
		console.error(`[slack] scanning #${channel.name}`);
		threads.push(
			...(await findMatchingThreads(slack, userNames, channel, oldest, latest)),
		);
	}

	threads.sort((a, b) => Number(a.threadTs) - Number(b.threadTs));
	if (args.markdown) {
		await saveMarkdown(args.markdown, formatMarkdown(threads));
		console.error(
			`[slack] wrote ${threads.length} thread(s) to ${args.markdown}`,
		);
	} else {
		console.log(JSON.stringify(threads, null, 2));
	}
}

try {
	await main();
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	console.error(`[fetch-thumbs-up-threads] ${message}`);
	process.exit(1);
}
