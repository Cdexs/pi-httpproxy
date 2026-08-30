/**
 * pi-httpproxy — Installs a domain-whitelist global network proxy on pi startup
 *
 * Publishable form of the local extension `proxy-autoload`.
 * Effect layers (triple coverage, works for all plugins):
 *  1. Global undici dispatcher: every request issued through undici's global
 *     slots inside the pi process (pi-web-access and any plugin's global fetch)
 *     is routed per the domain whitelist.
 *  2. globalThis.fetch wrapper: explicitly injects a dispatcher for whitelisted
 *     domains at request init — does not depend on the global slot, so it keeps
 *     working even if pi or another package later overwrites setGlobalDispatcher.
 *  3. PI_TELEGRAM_NETWORK_FAMILY=auto: by default (opt-out via config), pins
 *     pi-telegram's network strategy to "auto" so it always goes through the
 *     fetch path and is always covered by the proxy above.
 *
 * Whitelist hit → proxied via `proxy` URL; miss → direct connection.
 * Config: ~/.pi/proxy-domains.json; PROXY_URL / PROXY_DOMAINS env vars override.
 * If the config file does not define a "domains" array, a built-in default
 * whitelist (common blocked-region services) is used, so the extension works
 * out of the box: set PROXY_URL and go.
 * Hot reload: edit ~/.pi/proxy-domains.json, then run /httpproxy-reload in the
 * pi session (rebuilds the whitelist and ProxyAgent, no restart needed).
 * Proxy/domains locked by env vars are not touched by reload.
 * Debug: set PI_PROXY_DEBUG=1 before launch to print every routing decision.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

interface UndiciLike {
	Agent: unknown;
	ProxyAgent: unknown;
	setGlobalDispatcher: (d: unknown) => void;
}

interface HttpProxyOptions {
	proxy?: unknown;
	domains?: unknown;
	/**
	 * When true (default), sets PI_TELEGRAM_NETWORK_FAMILY=auto if unset, so
	 * pi-telegram never falls back to bare node:https requests that bypass
	 * undici (necessary behind a polluted/censored DNS). Set false to opt out.
	 */
	tapTelegramEnv?: boolean;
}

interface PiCommandContext {
	ui?: { notify?: (message: string, type?: string) => void };
}

/** Minimal structural typing for the part of pi's ExtensionAPI we use */
interface ExtensionAPI {
	registerCommand(name: string, opts: {
		description: string;
		handler: (args: string, ctx: PiCommandContext) => void;
	}): unknown;
}

const AGENT_DIR =
	process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi");

/**
 * Built-in fallback whitelist, applied when the config file does not define a
 * "domains" array (the very first run). Group labels are listed below purely
 * for readability — they are filtered out by domainLike().
 */
const DEFAULT_DOMAINS: string[] = [
	"Google",
	"google.com",
	"*.google.com",
	"googleapis.com",
	"*.googleapis.com",
	"gstatic.com",
	"*.gstatic.com",
	"googleusercontent.com",
	"*.googleusercontent.com",
	"recaptcha.net",
	"*.recaptcha.net",

	"GitHub",
	"github.com",
	"*.github.com",
	"githubusercontent.com",
	"*.githubusercontent.com",
	"githubassets.com",
	"*.githubassets.com",
	"ghcr.io",
	"*.ghcr.io",

	"Telegram",
	"telegram.org",
	"*.telegram.org",
	"t.me",
	"*.t.me",
	"telegram.me",
	"*.telegram.me",
	"cdn-telegram.org",
	"*.cdn-telegram.org",
	"telesco.pe",
	"*.telesco.pe",

	"Brave Search",
	"brave.com",
	"*.brave.com",
	"bravesoftware.com",
	"*.bravesoftware.com",

	"Hugging Face",
	"huggingface.co",
	"*.huggingface.co",
	"hf.co",
	"*.hf.co",

	"AI services",
	"openai.com",
	"*.openai.com",
	"oaiusercontent.com",
	"*.oaiusercontent.com",
	"anthropic.com",
	"*.anthropic.com",
	"claude.ai",
	"*.claude.ai",

	"Other",
	"npmjs.com",
	"*.npmjs.com",
	"gravatar.com",
	"*.gravatar.com",
	"imgur.com",
	"*.imgur.com",
	"media.githubusercontent.com",
].filter(domainLike);

