/*! Cookie Consent for EmDash. Put this file in your site's public folder and load it
    as the FIRST script in <head>, before any analytics or marketing tag. */
(function () {
	"use strict";
	var SCRIPT_VERSION = 1;
	var API = "/_emdash/api/plugins/cookie-consent";
	var COOKIE = "cc_consent";
	var OPTIONAL = ["preferences", "analytics", "marketing"];
	var d = document;
	var w = window;

	/* ------------------------------------------------------------------ */
	/* Saved choice                                                        */
	/* ------------------------------------------------------------------ */

	function readCookie() {
		var m = d.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]*)"));
		if (!m) return null;
		try {
			var v = JSON.parse(decodeURIComponent(m[1]));
			if (!v || typeof v !== "object" || !v.c || typeof v.id !== "string") return null;
			return v;
		} catch (e) {
			return null;
		}
	}
	function writeCookie(value, days) {
		var secure = location.protocol === "https:" ? "; Secure" : "";
		d.cookie =
			COOKIE + "=" + encodeURIComponent(JSON.stringify(value)) + "; Max-Age=" + days * 86400 + "; Path=/; SameSite=Lax" + secure;
	}
	function clearCookie() {
		d.cookie = COOKIE + "=; Max-Age=0; Path=/; SameSite=Lax";
	}
	function lsGet(key) {
		try {
			return JSON.parse(localStorage.getItem(key));
		} catch (e) {
			return null;
		}
	}
	function lsSet(key, value) {
		try {
			localStorage.setItem(key, JSON.stringify(value));
		} catch (e) {}
	}
	function uuid() {
		if (w.crypto && crypto.randomUUID) return crypto.randomUUID();
		var s = "";
		for (var i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
		return s.slice(0, 8) + "-" + s.slice(8, 12) + "-4" + s.slice(13, 16) + "-a" + s.slice(17, 20) + "-" + s.slice(20);
	}

	var saved = readCookie();
	// Settings that must be known before the config arrives are cached from the last visit.
	var sync = lsGet("cc_sync") || { autoBlock: true, googleMode: "block", version: null };
	/** null until the visitor chooses. Otherwise { preferences, analytics, marketing }. */
	var consent = saved ? saved.c : null;
	// A choice made under an older consent version no longer counts. The id is kept so the record stays linked.
	if (saved && typeof sync.version === "number" && saved.v !== sync.version) consent = null;
	/** Set when the banner is not shown in this region: everything may run, nothing is recorded. */
	var implied = false;
	function allowed(cat) {
		if (cat === "necessary") return true;
		if (implied && !consent) return true;
		return !!(consent && consent[cat]);
	}

	/* ------------------------------------------------------------------ */
	/* Google Consent Mode v2, before any tag loads                        */
	/* ------------------------------------------------------------------ */

	w.dataLayer = w.dataLayer || [];
	function gtag() {
		w.dataLayer.push(arguments);
	}
	function signals(c) {
		var g = function (on) {
			return on ? "granted" : "denied";
		};
		return {
			ad_storage: g(c.marketing),
			ad_user_data: g(c.marketing),
			ad_personalization: g(c.marketing),
			analytics_storage: g(c.analytics),
			functionality_storage: g(c.preferences),
			personalization_storage: g(c.preferences),
			security_storage: "granted",
		};
	}
	var defaults = signals(consent || {});
	defaults.wait_for_update = 500;
	gtag("consent", "default", defaults);
	if (consent) gtag("consent", "update", signals(consent));

	/* ------------------------------------------------------------------ */
	/* Blocking: tagged scripts and well-known trackers                    */
	/* ------------------------------------------------------------------ */

	var KNOWN = [
		{ re: /googletagmanager\.com\/(gtm|gtag)/i, cat: "analytics", google: true },
		{ re: /google-analytics\.com|analytics\.google\.com/i, cat: "analytics", google: true },
		{ re: /hotjar\.com|clarity\.ms|fullstory\.com|mouseflow\.com|crazyegg\.com|mixpanel\.com|cdn\.segment\.com|amplitude\.com|heapanalytics\.com|cdn\.matomo\.cloud|static\.cloudflareinsights\.com/i, cat: "analytics" },
		{ re: /googleadservices\.com|googlesyndication\.com|doubleclick\.net|adsbygoogle/i, cat: "marketing", google: true },
		{ re: /connect\.facebook\.net|facebook\.com\/tr|snap\.licdn\.com|analytics\.tiktok\.com|ads-twitter\.com|ct\.pinterest\.com|bat\.bing\.com|hs-scripts\.com|sc-static\.net|adroll\.com|criteo\.(com|net)|taboola\.com|outbrain\.com/i, cat: "marketing" },
	];
	var EMBEDS = [
		{ re: /youtube\.com\/embed|youtube\.com\/v\//i, cat: "marketing" },
		{ re: /player\.vimeo\.com/i, cat: "marketing" },
		{ re: /google\.com\/maps\/embed|maps\.google\.com/i, cat: "marketing" },
		{ re: /facebook\.com\/plugins|instagram\.com\/(p|reel)\/|tiktok\.com\/embed|open\.spotify\.com\/embed|platform\.twitter\.com|x\.com\/embed/i, cat: "marketing" },
	];
	function categoryOf(node, list) {
		var tagged = node.getAttribute("data-cc");
		if (tagged) return OPTIONAL.indexOf(tagged) >= 0 ? tagged : "necessary";
		if (!sync.autoBlock) return null;
		var src = node.getAttribute("src") || node.getAttribute("data-src") || "";
		if (!src) return null;
		for (var i = 0; i < list.length; i++) {
			if (list[i].re.test(src)) {
				if (list[i].google && sync.googleMode !== "block") return null;
				return list[i].cat;
			}
		}
		return null;
	}

	var blockedScripts = [];
	function holdScript(s) {
		if (s.getAttribute("data-cc-held") || s.getAttribute("data-cc-done")) return;
		var cat = categoryOf(s, KNOWN);
		if (!cat || allowed(cat)) return;
		s.setAttribute("data-cc", cat);
		s.setAttribute("data-cc-held", "1");
		if (s.getAttribute("src")) {
			s.setAttribute("data-cc-src", s.getAttribute("src"));
			s.removeAttribute("src");
		}
		s.type = "text/plain";
		blockedScripts.push({ node: s, parent: s.parentNode, next: s.nextSibling });
		if (s.parentNode) s.parentNode.removeChild(s);
	}
	function releaseScript(entry) {
		var s = entry.node;
		if (s.getAttribute("data-cc-done")) return;
		var cat = s.getAttribute("data-cc");
		if (!allowed(cat)) return;
		s.setAttribute("data-cc-done", "1");
		var n = d.createElement("script");
		for (var i = 0; i < s.attributes.length; i++) {
			var a = s.attributes[i];
			if (a.name === "type" || a.name === "src" || a.name.indexOf("data-cc") === 0) continue;
			n.setAttribute(a.name, a.value);
		}
		var src = s.getAttribute("data-cc-src") || s.getAttribute("src");
		if (src) n.src = src;
		else n.text = s.text;
		var parent = (entry.parent && entry.parent.isConnected && entry.parent) || d.head || d.documentElement;
		if (s.parentNode === parent) parent.replaceChild(n, s);
		else parent.appendChild(n);
	}

	var blockedFrames = [];
	function holdFrame(f) {
		if (f.getAttribute("data-cc-held") || f.getAttribute("data-cc-done")) return;
		var cat = categoryOf(f, EMBEDS);
		if (!cat || allowed(cat)) return;
		var src = f.getAttribute("src") || f.getAttribute("data-src");
		if (!src) return;
		f.setAttribute("data-cc", cat);
		f.setAttribute("data-cc-held", "1");
		f.setAttribute("data-cc-src", src);
		f.setAttribute("src", "about:blank");
		f.style.display = "none";
		blockedFrames.push(f);
		if (cfg) placeholderFor(f);
	}
	function placeholderFor(f) {
		if (f.getAttribute("data-cc-ph") || !f.parentNode) return;
		var cat = f.getAttribute("data-cc");
		var box = el("div", "cc-placeholder");
		box.setAttribute("data-cc-ph-for", cat);
		var wdt = f.getAttribute("width");
		var hgt = f.getAttribute("height");
		if (wdt && /^\d+$/.test(wdt)) box.style.maxWidth = wdt + "px";
		box.style.minHeight = hgt && /^\d+$/.test(hgt) ? Math.min(+hgt, 400) + "px" : "180px";
		var p = el("p", "", cfg.texts.blockedEmbed.replace("{category}", catName(cat)));
		var b = el("button", "cc-btn cc-btn-primary", cfg.texts.allowEmbed.replace("{category}", catName(cat)));
		b.type = "button";
		b.addEventListener("click", function () {
			var c = copyConsent();
			c[cat] = true;
			choose(c);
		});
		box.appendChild(p);
		box.appendChild(b);
		f.setAttribute("data-cc-ph", "1");
		f.parentNode.insertBefore(box, f);
		f.ccPlaceholder = box;
	}
	function releaseFrame(f) {
		if (f.getAttribute("data-cc-done") || !allowed(f.getAttribute("data-cc"))) return;
		f.setAttribute("data-cc-done", "1");
		f.style.display = "";
		f.setAttribute("src", f.getAttribute("data-cc-src"));
		if (f.ccPlaceholder && f.ccPlaceholder.parentNode) f.ccPlaceholder.parentNode.removeChild(f.ccPlaceholder);
	}

	function scan(root) {
		var i;
		var scripts = root.querySelectorAll ? root.querySelectorAll("script") : [];
		for (i = 0; i < scripts.length; i++) holdScript(scripts[i]);
		var frames = root.querySelectorAll ? root.querySelectorAll("iframe") : [];
		for (i = 0; i < frames.length; i++) holdFrame(frames[i]);
	}
	new MutationObserver(function (records) {
		for (var r = 0; r < records.length; r++) {
			var added = records[r].addedNodes;
			for (var i = 0; i < added.length; i++) {
				var n = added[i];
				if (n.nodeType !== 1) continue;
				if (n.tagName === "SCRIPT") holdScript(n);
				else if (n.tagName === "IFRAME") holdFrame(n);
				else scan(n);
			}
		}
	}).observe(d.documentElement, { childList: true, subtree: true });
	scan(d.documentElement);

	/** Run everything the visitor has allowed: held scripts, tagged scripts, embeds. */
	function apply() {
		var i;
		var tagged = d.querySelectorAll('script[type="text/plain"][data-cc]:not([data-cc-held])');
		for (i = 0; i < tagged.length; i++) {
			if (allowed(tagged[i].getAttribute("data-cc"))) releaseScript({ node: tagged[i], parent: tagged[i].parentNode });
		}
		for (i = 0; i < blockedScripts.length; i++) releaseScript(blockedScripts[i]);
		for (i = 0; i < blockedFrames.length; i++) releaseFrame(blockedFrames[i]);
		var plain = d.querySelectorAll("iframe[data-cc][data-src]:not([data-cc-held]):not([data-cc-done])");
		for (i = 0; i < plain.length; i++) {
			if (allowed(plain[i].getAttribute("data-cc"))) {
				plain[i].setAttribute("data-cc-done", "1");
				plain[i].setAttribute("src", plain[i].getAttribute("data-src"));
			}
		}
	}

	/* ------------------------------------------------------------------ */
	/* Config                                                              */
	/* ------------------------------------------------------------------ */

	var cfg = null;
	function catName(id) {
		for (var i = 0; i < cfg.categories.length; i++) if (cfg.categories[i].id === id) return cfg.categories[i].name;
		return id;
	}
	function copyConsent() {
		var c = {};
		for (var i = 0; i < OPTIONAL.length; i++) c[OPTIONAL[i]] = !!(consent && consent[OPTIONAL[i]]);
		return c;
	}
	function allOf(value) {
		var c = {};
		for (var i = 0; i < OPTIONAL.length; i++) c[OPTIONAL[i]] = value;
		return c;
	}

	function load() {
		var q = "?v=" + SCRIPT_VERSION + (d.documentElement.lang ? "&l=" + encodeURIComponent(d.documentElement.lang) : "");
		fetch(API + "/config" + q, { credentials: "same-origin" })
			.then(function (r) {
				return r.ok ? r.json() : null;
			})
			.then(function (res) {
				if (!res || !res.data || !res.data.categories) return;
				start(res.data);
			})
			.catch(function () {});
	}

	function start(c) {
		cfg = c;
		lsSet("cc_sync", { autoBlock: !!cfg.autoBlock, googleMode: cfg.googleMode, version: cfg.version });
		injectStyle();
		var i;
		for (i = 0; i < blockedFrames.length; i++) placeholderFor(blockedFrames[i]);

		var needChoice = !saved || saved.v !== cfg.version;
		if (needChoice && consent) {
			// The owner asked everyone again since this choice was made. From here on nothing optional runs until the visitor answers.
			consent = null;
			gtag("consent", "update", signals({}));
		}
		if (!cfg.show) {
			// Outside the regions the owner chose. No banner, nothing recorded; the visitor can still open settings.
			implied = true;
			if (saved && saved.v === cfg.version) implied = false;
			apply();
			if (cfg.reopen) mountReopen();
		} else if (needChoice) {
			showBanner();
		} else {
			apply();
			if (cfg.reopen) mountReopen();
		}
		d.addEventListener("click", function (e) {
			var t = e.target && e.target.closest ? e.target.closest("[data-cc-open]") : null;
			if (t) {
				e.preventDefault();
				openPreferences();
			}
		});
		if (cfg.discovery) setTimeout(report, 2500);
		d.dispatchEvent(new CustomEvent("cc:ready", { detail: { consent: consent ? copyConsent() : null } }));
	}

	/* ------------------------------------------------------------------ */
	/* Choosing                                                            */
	/* ------------------------------------------------------------------ */

	function choose(c) {
		var allOn = true;
		var allOff = true;
		for (var i = 0; i < OPTIONAL.length; i++) {
			if (c[OPTIONAL[i]]) allOff = false;
			else allOn = false;
		}
		var action = allOn ? "accept" : allOff ? "reject" : "custom";
		var id = saved && saved.id ? saved.id : uuid();
		saved = { id: id, v: cfg.version, t: new Date().toISOString(), a: action, c: c };
		consent = c;
		implied = false;
		writeCookie(saved, cfg.expiryDays);
		gtag("consent", "update", signals(c));
		w.dataLayer.push({ event: "cc_consent_update", cc_consent: copyConsent() });
		fetch(API + "/consent", {
			method: "POST",
			keepalive: true,
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: id, action: action, categories: c, version: cfg.version, script: SCRIPT_VERSION }),
		}).catch(function () {});
		apply();
		closeAll();
		if (cfg.reopen) mountReopen();
		d.dispatchEvent(new CustomEvent("cc:consent", { detail: { id: id, action: action, categories: copyConsent() } }));
	}

	/* ------------------------------------------------------------------ */
	/* Cookie discovery: names only, once per name per day per browser     */
	/* ------------------------------------------------------------------ */

	function isKnown(name) {
		for (var i = 0; i < cfg.known.length; i++) {
			var k = cfg.known[i];
			if (k.charAt(k.length - 1) === "*" ? name.indexOf(k.slice(0, -1)) === 0 : name === k) return true;
		}
		return false;
	}
	function report() {
		var today = new Date().toISOString().slice(0, 10);
		var seen = lsGet("cc_seen") || {};
		var names = d.cookie.split(";");
		var fresh = [];
		for (var i = 0; i < names.length; i++) {
			var n = names[i].split("=")[0].replace(/^\s+|\s+$/g, "");
			if (!n || n === COOKIE || isKnown(n) || seen[n] === today) continue;
			seen[n] = today;
			fresh.push(n);
		}
		if (!fresh.length) return;
		lsSet("cc_seen", seen);
		fetch(API + "/found", {
			method: "POST",
			keepalive: true,
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ names: fresh.slice(0, 50), script: SCRIPT_VERSION }),
		}).catch(function () {});
	}

	/* ------------------------------------------------------------------ */
	/* UI                                                                  */
	/* ------------------------------------------------------------------ */

	function el(tag, cls, text) {
		var n = d.createElement(tag);
		if (cls) n.className = cls;
		if (text != null) n.textContent = text;
		return n;
	}
	function btn(label, cls, onClick) {
		var b = el("button", "cc-btn " + cls, label);
		b.type = "button";
		b.addEventListener("click", onClick);
		return b;
	}
	function policyLink() {
		if (!cfg.policyUrl) return null;
		var a = el("a", "cc-link", cfg.texts.policyLabel);
		a.href = cfg.policyUrl;
		return a;
	}
	function injectStyle() {
		if (d.getElementById("cc-style")) return;
		var s = el("style");
		s.id = "cc-style";
		s.textContent = CSS.replace(/__ACCENT__/g, cfg.accent);
		d.head.appendChild(s);
		d.documentElement.setAttribute("data-cc-theme", cfg.theme);
	}

	var banner = null;
	var modal = null;
	var overlay = null;
	var reopenBtn = null;
	var lastFocus = null;

	function showOverlay() {
		if (overlay) return;
		overlay = el("div", "cc-overlay");
		d.body.appendChild(overlay);
	}
	function hideOverlay() {
		if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
		overlay = null;
	}

	function showBanner() {
		if (banner) return;
		if (!d.body) return setTimeout(showBanner, 50);
		if (cfg.layout === "popup") showOverlay();
		banner = el("div", "cc-banner cc-layout-" + cfg.layout + " cc-pos-" + cfg.position);
		banner.id = "cc-banner";
		banner.setAttribute("role", "dialog");
		banner.setAttribute("aria-modal", cfg.layout === "popup" ? "true" : "false");
		banner.setAttribute("aria-labelledby", "cc-banner-title");
		banner.setAttribute("aria-describedby", "cc-banner-text");
		var body = el("div", "cc-banner-body");
		var h = el("h2", "cc-title", cfg.texts.title);
		h.id = "cc-banner-title";
		var p = el("p", "cc-text", cfg.texts.message + " ");
		p.id = "cc-banner-text";
		var link = policyLink();
		if (link) p.appendChild(link);
		body.appendChild(h);
		body.appendChild(p);
		var actions = el("div", "cc-actions");
		actions.appendChild(
			btn(cfg.texts.accept, "cc-btn-primary", function () {
				choose(allOf(true));
			}),
		);
		actions.appendChild(
			btn(cfg.texts.reject, "cc-btn-primary", function () {
				choose(allOf(false));
			}),
		);
		actions.appendChild(btn(cfg.texts.manage, "cc-btn-ghost", openPreferences));
		banner.appendChild(body);
		banner.appendChild(actions);
		d.body.appendChild(banner);
		if (reopenBtn) reopenBtn.style.display = "none";
		var first = banner.querySelector("button");
		if (first && cfg.layout === "popup") first.focus();
	}
	function hideBanner() {
		if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
		banner = null;
		if (cfg.layout === "popup" && !modal) hideOverlay();
	}

	function toggleRow(cat, checked) {
		var row = el("div", "cc-cat");
		var head = el("div", "cc-cat-head");
		var label = el("label", "cc-switch");
		var input = el("input");
		input.type = "checkbox";
		input.setAttribute("role", "switch");
		input.checked = checked;
		input.disabled = !!cat.required;
		input.setAttribute("data-cc-cat", cat.id);
		input.setAttribute("aria-label", cat.name);
		var slider = el("span", "cc-slider");
		label.appendChild(input);
		label.appendChild(slider);
		var name = el("div", "cc-cat-name", cat.name);
		if (cat.required) name.appendChild(el("span", "cc-always", cfg.texts.alwaysActive));
		head.appendChild(name);
		head.appendChild(label);
		row.appendChild(head);
		row.appendChild(el("p", "cc-cat-desc", cat.description));
		if (cat.cookies && cat.cookies.length) {
			var det = el("details", "cc-cookies");
			det.appendChild(el("summary", "", cfg.texts.showCookies.replace("{count}", String(cat.cookies.length))));
			var table = el("table");
			var thead = el("thead");
			var tr = el("tr");
			var heads = [cfg.texts.colName, cfg.texts.colProvider, cfg.texts.colPurpose, cfg.texts.colDuration];
			for (var i = 0; i < heads.length; i++) tr.appendChild(el("th", "", heads[i]));
			thead.appendChild(tr);
			table.appendChild(thead);
			var tbody = el("tbody");
			for (var j = 0; j < cat.cookies.length; j++) {
				var ck = cat.cookies[j];
				var r = el("tr");
				r.appendChild(el("td", "cc-mono", ck.name));
				r.appendChild(el("td", "", ck.provider));
				r.appendChild(el("td", "", ck.purpose));
				r.appendChild(el("td", "", ck.duration));
				tbody.appendChild(r);
			}
			table.appendChild(tbody);
			det.appendChild(table);
			row.appendChild(det);
		}
		return row;
	}

	function openPreferences() {
		if (modal) return;
		if (!d.body) return;
		lastFocus = d.activeElement;
		showOverlay();
		modal = el("div", "cc-modal");
		modal.id = "cc-modal";
		modal.setAttribute("role", "dialog");
		modal.setAttribute("aria-modal", "true");
		modal.setAttribute("aria-labelledby", "cc-modal-title");
		var head = el("div", "cc-modal-head");
		var h = el("h2", "cc-title", cfg.texts.prefTitle);
		h.id = "cc-modal-title";
		var close = btn("×", "cc-close", closePreferences);
		close.setAttribute("aria-label", cfg.texts.close);
		head.appendChild(h);
		head.appendChild(close);
		var bodyEl = el("div", "cc-modal-body");
		var intro = el("p", "cc-text", cfg.texts.prefIntro + " ");
		var link = policyLink();
		if (link) intro.appendChild(link);
		bodyEl.appendChild(intro);
		var current = consent || (implied ? allOf(true) : allOf(false));
		for (var i = 0; i < cfg.categories.length; i++) {
			var cat = cfg.categories[i];
			bodyEl.appendChild(toggleRow(cat, cat.required ? true : !!current[cat.id]));
		}
		var foot = el("div", "cc-modal-foot");
		var actions = el("div", "cc-actions");
		actions.appendChild(
			btn(cfg.texts.save, "cc-btn-primary", function () {
				var c = {};
				var inputs = modal.querySelectorAll("input[data-cc-cat]");
				for (var k = 0; k < inputs.length; k++) {
					var id = inputs[k].getAttribute("data-cc-cat");
					if (id !== "necessary") c[id] = inputs[k].checked;
				}
				choose(c);
			}),
		);
		actions.appendChild(
			btn(cfg.texts.accept, "cc-btn-secondary", function () {
				choose(allOf(true));
			}),
		);
		actions.appendChild(
			btn(cfg.texts.reject, "cc-btn-secondary", function () {
				choose(allOf(false));
			}),
		);
		foot.appendChild(actions);
		if (saved && saved.id) {
			foot.appendChild(el("p", "cc-meta", cfg.texts.consentId + ": " + saved.id + " · " + new Date(saved.t).toLocaleString()));
		}
		modal.appendChild(head);
		modal.appendChild(bodyEl);
		modal.appendChild(foot);
		d.body.appendChild(modal);
		modal.addEventListener("keydown", trapFocus);
		d.addEventListener("keydown", onEscape);
		if (banner) banner.style.display = "none";
		close.focus();
	}
	function closePreferences() {
		if (!modal) return;
		modal.removeEventListener("keydown", trapFocus);
		d.removeEventListener("keydown", onEscape);
		if (modal.parentNode) modal.parentNode.removeChild(modal);
		modal = null;
		if (banner) banner.style.display = "";
		if (!(banner && cfg.layout === "popup")) hideOverlay();
		if (lastFocus && lastFocus.focus) lastFocus.focus();
	}
	function closeAll() {
		closePreferences();
		hideBanner();
	}
	function onEscape(e) {
		if (e.key === "Escape") closePreferences();
	}
	function trapFocus(e) {
		if (e.key !== "Tab" || !modal) return;
		var items = modal.querySelectorAll("button, a[href], input:not([disabled]), summary");
		if (!items.length) return;
		var first = items[0];
		var last = items[items.length - 1];
		if (e.shiftKey && d.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && d.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	function mountReopen() {
		if (reopenBtn) {
			reopenBtn.style.display = "";
			return;
		}
		if (!d.body) return setTimeout(mountReopen, 50);
		reopenBtn = btn(cfg.texts.reopen, "cc-reopen cc-pos-" + (cfg.position === "right" ? "left" : "right"), openPreferences);
		reopenBtn.id = "cc-reopen";
		reopenBtn.setAttribute("aria-label", cfg.texts.reopen);
		reopenBtn.insertBefore(cookieIcon(), reopenBtn.firstChild);
		d.body.appendChild(reopenBtn);
	}
	function cookieIcon() {
		var span = el("span", "cc-icon");
		span.innerHTML =
			'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/><circle cx="8.5" cy="8.5" r="1"/><circle cx="16" cy="15.5" r="1"/><circle cx="9.5" cy="15" r="1"/></svg>';
		return span;
	}

	/* ------------------------------------------------------------------ */
	/* Public API                                                          */
	/* ------------------------------------------------------------------ */

	w.CookieConsent = {
		version: SCRIPT_VERSION,
		show: function () {
			if (cfg) openPreferences();
		},
		showBanner: function () {
			if (cfg) showBanner();
		},
		hide: closeAll,
		getConsent: function () {
			return consent ? copyConsent() : null;
		},
		getId: function () {
			return saved ? saved.id : null;
		},
		accept: function (cats) {
			if (!cfg) return;
			if (!cats || cats === "all") return choose(allOf(true));
			var c = copyConsent();
			for (var i = 0; i < cats.length; i++) if (OPTIONAL.indexOf(cats[i]) >= 0) c[cats[i]] = true;
			choose(c);
		},
		reject: function () {
			if (cfg) choose(allOf(false));
		},
		reset: function () {
			clearCookie();
			saved = null;
			consent = null;
			if (cfg) showBanner();
		},
		allowed: allowed,
	};

	/* ------------------------------------------------------------------ */
	/* Styles                                                              */
	/* ------------------------------------------------------------------ */

	var CSS =
		":root{--cc-bg:#ffffff;--cc-fg:#111827;--cc-muted:#4b5563;--cc-border:#e5e7eb;--cc-accent:__ACCENT__;--cc-accent-fg:#ffffff;--cc-radius:12px;--cc-shadow:0 12px 40px rgba(0,0,0,.18);--cc-font:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
		"html[data-cc-theme=dark]{--cc-bg:#1f2937;--cc-fg:#f9fafb;--cc-muted:#d1d5db;--cc-border:#374151}" +
		"@media(prefers-color-scheme:dark){html[data-cc-theme=auto]{--cc-bg:#1f2937;--cc-fg:#f9fafb;--cc-muted:#d1d5db;--cc-border:#374151}}" +
		".cc-banner,.cc-modal,.cc-reopen,.cc-placeholder{font:15px/1.5 var(--cc-font);color:var(--cc-fg);box-sizing:border-box}" +
		".cc-banner *,.cc-modal *,.cc-placeholder *{box-sizing:border-box}" +
		".cc-banner{position:fixed;z-index:2147483000;background:var(--cc-bg);border:1px solid var(--cc-border);box-shadow:var(--cc-shadow);padding:20px 22px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}" +
		".cc-layout-bar{left:0;right:0;bottom:0;border-radius:0;border-width:1px 0 0 0}" +
		".cc-layout-bar .cc-banner-body{flex:1 1 360px}" +
		".cc-layout-box{bottom:20px;width:min(420px,calc(100vw - 32px));border-radius:var(--cc-radius);flex-direction:column;align-items:stretch}" +
		".cc-layout-box.cc-pos-right{right:16px}.cc-layout-box.cc-pos-left{left:16px}" +
		".cc-layout-popup{left:50%;top:50%;transform:translate(-50%,-50%);width:min(520px,calc(100vw - 32px));border-radius:var(--cc-radius);flex-direction:column;align-items:stretch}" +
		".cc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147482999}" +
		".cc-title{margin:0 0 6px;font-size:17px;font-weight:700;line-height:1.3}" +
		".cc-text{margin:0;color:var(--cc-muted)}" +
		".cc-link{color:var(--cc-fg);text-decoration:underline}" +
		".cc-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}" +
		".cc-btn{font:inherit;font-weight:600;border-radius:8px;padding:10px 16px;cursor:pointer;border:1px solid transparent;line-height:1.2}" +
		".cc-btn-primary{background:var(--cc-accent);color:var(--cc-accent-fg)}" +
		".cc-btn-secondary{background:transparent;color:var(--cc-fg);border-color:var(--cc-border)}" +
		".cc-btn-ghost{background:transparent;color:var(--cc-fg);text-decoration:underline;padding-left:6px;padding-right:6px}" +
		".cc-btn:focus-visible{outline:3px solid var(--cc-accent);outline-offset:2px}" +
		".cc-modal{position:fixed;z-index:2147483001;left:50%;top:50%;transform:translate(-50%,-50%);width:min(640px,calc(100vw - 24px));max-height:calc(100vh - 32px);display:flex;flex-direction:column;background:var(--cc-bg);border-radius:var(--cc-radius);box-shadow:var(--cc-shadow);border:1px solid var(--cc-border)}" +
		".cc-modal-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 10px}" +
		".cc-close{font-size:26px;line-height:1;padding:2px 8px;background:transparent;color:var(--cc-muted);border:0}" +
		".cc-modal-body{overflow:auto;padding:0 22px 10px}" +
		".cc-modal-foot{padding:14px 22px 18px;border-top:1px solid var(--cc-border)}" +
		".cc-meta{margin:10px 0 0;font-size:12px;color:var(--cc-muted);word-break:break-all}" +
		".cc-cat{border-top:1px solid var(--cc-border);padding:14px 0}" +
		".cc-cat-head{display:flex;align-items:center;justify-content:space-between;gap:12px}" +
		".cc-cat-name{font-weight:600}" +
		".cc-always{margin-left:8px;font-size:12px;font-weight:500;color:var(--cc-muted)}" +
		".cc-cat-desc{margin:6px 0 0;color:var(--cc-muted);font-size:14px}" +
		".cc-switch{position:relative;display:inline-block;width:44px;height:24px;flex:none}" +
		".cc-switch input{opacity:0;width:0;height:0;position:absolute}" +
		".cc-slider{position:absolute;inset:0;background:#9ca3af;border-radius:24px;transition:.15s}" +
		".cc-slider:before{content:'';position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}" +
		".cc-switch input:checked+.cc-slider{background:var(--cc-accent)}" +
		".cc-switch input:checked+.cc-slider:before{transform:translateX(20px)}" +
		".cc-switch input:disabled+.cc-slider{opacity:.55;cursor:not-allowed}" +
		".cc-switch input:focus-visible+.cc-slider{outline:3px solid var(--cc-accent);outline-offset:2px}" +
		".cc-cookies{margin-top:8px;font-size:13px}" +
		".cc-cookies summary{cursor:pointer;color:var(--cc-muted)}" +
		".cc-cookies table{width:100%;border-collapse:collapse;margin-top:8px}" +
		".cc-cookies th,.cc-cookies td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--cc-border);vertical-align:top}" +
		".cc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}" +
		".cc-reopen{position:fixed;bottom:16px;z-index:2147482998;display:inline-flex;align-items:center;gap:8px;background:var(--cc-bg);color:var(--cc-fg);border:1px solid var(--cc-border);border-radius:999px;padding:8px 14px;font:600 13px var(--cc-font);box-shadow:0 4px 16px rgba(0,0,0,.15);cursor:pointer}" +
		".cc-reopen.cc-pos-left{left:16px}.cc-reopen.cc-pos-right{right:16px}" +
		".cc-icon{display:inline-flex}" +
		".cc-placeholder{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;text-align:center;padding:24px;background:var(--cc-bg);border:1px dashed var(--cc-border);border-radius:var(--cc-radius);margin:8px 0}" +
		"@media(max-width:600px){.cc-banner{padding:16px}.cc-actions .cc-btn{flex:1 1 auto}.cc-layout-box{left:16px;right:16px;width:auto}}";

	/* ------------------------------------------------------------------ */

	load();
})();
