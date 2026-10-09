import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createPluginRuntimeTestHost, type PluginRuntimeTestHost } from "@emdash-cms/plugin-test";

let host: PluginRuntimeTestHost;

type Config = {
	version: number;
	expiryDays: number;
	layout: string;
	position: string;
	theme: string;
	accent: string;
	policyUrl: string;
	reopen: boolean;
	autoBlock: boolean;
	googleMode: string;
	discovery: boolean;
	show: boolean;
	texts: Record<string, string>;
	categories: Array<{ id: string; name: string; description: string; required: boolean; cookies: Array<{ name: string }> }>;
	known: string[];
};

const geo = (country: string | null) => ({ meta: { ip: null, userAgent: null, referer: null, geo: country ? { country, region: null, city: null } : null } });
const config = (country: string | null = null) => host.transport.invokeRoute("config", {}, { method: "GET", ...geo(country) }) as Promise<Config>;
const consent = (body: Record<string, unknown>, country: string | null = null) =>
	host.transport.invokeRoute("consent", body, { method: "POST", ...geo(country) }) as Promise<{ ok: boolean }>;
const found = (names: unknown) => host.transport.invokeRoute("found", { names, script: 1 }, { method: "POST" }) as Promise<{ ok: boolean; added?: number }>;

const choice = (id: string, action: "accept" | "reject" | "custom", c = { preferences: false, analytics: false, marketing: false }) =>
	consent({ id, action, categories: c, version: 1, script: 1 });

type AnyBlock = Record<string, unknown> & { type: string };
const tabs = (page: { blocks: unknown[] }) => (page.blocks[1] as { panels: Array<{ label: string; blocks: AnyBlock[] }> }).panels;
const tab = (page: { blocks: unknown[] }, label: string) => tabs(page).find((p) => p.label === label)!.blocks;
const texts = (blocks: AnyBlock[]) => JSON.stringify(blocks);

beforeEach(async () => {
	host = await createPluginRuntimeTestHost();
	await host.actions.plugin.activate();
});

afterEach(async () => {
	await host.dispose();
});

describe("what the visitor's browser receives", () => {
	it("has sensible defaults and four categories", async () => {
		const c = await config();
		expect(c.version).toBe(1);
		expect(c.expiryDays).toBe(360);
		expect(c.layout).toBe("box");
		expect(c.show).toBe(true);
		expect(c.autoBlock).toBe(true);
		expect(c.googleMode).toBe("block");
		expect(c.categories.map((x) => x.id)).toEqual(["necessary", "preferences", "analytics", "marketing"]);
		expect(c.categories[0]!.required).toBe(true);
		expect(c.categories[0]!.cookies.map((x) => x.name)).toEqual(["cc_consent"]);
		expect(c.known).toEqual(["cc_consent"]);
		expect(c.texts.accept).toBe("Accept all");
		expect(c.texts.reject).toBe("Reject all");
	});

	it("follows the saved banner settings and ignores bad values", async () => {
		await host.fixtures.plugin.setting("banner", {
			layout: "popup",
			position: "left",
			theme: "dark",
			accent: "#FF0000",
			policyUrl: "javascript:alert(1)",
			expiryMonths: 99,
			region: "eu",
			googleMode: "consent",
			autoBlock: false,
			reopen: false,
			discovery: false,
		});
		const c = await config("DE");
		expect(c.layout).toBe("popup");
		expect(c.position).toBe("left");
		expect(c.theme).toBe("dark");
		expect(c.accent).toBe("#ff0000");
		expect(c.policyUrl).toBe("");
		expect(c.expiryDays).toBe(24 * 30);
		expect(c.googleMode).toBe("consent");
		expect(c.autoBlock).toBe(false);
		expect(c.reopen).toBe(false);
		expect(c.discovery).toBe(false);
	});

	it("shows the banner only in Europe when asked, and everywhere when the country is unknown", async () => {
		await host.fixtures.plugin.setting("banner", { region: "eu" });
		expect((await config("FR")).show).toBe(true);
		expect((await config("GB")).show).toBe(true);
		expect((await config("CH")).show).toBe(true);
		expect((await config("IN")).show).toBe(false);
		expect((await config("US")).show).toBe(false);
		expect((await config(null)).show).toBe(true);
		await host.fixtures.plugin.setting("banner", { region: "all" });
		expect((await config("IN")).show).toBe(true);
	});

	it("lists cookies under their category and renamed categories keep their id", async () => {
		await host.fixtures.plugin.setting("categories", { analytics: { name: "Statistics", description: "Counts visits." } });
		await host.fixtures.plugin.setting("cookies", [
			{ name: "cc_consent", category: "necessary", provider: "This site", purpose: "Your choices", duration: "12 months" },
			{ name: "_ga", category: "analytics", provider: "Google", purpose: "Tells visitors apart", duration: "2 years" },
			{ name: "bad name!", category: "analytics", provider: "", purpose: "", duration: "" },
		]);
		const c = await config();
		const analytics = c.categories.find((x) => x.id === "analytics")!;
		expect(analytics.name).toBe("Statistics");
		expect(analytics.description).toBe("Counts visits.");
		expect(analytics.cookies.map((x) => x.name)).toEqual(["_ga"]);
		expect(c.known).toEqual(["cc_consent", "_ga"]);
	});
});

