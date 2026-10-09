import type { SandboxedPlugin, PluginContext } from "emdash/plugin";
import { pluginResponse } from "emdash/plugin";
import type { StorageCollection } from "emdash";
import type { Block, BlockResponse, FormField } from "@emdash-cms/blocks";
import { SCRIPT_VERSION, VISITOR_SCRIPT } from "./visitor";

/* ------------------------------------------------------------------ */
/* Model                                                               */
/* ------------------------------------------------------------------ */

export const OPTIONAL = ["preferences", "analytics", "marketing"] as const;
export const CATEGORY_IDS = ["necessary", ...OPTIONAL] as const;
type OptionalId = (typeof OPTIONAL)[number];
type CategoryId = (typeof CATEGORY_IDS)[number];
type Choice = Record<OptionalId, boolean>;

/** One consent record. Id is "<consent id>.<time>", so a visitor's history stays searchable. */
interface ConsentRow {
	cid: string;
	at: string;
	day: string;
	action: "accept" | "reject" | "custom";
	categories: Choice;
	version: number;
	country: string | null;
	script: number;
}

/** Daily counts for the statistics. Kept for 13 months. */
interface DayRow {
	day: string;
	total: number;
	accept: number;
	reject: number;
	custom: number;
	preferences: number;
	analytics: number;
	marketing: number;
}

/** A cookie name the script saw on the site that is not in the cookie list yet. */
interface FoundRow {
	name: string;
	firstSeen: string;
	lastSeen: string;
	count: number;
	ignored?: boolean;
}

interface BannerSettings {
	layout: "bar" | "box" | "popup";
	position: "left" | "right";
	theme: "light" | "dark" | "auto";
	accent: string;
	policyUrl: string;
	expiryMonths: number;
	region: "all" | "eu";
	googleMode: "block" | "consent";
	autoBlock: boolean;
	reopen: boolean;
	discovery: boolean;
}

interface Texts {
	title: string;
	message: string;
	accept: string;
	reject: string;
	manage: string;
	save: string;
	policyLabel: string;
	prefTitle: string;
	prefIntro: string;
	reopen: string;
	alwaysActive: string;
	showCookies: string;
	blockedEmbed: string;
	allowEmbed: string;
	consentId: string;
	close: string;
	colName: string;
	colProvider: string;
	colPurpose: string;
	colDuration: string;
}

interface CategoryText {
	name: string;
	description: string;
}
type Categories = Record<CategoryId, CategoryText>;

interface CookieRow {
	name: string;
	category: CategoryId;
	provider: string;
	purpose: string;
	duration: string;
}

interface Version {
	n: number;
	at: string;
}

const DEFAULT_BANNER: BannerSettings = {
	layout: "box",
	position: "right",
	theme: "auto",
	accent: "#2563eb",
	policyUrl: "",
	expiryMonths: 12,
	region: "all",
	googleMode: "block",
	autoBlock: true,
	reopen: true,
	discovery: true,
};

const DEFAULT_TEXTS: Texts = {
	title: "We value your privacy",
	message:
		"We use cookies to make this site work, to understand how it is used, and to show relevant content. You can accept all cookies, reject the optional ones, or choose for yourself. Change your mind at any time from Cookie settings.",
	accept: "Accept all",
	reject: "Reject all",
	manage: "Manage preferences",
	save: "Save my choices",
	policyLabel: "Privacy policy",
	prefTitle: "Cookie preferences",
	prefIntro: "Choose which cookies this site may use. Necessary cookies are always on because the site cannot work without them.",
	reopen: "Cookie settings",
	alwaysActive: "Always active",
	showCookies: "Show cookies ({count})",
	blockedEmbed: "This content is blocked until you allow {category} cookies.",
	allowEmbed: "Allow {category} cookies",
	consentId: "Consent ID",
	close: "Close",
	colName: "Cookie",
	colProvider: "Provider",
	colPurpose: "Purpose",
	colDuration: "Duration",
};

const DEFAULT_CATEGORIES: Categories = {
	necessary: {
		name: "Necessary",
		description: "Needed for the site to work: remembering your cookie choices, keeping you signed in, protecting forms from abuse.",
	},
	preferences: {
		name: "Preferences",
		description: "Remember choices you make, such as language or region, so you do not have to set them again.",
	},
	analytics: {
		name: "Analytics",
		description: "Help us understand how the site is used, so we can improve it. Data is aggregated and does not identify you.",
	},
	marketing: {
		name: "Marketing",
		description: "Used by advertising and social media services to show you relevant content and measure campaigns.",
	},
};

const DEFAULT_COOKIES: CookieRow[] = [
	{ name: "cc_consent", category: "necessary", provider: "This site", purpose: "Remembers your cookie choices.", duration: "12 months" },
];

/** EU, EEA, UK and Switzerland. */
const EU = new Set(
	"AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" "),
);

const CONSENT_RETENTION_DAYS = 400;
/** Cookie names, with a trailing * allowed in the list for families such as _ga_*. */
const COOKIE_NAME_RE = /^[A-Za-z0-9_.\-:]{1,64}$/;
const LISTED_NAME_RE = /^[A-Za-z0-9_.\-:]{1,63}\*?$/;