const CONFIG_PATH = join(AGENT_DIR, "proxy-domains.json");

/**
 * Load undici from pi's bundled npm modules first (the agent runtime always
 * ships it), then fall back to normal `require("undici")` resolution from this
 * module's own install location (declared as an optional peerDependency, so it
 * resolves when npm hoisted it next to this package).
 */
function loadUndici(): UndiciLike | null {
	const candidates = [
		join(AGENT_DIR, "npm", "node_modules", "undici", "index.js"),
	];
	// Cover custom PI_CODING_AGENT_DIR vs. the default ~/.pi directory layout
	if (AGENT_DIR !== join(homedir(), ".pi")) {
		candidates.push(join(homedir(), ".pi", "agent", "npm", "node_modules", "undici", "index.js"));
	}
	for (const candidate of candidates) {
		try {
			const req = createRequire(join(AGENT_DIR, "noop.js"));
			if (existsSync(candidate)) return req(candidate) as UndiciLike;
		} catch {
			/* try next */
		}
	}
	try {
		return createRequire(import.meta.url)("undici") as UndiciLike;
	} catch {
		return null;
	}
}

/** Keep only domain-like entries; ignores group label lines in the JSON */
function domainLike(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^\*?\.?[a-z0-9][a-z0-9.-]*$/i.test(value.trim())
	);
}

function loadConfig(): {
	proxy: string;
	domains: string[];
	tapTelegramEnv: boolean;
	usingDefaults: boolean;
} {
	const envProxy = process.env.PROXY_URL?.trim();
	const envDomains = process.env.PROXY_DOMAINS
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	let cfgProxy = envProxy || "";
	let cfgDomains: string[] = [];
	// Fallback marker: true when neither env nor config specifies a whitelist
	let useDefaultDomains = !envDomains;
	let cfgTapTelegramEnv = true;

	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = JSON.parse(
				readFileSync(CONFIG_PATH, "utf-8")
			) as HttpProxyOptions;
			if (!cfgProxy && typeof raw.proxy === "string") cfgProxy = raw.proxy.trim();
			if (!envDomains && Array.isArray(raw.domains)) {
				cfgDomains = raw.domains.filter(domainLike);
				// config file explicitly defines a whitelist → don't fall back to defaults
				useDefaultDomains = false;
			}
			if (typeof raw.tapTelegramEnv === "boolean") {
				cfgTapTelegramEnv = raw.tapTelegramEnv;
			}
		} catch (err) {
			console.warn(
				`[pi-httpproxy] failed to parse config ${CONFIG_PATH}: ${err instanceof Error ? err.message : err}`
			);
		}
	}
	if (envDomains) {
		cfgDomains = envDomains;
	} else if (useDefaultDomains) {
		cfgDomains = DEFAULT_DOMAINS.slice();
	}
	return {
		proxy: cfgProxy,
		domains: cfgDomains,
		tapTelegramEnv: cfgTapTelegramEnv,
		usingDefaults: useDefaultDomains && cfgDomains.length > 0,
	};
}

/** Matching rules — exact | *.{base} | .{base} (case-insensitive) */
function matchRule(host: string, rule: string): boolean {
	const r = rule.toLowerCase().trim();
	const h = host.toLowerCase();
	if (r.startsWith("*.")) return h.endsWith("." + r.slice(2));
	if (r.startsWith(".")) return h === r.slice(1) || h.endsWith(r);
	return h === r;
}

// ── Module-level mutable runtime state: /httpproxy-reload only rebuilds
// these values; the routing logic itself stays installed ──
let installed = false;
let domains: string[] = [];
let proxyUri = "";
let proxyAgent: {
	dispatch: (opts: unknown, handler: unknown) => unknown;
	close?: () => void;
} | null = null;

interface ReloadResult {
	ok: boolean;
	message: string;
	changed: boolean;
}