describe("recording a choice", () => {
	it("stores the proof without anything personal and counts it", async () => {
		expect(await choice("3f2a9c1e-1111-4222-8333-444455556666", "accept", { preferences: true, analytics: true, marketing: true }, )).toEqual({ ok: true });
		const rows = await host.inspect.storage.list<{ cid: string; action: string; categories: Record<string, boolean>; country: string | null }>("consents");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.data.cid).toBe("3f2a9c1e-1111-4222-8333-444455556666");
		expect(rows[0]!.data.action).toBe("accept");
		expect(rows[0]!.data.categories).toEqual({ preferences: true, analytics: true, marketing: true });
		expect(rows[0]!.data.country).toBeNull();
		expect(JSON.stringify(rows[0]!.data)).not.toMatch(/"ip"|userAgent/);

		await consent({ id: "abcdefgh-2", action: "custom", categories: { analytics: true }, version: 1, script: 1 }, "DE");
		await choice("abcdefgh-3", "reject");
		const days = await host.inspect.storage.list<Record<string, number>>("days");
		expect(days).toHaveLength(1);
		expect(days[0]!.data).toMatchObject({ total: 3, accept: 1, custom: 1, reject: 1, preferences: 1, analytics: 2, marketing: 1 });
		const all = await host.inspect.storage.list<{ country: string | null }>("consents");
		expect(all.map((r) => r.data.country).sort()).toEqual([null, null, "DE"].sort());
		expect(await host.inspect.kv.get("scriptVersion")).toBe(1);
	});

	it("rejects a bad consent id", async () => {
		expect(await choice("x", "accept")).toEqual({ ok: false });
		expect(await host.inspect.storage.list("consents")).toHaveLength(0);
	});
});

describe("cookie discovery", () => {
	it("keeps new names, skips listed ones, and can be switched off", async () => {
		expect(await found(["_ga", "_gid", "cc_consent", "bad name!", "_ga"])).toEqual({ ok: true, added: 3 });
		const rows = await host.inspect.storage.list<{ name: string; count: number }>("found");
		expect(rows.map((r) => r.data.name).sort()).toEqual(["_ga", "_gid"]);
		expect(rows.find((r) => r.data.name === "_ga")!.data.count).toBe(2);

		await host.fixtures.plugin.setting("banner", { discovery: false });
		expect(await found(["_fbp"])).toEqual({ ok: false });
	});

	it("shows them on the Cookies tab and adds one to a category in one click", async () => {
		await found(["_ga"]);
		const page = await host.admin.loadPage("/overview");
		const cookies = tab(page, "Cookies");
		const table = cookies.find((b) => b.type === "table" && (b as { page_action_id?: string }).page_action_id === "found_page") as unknown as { rows: Array<{ name: string; add: { items: Array<{ value: string }> } }> };
		expect(table.rows.map((r) => r.name)).toEqual(["_ga"]);
		expect(table.rows[0]!.add.items.map((i) => i.value)).toContain("analytics:_ga");

		const after = await host.admin.act("/overview", "found_menu", { value: "analytics:_ga" });
		expect(after.toast?.message).toContain("_ga added to Analytics");
		expect((await config()).categories.find((c) => c.id === "analytics")!.cookies.map((c) => c.name)).toEqual(["_ga"]);
		const foundTable = (blocks: AnyBlock[]) => blocks.find((b) => b.type === "table" && (b as { page_action_id?: string }).page_action_id === "found_page");
		expect(foundTable(tab(after, "Cookies"))).toBeUndefined();
		// The newly added cookie is opened for editing so the owner fills in provider and purpose.
		expect(texts(tab(after, "Cookies"))).toContain("Edit _ga");

		await found(["_fbp"]);
		const ignored = await host.admin.act("/overview", "found_menu", { value: "ignore:_fbp" });
		expect(ignored.toast?.message).toBe("_fbp ignored");
		expect(foundTable(tab(ignored, "Cookies"))).toBeUndefined();
	});
});

