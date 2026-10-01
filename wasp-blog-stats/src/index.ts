import { CREDENTIAL_VALUE, Worker } from "@notionhq/workers";
import * as Schema from "@notionhq/workers/schema";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

const PLAUSIBLE_HOST = "plausible.io";
const SITE_ID = "wasp.sh";
const BLOG_PATH_PREFIX = "/blog/";
// /blog/ pages that aren't posts (Docusaurus listing/taxonomy pages).
const NON_POST_SEGMENTS = new Set(["tags", "page", "archive", "authors"]);

// The Plausible API key is brokered: Notion injects it into outbound requests
// to plausible.io, so the plaintext never has to enter the worker runtime.
// For local runs (`--local`), PLAUSIBLE_API_KEY from .env is used directly.
worker.credential("PLAUSIBLE_API_KEY", {
	network: [
		{
			domain: PLAUSIBLE_HOST,
			transform: [{ headers: { Authorization: `Bearer ${CREDENTIAL_VALUE}` } }],
		},
	],
});

// Plausible allows 600 requests/hour by default; the sync only needs 2 per cycle.
const plausibleApi = worker.pacer("plausibleApi", {
	allowedRequests: 10,
	intervalMs: 60_000,
});

// -- Plausible API v2 (https://plausible.io/docs/stats-api) --

type PlausibleResult = {
	dimensions: string[];
	metrics: number[];
};

async function queryPlausible(body: Record<string, unknown>): Promise<PlausibleResult[]> {
	const localKey = process.env.PLAUSIBLE_API_KEY;
	const response = await fetch(`https://${PLAUSIBLE_HOST}/api/v2/query`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: localKey ? `Bearer ${localKey}` : `Bearer ${CREDENTIAL_VALUE}`,
		},
		body: JSON.stringify(body),
	});
	if (!response.ok) {
		throw new Error(`Plausible API error ${response.status}: ${await response.text()}`);
	}
	const data = (await response.json()) as { results: PlausibleResult[] };
	return data.results;
}

function blogBreakdownQuery(dateRange: string, metrics: string[], pathFilter: string) {
	return {
		site_id: SITE_ID,
		metrics,
		date_range: dateRange,
		dimensions: ["event:page"],
		filters: [["contains", "event:page", [pathFilter]]],
		order_by: [["pageviews", "desc"]],
		pagination: { limit: 5000 },
	};
}

// -- Path helpers --

function normalizePath(path: string): string {
	const noQuery = path.split("?")[0] ?? path;
	return noQuery.length > 1 ? noQuery.replace(/\/+$/, "") : noQuery;
}

function isBlogPost(path: string): boolean {
	if (!path.startsWith(BLOG_PATH_PREFIX)) return false;
	const firstSegment = path.slice(BLOG_PATH_PREFIX.length).split("/")[0] ?? "";
	return firstSegment.length > 0 && !NON_POST_SEGMENTS.has(firstSegment);
}

// -- Plausible stats shared by the sync job and the tool --

type StatRow = {
	path: string;
	visitors30d: number;
	pageviews30d: number;
	visitorsAllTime: number;
	pageviewsAllTime: number;
};

async function fetchBlogStatRows(): Promise<StatRow[]> {
	const metrics = ["visitors", "pageviews"];
	await plausibleApi.wait();
	const last30 = collectRows(
		await queryPlausible(blogBreakdownQuery("30d", metrics, BLOG_PATH_PREFIX)),
	);
	await plausibleApi.wait();
	const allTime = collectRows(
		await queryPlausible(blogBreakdownQuery("all", metrics, BLOG_PATH_PREFIX)),
	);

	return [...allTime.entries()]
		.map(([path, all]) => ({
			path,
			visitors30d: last30.get(path)?.visitors ?? 0,
			pageviews30d: last30.get(path)?.pageviews ?? 0,
			visitorsAllTime: all.visitors,
			pageviewsAllTime: all.pageviews,
		}))
		.sort((a, b) => b.pageviewsAllTime - a.pageviewsAllTime);
}

function collectRows(results: PlausibleResult[]): Map<string, { visitors: number; pageviews: number }> {
	const byPath = new Map<string, { visitors: number; pageviews: number }>();
	for (const result of results) {
		const path = normalizePath(result.dimensions[0] ?? "");
		if (!isBlogPost(path)) continue;
		const existing = byPath.get(path) ?? { visitors: 0, pageviews: 0 };
		existing.visitors += result.metrics[0] ?? 0;
		existing.pageviews += result.metrics[1] ?? 0;
		byPath.set(path, existing);
	}
	return byPath;
}

// The Workers platform requires every sync to target a managed database.
// contentPipelineStatsSync writes to the existing Content Pipeline database
// via the Notion API instead and never emits changes, so this placeholder
// stays empty (feel free to hide it wherever Notion puts it).
const syncPlaceholder = worker.database("syncPlaceholder", {
	type: "managed",
	initialTitle: "Plausible Sync (internal, unused)",
	primaryKeyProperty: "Key",
	schema: {
		properties: {
			Name: Schema.title(),
			Key: Schema.richText(),
		},
	},
});

// -- Daily job: write stats onto matching Content Pipeline pages --

const CONTENT_PIPELINE_DATA_SOURCE_ID = "476e60eb-4d1c-4559-b498-9fcee0b4c381";
const CONTENT_PIPELINE_PAGE_BATCH = 25;
// Old posts may link the previous domain; Plausible paths are the same either way.
const SITE_HOSTNAMES = new Set([SITE_ID, `www.${SITE_ID}`, "wasp-lang.dev", "www.wasp-lang.dev"]);