/** Re-read the config and apply it in place (only useful after install). */
export function reloadProxyConfig(): ReloadResult {
	if (!installed || !proxyAgent) {
		return { ok: false, message: "✗ pi-httpproxy is not installed (routing not active)", changed: false };
	}
	try {
		if (!existsSync(CONFIG_PATH)) {
			return { ok: false, message: `✗ config file not found: ${CONFIG_PATH}`, changed: false };
		}
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const next = JSON.parse(raw) as { proxy?: unknown; domains?: unknown };
		const envDomainsLocked = !!process.env.PROXY_DOMAINS?.trim();
		const envProxyLocked = !!process.env.PROXY_URL?.trim();

		const nextDomains: string[] = envDomainsLocked
			? domains.slice()
			: Array.isArray(next.domains)
				? (next.domains as unknown[]).filter(domainLike)
				: DEFAULT_DOMAINS.slice(); // key removed: fall back to defaults, same as a fresh start
		const nextProxy = envProxyLocked
			? proxyUri
			: typeof next.proxy === "string" && next.proxy.trim()
				? next.proxy.trim()
				: proxyUri;

		const proxyChanged = nextProxy !== proxyUri;
		if (proxyChanged) {
			const old = proxyAgent;
			const undiciNow = loadUndici();
			if (!undiciNow) {
				return {
					ok: false,
					message: `✗ reload failed: undici module no longer loadable (keeping proxy=${proxyUri})`,
					changed: false,
				};
			}
			proxyAgent = new (undiciNow.ProxyAgent as new (uri: string) => {
				dispatch: (opts: unknown, handler: unknown) => unknown;
				close?: () => void;
			})(nextProxy);
			proxyUri = nextProxy;
			try {
				old.close?.();
			} catch {
				/* releasing the old connection pool, harmless if it fails */
			}
		}
		const changed =
			nextDomains.length !== domains.length ||
			nextDomains.some((d, i) => d !== domains[i]) ||
			proxyChanged;
		domains = nextDomains;
		const note = envDomainsLocked
			? " (PROXY_DOMAINS env override active, file whitelist ignored)"
			: envProxyLocked
				? " (PROXY_URL env override active, file proxy ignored)"
				: "";
		return {
			ok: true,
			message: `✓ whitelist reloaded: proxy=${proxyUri}, domains=${domains.length} rule(s)${note}`,
			changed,
		};
	} catch (err) {
		// mid-edit/half-written JSON: keep serving the old config
		return {
			ok: false,
			message: `✗ reload failed (keeping previous config, ${domains.length} rule(s)): ${err instanceof Error ? err.message : err}`,
			changed: false,
		};
	}
}

/** For querying at runtime from other code (optional) */
export function isProxied(url: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return domains.some((d) => matchRule(host, d));
	} catch {
		return false;
	}
}