describe("asking everyone again", () => {
	it("bumps the consent version the browser compares against", async () => {
		expect((await config()).version).toBe(1);
		const res = await host.admin.act("/overview", "ask_again");
		expect(res.toast?.message).toContain("version 2");
		expect((await config()).version).toBe(2);
	});
});

describe("the admin page", () => {
	it("has five tabs and a setup banner before any choice is recorded", async () => {
		const page = await host.admin.loadPage("/overview");
		expect(tabs(page).map((p) => p.label)).toEqual(["Overview", "Banner", "Cookies", "Consent records", "Setup"]);
		const overview = tab(page, "Overview");
		expect(overview[0]!.type).toBe("banner");
		expect(texts(overview)).toContain("finish setup");
		expect(texts(tab(page, "Setup"))).toContain("cookie-consent.js");
	});

	it("shows the numbers once choices come in", async () => {
		await choice("abcdefgh-1", "accept", { preferences: true, analytics: true, marketing: true });
		await choice("abcdefgh-2", "reject");
		await choice("abcdefgh-3", "reject");
		await choice("abcdefgh-4", "custom", { preferences: false, analytics: true, marketing: false });
		const page = await host.admin.loadPage("/overview");
		const overview = tab(page, "Overview");
		expect(overview[0]!.type).not.toBe("banner");
		const stats = overview.find((b) => b.type === "stats") as unknown as { items: Array<{ label: string; value: string }> };
		expect(stats.items.map((i) => [i.label, i.value])).toEqual([
			["Choices made", "4"],
			["Accepted all", "25%"],
			["Rejected all", "50%"],
			["Chose for themselves", "25%"],
		]);
		const meters = (overview.find((b) => b.type === "columns") as unknown as { columns: AnyBlock[][] }).columns.map((c) => c[0] as unknown as { label: string; value: number });
		expect(meters.map((m) => [m.label, m.value])).toEqual([
			["Preferences", 25],
			["Analytics", 50],
			["Marketing", 25],
		]);
		expect(overview.some((b) => b.type === "chart")).toBe(true);
	});

	it("saves the banner settings and wording from the forms", async () => {
		const saved = await host.admin.submit("/overview", "save_banner", {
			layout: "bar",
			position: "left",
			theme: "light",
			accent: "#10b981",
			policyUrl: "/privacy",
			expiryMonths: 6,
			region: "eu",
			googleMode: "consent",
			autoBlock: true,
			reopen: false,
			discovery: true,
		});
		expect(saved.toast?.message).toBe("Banner saved");
		const c = await config("IN");
		expect(c.layout).toBe("bar");
		expect(c.policyUrl).toBe("/privacy");
		expect(c.expiryDays).toBe(180);
		expect(c.show).toBe(false);
		expect(c.reopen).toBe(false);

		const words = await host.admin.submit("/overview", "save_texts", { title: "Cookies?", accept: "Yes to all", message: "" });
		expect(words.toast?.message).toBe("Wording saved");
		const t = (await config()).texts;
		expect(t.title).toBe("Cookies?");
		expect(t.accept).toBe("Yes to all");
		expect(t.message).toContain("We use cookies");
	});

	it("saves categories and the cookie list, always keeping its own cookie", async () => {
		const cats = await host.admin.submit("/overview", "save_categories", {
			necessary_name: "Essential",
			necessary_description: "",
			analytics_name: "Statistics",
			analytics_description: "Counts.",
		});
		expect(cats.toast?.message).toBe("Categories saved");
		const c1 = await config();
		expect(c1.categories.find((c) => c.id === "necessary")!.name).toBe("Essential");
		expect(c1.categories.find((c) => c.id === "necessary")!.description).toContain("Needed for the site");
		expect(c1.categories.find((c) => c.id === "analytics")!.description).toBe("Counts.");

		const added = await host.admin.submit("/overview", "save_cookie", { name: "_ga", category: "analytics", provider: "Google", purpose: "Stats", duration: "2 years" }, { blockId: "cookie:" });
		expect(added.toast?.message).toBe("_ga added to Statistics");
		expect((await config()).known).toEqual(["cc_consent", "_ga"]);

		const edited = await host.admin.submit("/overview", "save_cookie", { name: "_ga", category: "marketing", provider: "Google", purpose: "Ads", duration: "2 years" }, { blockId: "cookie:_ga" });
		expect(edited.toast?.message).toBe("_ga saved");
		expect((await config()).categories.find((c) => c.id === "marketing")!.cookies.map((c) => c.name)).toEqual(["_ga"]);

		const bad = await host.admin.submit("/overview", "save_cookie", { name: "bad name!", category: "analytics" }, { blockId: "cookie:" });
		expect(bad.toast?.type).toBe("error");

		const list = tab(await host.admin.loadPage("/overview"), "Cookies").find((b) => b.type === "table") as unknown as { rows: Array<{ name: string; menu: { items: Array<{ value: string }> } }> };
		expect(list.rows.map((r) => r.name)).toEqual(["cc_consent", "_ga"]);
		expect(list.rows[0]!.menu.items.map((i) => i.value)).toEqual(["edit:cc_consent"]);

		const removed = await host.admin.act("/overview", "cookie_menu", { value: "remove:_ga" });
		expect(removed.toast?.message).toBe("_ga removed");
		expect((await config()).known).toEqual(["cc_consent"]);
		const kept = await host.admin.act("/overview", "cookie_menu", { value: "remove:cc_consent" });
		expect(kept.toast).toBeUndefined();
		expect((await config()).known).toEqual(["cc_consent"]);
	});

	it("lists consent records newest first and finds one by id", async () => {
		await choice("abcdefgh-1", "accept", { preferences: true, analytics: true, marketing: true });
		await choice("abcdefgh-2", "custom", { preferences: false, analytics: true, marketing: false });
		const page = await host.admin.loadPage("/overview");
		const table = tab(page, "Consent records").find((b) => b.type === "table") as unknown as { rows: Array<Record<string, unknown>> };
		expect(table.rows.map((r) => r.cid)).toEqual(["abcdefgh-2", "abcdefgh-1"]);
		expect(table.rows[0]!.categories).toBe("Analytics");
		expect(table.rows[1]!.action).toBe("Accepted all");

		const searched = await host.admin.submit("/overview", "find_record", { cid: "abcdefgh-1" });
		const hits = tab(searched, "Consent records").find((b) => b.type === "table") as unknown as { rows: Array<Record<string, unknown>> };
		expect(hits.rows.map((r) => r.cid)).toEqual(["abcdefgh-1"]);
	});
});