/** Does a cookie name match a listed name, where a trailing * means "starts with"? */
function matchesListed(name: string, listed: string): boolean {
	return listed.endsWith("*") ? name.startsWith(listed.slice(0, -1)) : name === listed;
}
const CONSENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, d: string, max = 2000): string {
	return typeof v === "string" ? v.slice(0, max) : d;
}

function pick<T extends string>(v: unknown, allowed: readonly T[], d: T): T {
	return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : d;
}

function hexColor(v: unknown, d: string): string {
	return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v.trim()) ? v.trim().toLowerCase() : d;
}

function safeUrl(v: unknown): string {
	if (typeof v !== "string") return "";
	const s = v.trim();
	if (!s) return "";
	if (s.startsWith("/") && !s.startsWith("//")) return s.slice(0, 500);
	try {
		const u = new URL(s);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : "";
	} catch {
		return "";
	}
}

function bannerFrom(v: unknown): BannerSettings {
	const o = isRecord(v) ? v : {};
	const months = typeof o.expiryMonths === "number" && Number.isFinite(o.expiryMonths) ? Math.round(o.expiryMonths) : DEFAULT_BANNER.expiryMonths;
	return {
		layout: pick(o.layout, ["bar", "box", "popup"], DEFAULT_BANNER.layout),
		position: pick(o.position, ["left", "right"], DEFAULT_BANNER.position),
		theme: pick(o.theme, ["light", "dark", "auto"], DEFAULT_BANNER.theme),
		accent: hexColor(o.accent, DEFAULT_BANNER.accent),
		policyUrl: safeUrl(o.policyUrl),
		expiryMonths: Math.min(24, Math.max(1, months)),
		region: pick(o.region, ["all", "eu"], DEFAULT_BANNER.region),
		googleMode: pick(o.googleMode, ["block", "consent"], DEFAULT_BANNER.googleMode),
		autoBlock: typeof o.autoBlock === "boolean" ? o.autoBlock : DEFAULT_BANNER.autoBlock,
		reopen: typeof o.reopen === "boolean" ? o.reopen : DEFAULT_BANNER.reopen,
		discovery: typeof o.discovery === "boolean" ? o.discovery : DEFAULT_BANNER.discovery,
	};
}

function textsFrom(v: unknown): Texts {
	const o = isRecord(v) ? v : {};
	const out = { ...DEFAULT_TEXTS };
	for (const key of Object.keys(DEFAULT_TEXTS) as (keyof Texts)[]) {
		const s = str(o[key], "", 1000).trim();
		if (s) out[key] = s;
	}
	return out;
}

function categoriesFrom(v: unknown): Categories {
	const o = isRecord(v) ? v : {};
	const out = {} as Categories;
	for (const id of CATEGORY_IDS) {
		const c = isRecord(o[id]) ? (o[id] as Record<string, unknown>) : {};
		out[id] = {
			name: str(c.name, "", 60).trim() || DEFAULT_CATEGORIES[id].name,
			description: str(c.description, "", 600).trim() || DEFAULT_CATEGORIES[id].description,
		};
	}
	return out;
}

function cookiesFrom(v: unknown): CookieRow[] {
	if (!Array.isArray(v)) return DEFAULT_COOKIES;
	const rows: CookieRow[] = [];
	for (const item of v.slice(0, 200)) {
		if (!isRecord(item)) continue;
		const name = str(item.name, "", 64).trim();
		if (!LISTED_NAME_RE.test(name)) continue;
		rows.push({
			name,
			category: pick(item.category, CATEGORY_IDS, "necessary"),
			provider: str(item.provider, "", 120).trim(),
			purpose: str(item.purpose, "", 300).trim(),
			duration: str(item.duration, "", 60).trim(),
		});
	}
	return rows;
}

interface Settings {
	banner: BannerSettings;
	texts: Texts;
	categories: Categories;
	cookies: CookieRow[];
	version: Version;
}

async function loadSettings(ctx: PluginContext): Promise<Settings> {
	const [banner, texts, categories, cookies, version] = await Promise.all([
		ctx.settings.get<unknown>("banner"),
		ctx.settings.get<unknown>("texts"),
		ctx.settings.get<unknown>("categories"),
		ctx.settings.get<unknown>("cookies"),
		ctx.kv.get<Version>("version"),
	]);
	return {
		banner: bannerFrom(banner),
		texts: textsFrom(texts),
		categories: categoriesFrom(categories),
		cookies: cookiesFrom(cookies),
		version: version && typeof version.n === "number" ? version : { n: 1, at: "" },
	};
}