// Notion API allows ~3 requests/second.
const notionApi = worker.pacer("notionApi", { allowedRequests: 3, intervalMs: 1000 });

type ContentPipelineSyncState = {
	stats: Record<string, StatRow>;
	cursor: string;
};

function blogPathFromUrl(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (!SITE_HOSTNAMES.has(parsed.hostname)) return undefined;
		const path = normalizePath(parsed.pathname);
		return isBlogPost(path) ? path : undefined;
	} catch {
		return undefined;
	}
}

function currentNumber(properties: Record<string, unknown>, name: string): number | null {
	const prop = properties[name] as { type?: string; number?: number | null } | undefined;
	return prop?.type === "number" ? (prop.number ?? null) : null;
}

// This job writes to the user's existing Content Pipeline database via the
// Notion API, matching rows by their URL property. It rides on the sync
// scheduler for its daily run: it targets the managed stats database in
// incremental mode but always returns zero changes, so that database is
// never touched by this sync. Requires NOTION_API_TOKEN (a connection with
// access to Content Pipeline).
worker.sync("contentPipelineStatsSync", {
	database: syncPlaceholder,
	mode: "incremental",
	schedule: "1d",
	execute: async (state: ContentPipelineSyncState | undefined, { notion }) => {
		let stats: Record<string, StatRow>;
		if (state?.stats) {
			stats = state.stats;
		} else {
			stats = {};
			for (const row of await fetchBlogStatRows()) stats[row.path] = row;
		}

		await notionApi.wait();
		const response = await notion.dataSources.query({
			data_source_id: CONTENT_PIPELINE_DATA_SOURCE_ID,
			filter: { property: "URL", url: { is_not_empty: true } },
			page_size: CONTENT_PIPELINE_PAGE_BATCH,
			...(state?.cursor ? { start_cursor: state.cursor } : {}),
		});

		const today = new Date().toISOString().slice(0, 10);
		let updated = 0;
		for (const page of response.results) {
			if (!("properties" in page)) continue;
			const urlProp = page.properties.URL;
			const url = urlProp?.type === "url" && typeof urlProp.url === "string" ? urlProp.url : null;
			const path = url ? blogPathFromUrl(url) : undefined;
			const row = path ? stats[path] : undefined;
			if (!row) continue;

			const unchanged =
				currentNumber(page.properties, "Unique Visitors (30d)") === row.visitors30d &&
				currentNumber(page.properties, "Pageviews (30d)") === row.pageviews30d &&
				currentNumber(page.properties, "Unique Visitors (All Time)") === row.visitorsAllTime &&
				currentNumber(page.properties, "Pageviews (All Time)") === row.pageviewsAllTime;
			if (unchanged) continue;

			await notionApi.wait();
			await notion.pages.update({
				page_id: page.id,
				properties: {
					"Unique Visitors (30d)": { number: row.visitors30d },
					"Pageviews (30d)": { number: row.pageviews30d },
					"Unique Visitors (All Time)": { number: row.visitorsAllTime },
					"Pageviews (All Time)": { number: row.pageviewsAllTime },
					"Stats Updated": { date: { start: today } },
				},
			});
			updated++;
		}
		console.log(`Content Pipeline: updated ${updated}/${response.results.length} pages in this batch`);

		const hasMore = Boolean(response.has_more && response.next_cursor);
		return {
			changes: [],
			hasMore,
			nextState: hasMore && response.next_cursor ? { stats, cursor: response.next_cursor } : undefined,
		};
	},
});

// -- On-demand tool: query stats for a post (or top posts) --

worker.tool("getBlogPostStats", {
	title: "Get Blog Post Stats",
	description:
		"Fetch Plausible analytics for wasp.sh blog posts: unique visitors, pageviews, and bounce rate. " +
		"Pass a post path or slug for a single post, or null to list the top posts for the period.",
	schema: j.object({
		path: j
			.string()
			.nullable()
			.describe(
				"Blog post path (e.g. /blog/2026/06/15/wasp-typescript-spec) or just the slug. Null lists top posts.",
			),
		period: j
			.enum("day", "7d", "30d", "6mo", "12mo", "all")
			.nullable()
			.describe("Time period to report on. Defaults to 30d."),
		limit: j.integer().nullable().describe("Max posts to return when listing top posts. Defaults to 10."),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ path, period, limit }) => {
		const dateRange = period ?? "30d";
		const pathFilter = path
			? path.startsWith("/")
				? path
				: `/${path}`
			: BLOG_PATH_PREFIX;

		const results = await queryPlausible(
			blogBreakdownQuery(dateRange, ["visitors", "pageviews", "bounce_rate"], pathFilter),
		);

		const posts = results
			.map((result) => ({
				path: normalizePath(result.dimensions[0] ?? ""),
				url: `https://${SITE_ID}${normalizePath(result.dimensions[0] ?? "")}`,
				uniqueVisitors: result.metrics[0] ?? 0,
				pageviews: result.metrics[1] ?? 0,
				bounceRate: result.metrics[2] ?? 0,
			}))
			.filter((post) => isBlogPost(post.path))
			.slice(0, Math.max(1, limit ?? 10));

		return { site: SITE_ID, period: dateRange, posts };
	},
});