export default function installHttpProxyAutoload(pi?: ExtensionAPI) {
	if (installed) return;
	installed = true;

	const cfg = loadConfig();
	if (!cfg.proxy) {
		console.warn(
			`[pi-httpproxy] no proxy address (${CONFIG_PATH} has no "proxy" field, or PROXY_URL is unset); routing not enabled`
		);
		return;
	}
	if (cfg.domains.length === 0) {
		console.warn("[pi-httpproxy] whitelist is empty; every request will go direct");
	} else if (cfg.usingDefaults) {
		console.warn(
			`[pi-httpproxy] using built-in default whitelist (${cfg.domains.length} rules); create ${CONFIG_PATH} to customize`
		);
	}

	const undici = loadUndici();
	if (!undici) {
		console.warn("[pi-httpproxy] could not load undici; proxy routing not enabled");
		return;
	}

	const dbg = process.env.PI_PROXY_DEBUG === "1";
	const { Agent, ProxyAgent } = undici as unknown as {
		Agent: new (opts?: object) => unknown;
		ProxyAgent: new (uri: string) => {
			dispatch: (opts: unknown, handler: unknown) => unknown;
			close?: () => void;
		};
	};

	proxyUri = cfg.proxy;
	proxyAgent = new ProxyAgent(proxyUri);
	domains = cfg.domains;
	const directAgent = new Agent();

	const dn = (d: unknown) =>
		(d as { constructor?: { name?: string } })?.constructor?.name ?? "unknown";

	const composite = {
		dispatch(opts: { origin?: unknown }, handler: unknown) {
			let hostname = "";
			try {
				hostname = new URL(String(opts.origin)).hostname;
			} catch {
				hostname = String(opts.origin ?? "");
			}
			const useProxy = domains.some((d) => matchRule(hostname, d));
			if (dbg && useProxy) console.log(`[pi-httpproxy] → proxy ${String(opts.origin)}`);
			const agent = useProxy ? proxyAgent! : directAgent;
			return (agent as {
				dispatch: (opts: unknown, handler: unknown) => unknown;
			}).dispatch(opts, handler);
		},
	};

	// ── Layer 1: global dispatcher (write both the modern .2 and legacy .1 slots) ──
	try {
		undici.setGlobalDispatcher(composite);
	} catch (err) {
		console.warn(
			`[pi-httpproxy] setGlobalDispatcher failed: ${err instanceof Error ? err.message : err}`
		);
	}
	try {
		// direct assignment as a fallback (effective when the property is not restricted)
		(globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.2")] =
			composite;
		(globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")] =
			composite;
	} catch {
		/* frozen globalThis etc. — ignore, layer 2 still applies */
	}

	// ── Layer 2: wrap globalThis.fetch, explicitly inject a dispatcher for whitelist hits ──
	const origFetch = globalThis.fetch;
	if (typeof origFetch === "function") {
		const wrapped = function (
			this: unknown,
			input: unknown,
			init?: RequestInit,
			...rest: unknown[]
		) {
			try {
				const url =
					typeof input === "string" || input instanceof URL
						? String(input)
						: typeof Request !== "undefined" && input instanceof Request
							? input.url
							: "";
				if (url) {
					const host = new URL(url).hostname;
					if (domains.some((d) => matchRule(host, d))) {
						const next: RequestInit & { dispatcher?: unknown } = { ...(init ?? {}) };
						next.dispatcher = next.dispatcher ?? proxyAgent;
						init = next;
						if (dbg) console.log(`[pi-httpproxy] fetch inject → ${host}`);
					}
				}
			} catch {
				/* unparseable input: pass through untouched */
			}
			return (origFetch as (...a: unknown[]) => Promise<Response>)(
				input,
				init,
				...rest
			);
		} as typeof globalThis.fetch;
		globalThis.fetch = wrapped;
	}

	// ── Layer 3: keep pi-telegram on the fetch path instead of bare node:https ──
	// Its default ipv4-fallback strategy degrades to requests that bypass
	// undici entirely; behind polluted local DNS those always time out.
	// "auto" keeps it on fetch, which is always covered by the proxy above.
	// Opt out with "tapTelegramEnv": false in the config file.
	if (
		cfg.tapTelegramEnv !== false &&
		!process.env.PI_TELEGRAM_NETWORK_FAMILY
	) {
		process.env.PI_TELEGRAM_NETWORK_FAMILY = "auto";
	}

	// ── Manual hot-reload command: /httpproxy-reload ──
	if (pi && typeof pi.registerCommand === "function") {
		pi.registerCommand("httpproxy-reload", {
			description:
				"Reload the global proxy domain whitelist (~/.pi/proxy-domains.json), takes effect in place without restarting pi",
			handler: (_args, ctx) => {
				const r = reloadProxyConfig();
				ctx?.ui?.notify?.(r.message, r.ok ? "info" : "warning");
				if (dbg || !r.ok) console.log(`[pi-httpproxy] /httpproxy-reload → ${r.message}`);
			},
		});
	}

	if (dbg) {
		console.log(
			`[pi-httpproxy] enabled: proxy=${proxyUri}, domains=${domains.length} rule(s), dispatchers=[${dn(proxyAgent)} <-> ${dn(directAgent)}], fetchWrapped=${globalThis.fetch !== origFetch}`
		);
	}
}