async function bumpVersion(ctx: PluginContext): Promise<Version> {
	const cur = (await ctx.kv.get<Version>("version")) ?? { n: 1, at: "" };
	const next = { n: cur.n + 1, at: new Date().toISOString() };
	await ctx.kv.set("version", next);
	return next;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function fmt(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
}

function pct(part: number, whole: number): string {
	return whole === 0 ? "0%" : `${Math.round((part / whole) * 100)}%`;
}

function stores(ctx: PluginContext) {
	return {
		consents: ctx.storage.consents as StorageCollection<ConsentRow>,
		days: ctx.storage.days as StorageCollection<DayRow>,
		found: ctx.storage.found as StorageCollection<FoundRow>,
	};
}

interface GeoMeta {
	geo?: { country?: string | null } | null;
}

function countryOf(meta: unknown): string | null {
	const m = meta as GeoMeta | undefined;
	const c = m?.geo?.country;
	return typeof c === "string" && /^[A-Z]{2}$/.test(c) ? c : null;
}

/** Add to several counters of one day row, creating it when needed. */
async function bumpDay(ctx: PluginContext, day: string, inc: Partial<Record<keyof Omit<DayRow, "day">, number>>): Promise<void> {
	const { days } = stores(ctx);
	const delta: Record<string, { inc: number }> = {};
	for (const [k, v] of Object.entries(inc)) if (v) delta[k] = { inc: v };
	const res = await days.updateIf(day, { where: {}, delta } as never);
	if (res.applied) return;
	const fresh: DayRow = { day, total: 0, accept: 0, reject: 0, custom: 0, preferences: 0, analytics: 0, marketing: 0 };
	for (const [k, v] of Object.entries(inc)) (fresh as unknown as Record<string, number>)[k] = v ?? 0;
	const made = await days.compareAndSet(day, null, fresh);
	if (!made.applied) await days.updateIf(day, { where: {}, delta } as never);
}

async function dayRows(ctx: PluginContext, fromDaysAgo: number): Promise<DayRow[]> {
	const { days } = stores(ctx);
	const rows: DayRow[] = [];
	let cursor: string | undefined;
	do {
		const page = await days.query({ where: { day: { gte: daysAgo(fromDaysAgo) } }, limit: 100, cursor });
		for (const r of page.items) rows.push(r.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	return rows.sort((a, b) => (a.day < b.day ? -1 : 1));
}

/* ------------------------------------------------------------------ */
/* What the visitor's browser receives                                 */
/* ------------------------------------------------------------------ */

function publicConfig(s: Settings, country: string | null) {
	const show = s.banner.region === "all" || country === null || EU.has(country);
	return {
		version: s.version.n,
		expiryDays: s.banner.expiryMonths * 30,
		layout: s.banner.layout,
		position: s.banner.position,
		theme: s.banner.theme,
		accent: s.banner.accent,
		policyUrl: s.banner.policyUrl,
		reopen: s.banner.reopen,
		autoBlock: s.banner.autoBlock,
		googleMode: s.banner.googleMode,
		discovery: s.banner.discovery,
		show,
		texts: s.texts,
		categories: CATEGORY_IDS.map((id) => ({
			id,
			name: s.categories[id].name,
			description: s.categories[id].description,
			required: id === "necessary",
			cookies: s.cookies
				.filter((c) => c.category === id)
				.map((c) => ({ name: c.name, provider: c.provider, purpose: c.purpose, duration: c.duration })),
		})),
		known: s.cookies.map((c) => c.name),
	};
}

/* ------------------------------------------------------------------ */
/* Admin page                                                          */
/* ------------------------------------------------------------------ */

type Interaction = {
	type?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	page?: string;
	values?: Record<string, unknown>;
};

const TABS = { overview: 0, banner: 1, cookies: 2, records: 3, setup: 4 } as const;

async function overviewTab(ctx: PluginContext, s: Settings): Promise<Block[]> {
	const rows = await dayRows(ctx, 29);
	const sum = { total: 0, accept: 0, reject: 0, custom: 0, preferences: 0, analytics: 0, marketing: 0 };
	for (const r of rows) {
		for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r[k] ?? 0;
	}
	const everRecorded = (await stores(ctx).consents.count()) > 0;
	const scriptOnSite = (await ctx.kv.get<number>("scriptVersion")) ?? null;

	const blocks: Block[] = [];
	if (!everRecorded) {
		blocks.push({
			type: "banner",
			title: "Two steps to finish setup",
			description: "Open the Setup tab, download the script, and load it as the first script in your theme's head. The banner shows on your site as soon as it is in place.",
		});
	} else if (scriptOnSite !== null && scriptOnSite < SCRIPT_VERSION) {
		blocks.push({
			type: "banner",
			variant: "alert",
			title: `Your site runs script version ${scriptOnSite}; version ${SCRIPT_VERSION} is available`,
			description: "Download the new file from the Setup tab and replace the old one. Nothing else changes.",
		});
	}

	blocks.push(
		{ type: "section", text: "Last 30 days" },
		{
			type: "stats",
			items: [
				{ label: "Choices made", value: fmt(sum.total) },
				{ label: "Accepted all", value: pct(sum.accept, sum.total), description: `${fmt(sum.accept)} visitors` },
				{ label: "Rejected all", value: pct(sum.reject, sum.total), description: `${fmt(sum.reject)} visitors` },
				{ label: "Chose for themselves", value: pct(sum.custom, sum.total), description: `${fmt(sum.custom)} visitors` },
			],
		},
		{ type: "context", text: "How many visitors allowed each optional category" },
		{
			type: "columns",
			columns: OPTIONAL.map((id) => [
				{
					type: "meter",
					label: s.categories[id].name,
					value: sum.total === 0 ? 0 : Math.round((sum[id] / sum.total) * 100),
					max: 100,
					custom_value: pct(sum[id], sum.total),
				},
			]),
		},
	);

	if (rows.length > 0) {
		const byDay = new Map(rows.map((r) => [r.day, r]));
		const filled: DayRow[] = [];
		for (let n = 29; n >= 0; n--) {
			const day = daysAgo(n);
			filled.push(byDay.get(day) ?? { day, total: 0, accept: 0, reject: 0, custom: 0, preferences: 0, analytics: 0, marketing: 0 });
		}
		const series = (key: keyof DayRow, name: string) => ({
			name,
			data: filled.map((r) => [Date.parse(`${r.day}T00:00:00Z`), (r[key] as number) ?? 0] as [number, number]),
		});
		blocks.push({
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "bar",
				series: [series("accept", "Accepted all"), series("custom", "Chose for themselves"), series("reject", "Rejected all")],
				y_axis_name: "Choices",
				height: 220,
			},
		});
	}

	blocks.push(
		{ type: "divider" },
		{
			type: "section",
			text:
				s.version.at
					? `Consent version ${s.version.n}, since ${new Date(s.version.at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}. Visitors who chose before that date see the banner again.`
					: `Consent version ${s.version.n}. Ask everyone again after you add or change cookies, so their earlier choice no longer counts.`,
			accessory: {
				type: "button",
				action_id: "ask_again",
				label: "Ask everyone again",
				style: "secondary",
				confirm: {
					title: "Ask everyone again?",
					text: "Every visitor sees the banner on their next visit and chooses afresh. Their earlier choice stops applying.",
					confirm: "Ask again",
					deny: "Cancel",
				},
			},
		},
	);
	return blocks;
}

function bannerTab(s: Settings): Block[] {
	const b = s.banner;
	const t = s.texts;
	const setup: FormField[] = [
		{
			type: "select",
			action_id: "layout",
			label: "Layout",
			options: [
				{ value: "box", label: "Box in a bottom corner" },
				{ value: "bar", label: "Bar across the bottom" },
				{ value: "popup", label: "Popup in the middle, page dimmed" },
			],
			initial_value: b.layout,
		},
		{
			type: "select",
			action_id: "position",
			label: "Corner for the box and the reopen button",
			options: [
				{ value: "right", label: "Bottom right" },
				{ value: "left", label: "Bottom left" },
			],
			initial_value: b.position,
		},
		{
			type: "select",
			action_id: "theme",
			label: "Colours",
			options: [
				{ value: "auto", label: "Follow the visitor's device" },
				{ value: "light", label: "Light" },
				{ value: "dark", label: "Dark" },
			],
			initial_value: b.theme,
		},
		{ type: "text_input", action_id: "accent", label: "Button colour", placeholder: "#2563eb", initial_value: b.accent },
		{ type: "text_input", action_id: "policyUrl", label: "Privacy policy link", placeholder: "/privacy or https://…", initial_value: b.policyUrl },
		{ type: "number_input", action_id: "expiryMonths", label: "Remember the choice for (months)", initial_value: b.expiryMonths, min: 1, max: 24 },
		{
			type: "select",
			action_id: "region",
			label: "Show the banner to",
			options: [
				{ value: "all", label: "Everyone" },
				{ value: "eu", label: "Visitors in the EU, UK and Switzerland only" },
			],
			initial_value: b.region,
		},
		{
			type: "toggle",
			action_id: "autoBlock",
			label: "Block well-known trackers until consent",
			description: "Meta Pixel, Hotjar, Clarity, LinkedIn, TikTok, YouTube and Maps embeds, and more. They never run before consent. Tagging them yourself also stops the download; see Setup.",
			initial_value: b.autoBlock,
		},
		{
			type: "select",
			action_id: "googleMode",
			label: "Google Analytics and Tag Manager",
			options: [
				{ value: "block", label: "Block until the visitor allows Analytics" },
				{ value: "consent", label: "Load, and let Google Consent Mode decide what they may store" },
			],
			initial_value: b.googleMode,
		},
		{
			type: "toggle",
			action_id: "reopen",
			label: "Show a small Cookie settings button",
			description: "Lets visitors change their mind. A link in your footer can do the same.",
			initial_value: b.reopen,
		},
		{
			type: "toggle",
			action_id: "discovery",
			label: "Report cookies found on the site",
			description: "The script sends cookie names it sees, nothing else, so new cookies show up in the Cookies tab.",
			initial_value: b.discovery,
		},
	];
	const wording: FormField[] = [
		{ type: "text_input", action_id: "title", label: "Banner title", initial_value: t.title },
		{ type: "text_input", action_id: "message", label: "Banner message", initial_value: t.message, multiline: true },
		{ type: "text_input", action_id: "accept", label: "Accept button", initial_value: t.accept },
		{ type: "text_input", action_id: "reject", label: "Reject button", initial_value: t.reject },
		{ type: "text_input", action_id: "manage", label: "Preferences button", initial_value: t.manage },
		{ type: "text_input", action_id: "policyLabel", label: "Privacy policy link text", initial_value: t.policyLabel },
		{ type: "text_input", action_id: "prefTitle", label: "Preferences title", initial_value: t.prefTitle },
		{ type: "text_input", action_id: "prefIntro", label: "Preferences introduction", initial_value: t.prefIntro, multiline: true },
		{ type: "text_input", action_id: "save", label: "Save button", initial_value: t.save },
		{ type: "text_input", action_id: "reopen", label: "Cookie settings button", initial_value: t.reopen },
		{ type: "text_input", action_id: "blockedEmbed", label: "Blocked video or map", initial_value: t.blockedEmbed },
		{ type: "text_input", action_id: "allowEmbed", label: "Button under a blocked video or map", initial_value: t.allowEmbed },
	];
	return [
		{ type: "section", text: "How the banner looks and behaves" },
		{ type: "form", block_id: "banner", fields: setup, submit: { label: "Save", action_id: "save_banner" } },
		{ type: "divider" },
		{ type: "section", text: "Wording" },
		{ type: "context", text: "{category} becomes the category name, {count} the number of cookies." },
		{ type: "form", block_id: "texts", fields: wording, submit: { label: "Save wording", action_id: "save_texts" } },
	];
}

async function cookiesTab(ctx: PluginContext, s: Settings, editing?: CookieRow): Promise<Block[]> {
	const catFields: FormField[] = [];
	for (const id of CATEGORY_IDS) {
		catFields.push(
			{ type: "text_input", action_id: `${id}_name`, label: `${DEFAULT_CATEGORIES[id].name} category name`, initial_value: s.categories[id].name },
			{ type: "text_input", action_id: `${id}_description`, label: `${DEFAULT_CATEGORIES[id].name} description`, initial_value: s.categories[id].description, multiline: true },
		);
	}
	const catOptions = CATEGORY_IDS.map((id) => ({ value: id, label: s.categories[id].name }));

	const blocks: Block[] = [
		{ type: "section", text: "Categories" },
		{ type: "context", text: "Shown in the preferences window. Necessary is always on; the other three can be switched off by the visitor." },
		{ type: "form", block_id: "categories", fields: catFields, submit: { label: "Save categories", action_id: "save_categories" } },
		{ type: "divider" },
		{ type: "section", text: "Cookies" },
		{ type: "context", text: "Listed under each category so visitors can see what each cookie does. Ask everyone again on the Overview tab after adding cookies." },
		{
			type: "table",
			page_action_id: "cookies_page",
			columns: [
				{ key: "name", label: "Cookie", format: "code" },
				{ key: "category", label: "Category", format: "badge" },
				{ key: "provider", label: "Provider" },
				{ key: "purpose", label: "Purpose" },
				{ key: "duration", label: "Duration" },
				{ key: "menu", label: "", format: "element" },
			],
			rows: s.cookies.map((c) => ({
				name: c.name,
				category: s.categories[c.category].name,
				provider: c.provider,
				purpose: c.purpose,
				duration: c.duration,
				menu: {
					type: "menu",
					action_id: "cookie_menu",
					label: "Edit",
					items: [
						{ label: "Edit", value: `edit:${c.name}` },
						...(c.name === "cc_consent" ? [] : [{ label: "Remove", value: `remove:${c.name}` }]),
					],
				},
			})),
			empty_text: "No cookies listed yet.",
		},
		{ type: "section", text: editing ? `Edit ${editing.name}` : "Add a cookie" },
		{
			type: "form",
			block_id: editing ? `cookie:${editing.name}` : "cookie:",
			fields: [
				{ type: "text_input", action_id: "name", label: "Name", placeholder: "_ga", initial_value: editing?.name ?? "" },
				{ type: "select", action_id: "category", label: "Category", options: catOptions, initial_value: editing?.category ?? "analytics" },
				{ type: "text_input", action_id: "provider", label: "Provider", placeholder: "Google", initial_value: editing?.provider ?? "" },
				{ type: "text_input", action_id: "purpose", label: "Purpose", placeholder: "Tells visitors apart for statistics", initial_value: editing?.purpose ?? "" },
				{ type: "text_input", action_id: "duration", label: "Duration", placeholder: "2 years", initial_value: editing?.duration ?? "" },
			],
			submit: { label: editing ? "Save cookie" : "Add cookie", action_id: "save_cookie" },
		},
	];

	// Cookies the script has seen on the site that are not listed yet.
	const page = await stores(ctx).found.query({ orderBy: { lastSeen: "desc" }, limit: 100 });
	const unlisted = page.items.filter((i) => !i.data.ignored && !s.cookies.some((c) => matchesListed(i.data.name, c.name)));
	blocks.push({ type: "divider" }, { type: "section", text: "Found on your site, not listed yet" });
	if (unlisted.length === 0) {
		blocks.push({ type: "context", text: "Nothing waiting. New cookie names appear here as the script sees them on visitors' browsers." });
	} else {
		blocks.push({
			type: "table",
			page_action_id: "found_page",
			columns: [
				{ key: "name", label: "Cookie", format: "code" },
				{ key: "lastSeen", label: "Last seen", format: "relative_time" },
				{ key: "count", label: "Seen", format: "number" },
				{ key: "add", label: "", format: "element" },
			],
			rows: unlisted.map((i) => ({
				name: i.data.name,
				lastSeen: i.data.lastSeen,
				count: i.data.count,
				add: {
					type: "menu",
					action_id: "found_menu",
					label: "Add to",
					items: [...catOptions.map((o) => ({ label: o.label, value: `${o.value}:${i.data.name}` })), { label: "Ignore", value: `ignore:${i.data.name}` }],
				},
			})),
		});
	}
	return blocks;
}

function recordRow(id: string, r: ConsentRow, s: Settings) {
	const on = OPTIONAL.filter((c) => r.categories[c]).map((c) => s.categories[c].name);
	return {
		id,
		cid: r.cid,
		at: r.at,
		action: r.action === "accept" ? "Accepted all" : r.action === "reject" ? "Rejected all" : "Custom",
		categories: on.length ? on.join(", ") : "Necessary only",
		country: r.country ?? "",
		version: r.version,
	};
}

async function recordsTab(ctx: PluginContext, s: Settings, search: string, cursor?: string): Promise<Block[]> {
	const { consents } = stores(ctx);
	const total = await consents.count();
	const blocks: Block[] = [
		{
			type: "section",
			text: "Proof of consent. A visitor finds their consent ID at the bottom of the preferences window and can quote it to you.",
		},
		{
			type: "form",
			block_id: "search",
			fields: [{ type: "text_input", action_id: "cid", label: "Find a consent ID", placeholder: "e.g. 3f2a9c1e-…", initial_value: search }],
			submit: { label: "Find", action_id: "find_record" },
		},
	];
	const page = search
		? await consents.query({ where: { cid: search }, orderBy: { at: "desc" }, limit: 100 })
		: await consents.query({ orderBy: { at: "desc" }, limit: 25, cursor });
	blocks.push({
		type: "table",
		page_action_id: "records_page",
		columns: [
			{ key: "cid", label: "Consent ID", format: "code" },
			{ key: "at", label: "When", format: "relative_time" },
			{ key: "action", label: "Choice", format: "badge" },
			{ key: "categories", label: "Allowed" },
			{ key: "country", label: "Country" },
			{ key: "version", label: "Version", format: "number" },
		],
		rows: page.items.map((i) => recordRow(i.id, i.data, s)),
		next_cursor: !search && page.hasMore ? page.cursor : undefined,
		empty_text: search ? "No record with that consent ID." : "No choices recorded yet.",
	});
	blocks.push({
		type: "context",
		text: `${fmt(total)} records. Each holds the consent ID, time, choice, allowed categories, consent version and country. No IP address or browser details. Kept for ${Math.round(CONSENT_RETENTION_DAYS / 30)} months.`,
	});
	return blocks;
}

function setupTab(ctx: PluginContext): Block[] {
	const download = ctx.url(`/_emdash/api/plugins/${ctx.plugin.id}/script`);
	return [
		{ type: "section", text: "1. Download the script and put it in your site's public folder as cookie-consent.js.", accessory: { type: "link", label: "Download cookie-consent.js", target: { kind: "external", url: download }, appearance: "primary" } },
		{ type: "section", text: "2. Load it as the first script in the head of your base layout, before any analytics or marketing tag. Consent Mode and tracker blocking only work when it runs first." },
		{ type: "code", language: "tsx", code: `<head>\n\t<script is:inline src="/cookie-consent.js"></script>\n\t{/* everything else */}\n</head>` },
		{ type: "section", text: "That is the whole setup. Everything else is managed here and the site picks it up without touching the theme again." },
		{ type: "divider" },
		{ type: "section", text: "Blocking your own tags" },
		{ type: "context", text: "Well-known trackers are held automatically: they never run before consent, although the browser may still download the file. Tagging a script stops even the download, and covers anything the plugin does not recognise. A tagged script runs only after the visitor allows its category." },
		{ type: "code", language: "tsx", code: `<script is:inline type="text/plain" data-cc="analytics" src="https://example.com/stats.js"></script>\n\n<script is:inline type="text/plain" data-cc="marketing">\n\t// inline code runs only after Marketing is allowed\n</script>` },
		{ type: "context", text: "Videos and maps: use data-src instead of src. The embed is not loaded at all until allowed, and the visitor sees an Allow button in its place. An untagged YouTube or Maps embed is hidden behind the same button, but the browser may have started loading it." },
		{ type: "code", language: "tsx", code: `<iframe data-cc="marketing" data-src="https://www.youtube.com/embed/VIDEO_ID" width="560" height="315"></iframe>` },
		{ type: "divider" },
		{ type: "section", text: "A link that opens the preferences, for your footer" },
		{ type: "code", language: "tsx", code: `<a href="#" data-cc-open>Cookie settings</a>` },
		{ type: "divider" },
		{ type: "section", text: "Google Consent Mode v2" },
		{ type: "context", text: "The script sends Google the default signals, all denied, before any tag loads, and updates them when the visitor chooses. Google Analytics, Ads and Tag Manager follow those signals on their own; no extra code." },
		{ type: "divider" },
		{ type: "section", text: "For developers" },
		{ type: "context", text: "window.CookieConsent exposes show(), getConsent(), getId(), accept(categories), reject() and reset(). The document fires cc:ready and cc:consent events." },
		{ type: "context", text: `Script version ${SCRIPT_VERSION}.` },
	];
}

async function page(ctx: PluginContext, s: Settings, tab: number, extra: { search?: string; cursor?: string; editing?: CookieRow } = {}): Promise<BlockResponse> {
	return {
		blocks: [
			{ type: "header", text: "Cookie Consent" },
			{
				type: "tab",
				default_tab: tab,
				panels: [
					{ label: "Overview", blocks: await overviewTab(ctx, s) },
					{ label: "Banner", blocks: bannerTab(s) },
					{ label: "Cookies", blocks: await cookiesTab(ctx, s, extra.editing) },
					{ label: "Consent records", blocks: await recordsTab(ctx, s, extra.search ?? "", extra.cursor) },
					{ label: "Setup", blocks: setupTab(ctx) },
				],
			},
		],
	};
}

async function handleAdmin(ctx: PluginContext, i: Interaction): Promise<BlockResponse> {
	const v = i.values ?? {};
	const toast = (message: string, type: "success" | "error" | "info" = "success") => ({ toast: { type, message } });

	if (i.type === "form_submit") {
		switch (i.action_id) {
			case "save_banner": {
				await ctx.settings.set("banner", bannerFrom(v));
				return { ...(await page(ctx, await loadSettings(ctx), TABS.banner)), ...toast("Banner saved") };
			}
			case "save_texts": {
				await ctx.settings.set("texts", textsFrom(v));
				return { ...(await page(ctx, await loadSettings(ctx), TABS.banner)), ...toast("Wording saved") };
			}
			case "save_categories": {
				const cats: Record<string, unknown> = {};
				for (const id of CATEGORY_IDS) cats[id] = { name: v[`${id}_name`], description: v[`${id}_description`] };
				await ctx.settings.set("categories", categoriesFrom(cats));
				return { ...(await page(ctx, await loadSettings(ctx), TABS.cookies)), ...toast("Categories saved") };
			}
			case "save_cookie": {
				const s = await loadSettings(ctx);
				const original = typeof i.block_id === "string" && i.block_id.startsWith("cookie:") ? i.block_id.slice(7) : "";
				const [row] = cookiesFrom([v]);
				if (!row) return { ...(await page(ctx, s, TABS.cookies)), ...toast("Give the cookie a name: letters, numbers, _ . - and a trailing * for a family like _ga_*.", "error") };
				if (original === "cc_consent" && row.name !== "cc_consent") return { ...(await page(ctx, s, TABS.cookies)), ...toast("cc_consent is the plugin's own cookie and keeps its name.", "error") };
				const rest = s.cookies.filter((c) => c.name !== original && c.name !== row.name);
				const idx = original ? s.cookies.findIndex((c) => c.name === original) : -1;
				const next = idx >= 0 ? [...rest.slice(0, idx), row, ...rest.slice(idx)] : [...rest, row];
				await ctx.settings.set("cookies", next);
				return { ...(await page(ctx, await loadSettings(ctx), TABS.cookies)), ...toast(original ? `${row.name} saved` : `${row.name} added to ${s.categories[row.category].name}`) };
			}
			case "find_record": {
				const search = str(v.cid, "", 64).trim();
				return page(ctx, await loadSettings(ctx), TABS.records, { search });
			}
		}
	}

	if (i.type === "block_action") {
		switch (i.action_id) {
			case "ask_again": {
				const next = await bumpVersion(ctx);
				return { ...(await page(ctx, await loadSettings(ctx), TABS.overview)), ...toast(`Everyone is asked again from their next visit. Consent version ${next.n}.`) };
			}
			case "records_page": {
				const cursor = typeof i.value === "string" ? i.value : typeof i.page === "string" ? i.page : undefined;
				return page(ctx, await loadSettings(ctx), TABS.records, { cursor });
			}
			case "cookie_menu": {
				const [verb, name] = typeof i.value === "string" ? i.value.split(":", 2) : ["", ""];
				const s = await loadSettings(ctx);
				const row = s.cookies.find((c) => c.name === name);
				if (!row) return page(ctx, s, TABS.cookies);
				if (verb === "edit") return page(ctx, s, TABS.cookies, { editing: row });
				if (verb === "remove" && name !== "cc_consent") {
					await ctx.settings.set("cookies", s.cookies.filter((c) => c.name !== name));
					return { ...(await page(ctx, await loadSettings(ctx), TABS.cookies)), ...toast(`${name} removed`) };
				}
				return page(ctx, s, TABS.cookies);
			}
			case "found_menu": {
				const [target, name] = typeof i.value === "string" ? i.value.split(":", 2) : ["", ""];
				const s = await loadSettings(ctx);
				const { found } = stores(ctx);
				if (!name || !COOKIE_NAME_RE.test(name)) return page(ctx, s, TABS.cookies);
				if (target === "ignore") {
					const row = await found.get(name);
					if (row) await found.put(name, { ...row, ignored: true });
					return { ...(await page(ctx, await loadSettings(ctx), TABS.cookies)), ...toast(`${name} ignored`) };
				}
				const category = pick(target, CATEGORY_IDS, "necessary");
				const added: CookieRow = { name, category, provider: "", purpose: "", duration: "" };
				if (!s.cookies.some((c) => c.name === name)) await ctx.settings.set("cookies", [...s.cookies, added]);
				return { ...(await page(ctx, await loadSettings(ctx), TABS.cookies, { editing: added })), ...toast(`${name} added to ${s.categories[category].name}. Fill in its provider and purpose below.`) };
			}
		}
	}

	return page(ctx, await loadSettings(ctx), TABS.overview);
}

/* ------------------------------------------------------------------ */
/* Maintenance                                                         */
/* ------------------------------------------------------------------ */

async function cleanup(ctx: PluginContext): Promise<{ consents: number; days: number }> {
	const { consents, days } = stores(ctx);
	let removed = { consents: 0, days: 0 };
	for (;;) {
		const page = await consents.query({ where: { day: { lt: daysAgo(CONSENT_RETENTION_DAYS) } }, limit: 100 });
		if (page.items.length === 0) break;
		removed.consents += await consents.deleteMany(page.items.map((i) => i.id));
		if (!page.hasMore) break;
	}
	for (;;) {
		const page = await days.query({ where: { day: { lt: daysAgo(CONSENT_RETENTION_DAYS) } }, limit: 100 });
		if (page.items.length === 0) break;
		removed.days += await days.deleteMany(page.items.map((i) => i.id));
		if (!page.hasMore) break;
	}
	return removed;
}

/* ------------------------------------------------------------------ */
/* The plugin                                                          */
/* ------------------------------------------------------------------ */

const plugin: SandboxedPlugin = {
	hooks: {
		"plugin:activate": async (_event, ctx) => {
			await ctx.cron?.schedule("cleanup", { schedule: "0 3 * * *" });
			if (!(await ctx.kv.get("version"))) await ctx.kv.set("version", { n: 1, at: new Date().toISOString() });
		},
		"plugin:deactivate": async (_event, ctx) => {
			await ctx.cron?.cancel("cleanup").catch(() => {});
		},
		cron: async (event, ctx) => {
			if (event.name !== "cleanup") return;
			ctx.log.info("Cookie Consent cleanup", await cleanup(ctx));
		},
	},

	routes: {
		/** Public: everything the banner needs. Region decision uses the visitor's country, so no shared cache; a minute in the browser keeps changes quick to arrive. */
		config: {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			cacheControl: "private, max-age=60",
			handler: async (routeCtx, ctx) => {
				const s = await loadSettings(ctx);
				return publicConfig(s, countryOf(routeCtx.requestMeta));
			},
		},

		/** Public: a visitor made a choice. Stores the proof; nothing that identifies the person. */
		consent: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx) => {
				const b = isRecord(routeCtx.input) ? routeCtx.input : {};
				const cid = str(b.id, "", 64);
				const action = pick(b.action, ["accept", "reject", "custom"] as const, "custom");
				const cats = isRecord(b.categories) ? b.categories : {};
				if (!CONSENT_ID_RE.test(cid)) return { ok: false };
				const categories = { preferences: cats.preferences === true, analytics: cats.analytics === true, marketing: cats.marketing === true };
				const version = typeof b.version === "number" && Number.isInteger(b.version) ? b.version : 0;
				const script = typeof b.script === "number" && Number.isInteger(b.script) ? b.script : 0;
				const now = new Date();
				const row: ConsentRow = {
					cid,
					at: now.toISOString(),
					day: now.toISOString().slice(0, 10),
					action,
					categories,
					version,
					country: countryOf(routeCtx.requestMeta),
					script,
				};
				await stores(ctx).consents.put(`${cid}.${now.getTime()}`, row);
				await bumpDay(ctx, row.day, {
					total: 1,
					accept: action === "accept" ? 1 : 0,
					reject: action === "reject" ? 1 : 0,
					custom: action === "custom" ? 1 : 0,
					preferences: categories.preferences ? 1 : 0,
					analytics: categories.analytics ? 1 : 0,
					marketing: categories.marketing ? 1 : 0,
				});
				if (script > 0) await rememberScript(ctx, script);
				return { ok: true };
			},
		},

		/** Public: cookie names the script saw on the site. Names only, nothing about the visitor. */
		found: {
			public: true,
			methods: ["POST"],
			request: { body: "json" },
			handler: async (routeCtx, ctx) => {
				const b = isRecord(routeCtx.input) ? routeCtx.input : {};
				const s = await loadSettings(ctx);
				if (!s.banner.discovery) return { ok: false };
				const names = Array.isArray(b.names) ? b.names.slice(0, 50) : [];
				const listed = [...s.cookies.map((c) => c.name), "cc_consent"];
				const { found } = stores(ctx);
				const now = new Date().toISOString();
				let added = 0;
				for (const n of names) {
					if (typeof n !== "string" || !COOKIE_NAME_RE.test(n) || listed.some((l) => matchesListed(n, l))) continue;
					const cur = await found.get(n);
					await found.put(n, cur ? { ...cur, lastSeen: now, count: cur.count + 1 } : { name: n, firstSeen: now, lastSeen: now, count: 1 });
					added++;
				}
				const script = typeof b.script === "number" && Number.isInteger(b.script) ? b.script : 0;
				if (script > 0) await rememberScript(ctx, script);
				return { ok: true, added };
			},
		},

		/** Public: the visitor-side script as a file to download. Served as text so the browser never runs it from here. */
		script: {
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			cacheControl: "no-store",
			handler: async () =>
				pluginResponse({
					headers: {
						"content-type": "text/plain; charset=utf-8",
						"content-disposition": 'attachment; filename="cookie-consent.js"',
					},
					body: { kind: "text", value: VISITOR_SCRIPT },
				}),
		},

		/** The admin page. */
		admin: {
			permission: "plugins:manage",
			handler: async (routeCtx, ctx) => handleAdmin(ctx, (routeCtx.input ?? {}) as Interaction),
		},
	},
};

async function rememberScript(ctx: PluginContext, version: number): Promise<void> {
	const cur = (await ctx.kv.get<number>("scriptVersion")) ?? 0;
	if (version !== cur) await ctx.kv.set("scriptVersion", version);
}

export default plugin;