describe("the script file", () => {
	it("downloads as a text file with the current script version", async () => {
		const res = await host.actions.routes.request("script", { method: "GET" });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/plain");
		expect(res.headers.get("content-disposition")).toContain('filename="cookie-consent.js"');
		const body = await res.text();
		expect(body).toContain("SCRIPT_VERSION = 1");
		expect(body).toContain("/_emdash/api/plugins/cookie-consent");
		expect(body).toContain('gtag("consent", "default"');
	});
});

describe("cleanup", () => {
	it("drops records older than 13 months", async () => {
		await host.fixtures.plugin.storage("consents", "old.1", { cid: "old", at: "2024-01-01T00:00:00Z", day: "2024-01-01", action: "accept", categories: {}, version: 1, country: null, script: 1 });
		await host.fixtures.plugin.storage("days", "2024-01-01", { day: "2024-01-01", total: 1, accept: 1, reject: 0, custom: 0, preferences: 0, analytics: 0, marketing: 0 });
		await choice("abcdefgh-1", "accept");
		await host.transport.invokeHook("cron", { name: "cleanup" });
		expect((await host.inspect.storage.list("consents")).map((r) => r.id)).not.toContain("old.1");
		expect(await host.inspect.storage.list("consents")).toHaveLength(1);
		expect(await host.inspect.storage.list("days")).toHaveLength(1);
	});
});
