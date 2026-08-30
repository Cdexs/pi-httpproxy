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
 * Config: ~/.pi/proxy-domains.json is the primary source of truth;
 * PROXY_URL / PROXY_DOMAINS env vars only fill in fields it omits.
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
import { connect as netConnect } from "node:net";

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

/**
 * Built-in fallback proxy address (Clash-family default port), used when the
 * user has given no proxy anywhere (env / config file / system proxy env).
 * Verified by a reachability check before it is trusted — if nothing is
 * listening there, the extension stays fully direct and tells the user how to
 * configure their real proxy, so out-of-box behavior can never break a
 * machine without a local proxy.
 */
const DEFAULT_PROXY = "http://127.0.0.1:7890";

const CONFIG_PATH = join(AGENT_DIR, "proxy-domains.json");

/**
 * Load undici from pi's bundled npm modules first (most installs already have
 * it there — pi extensions share a hoisted dependency tree), then fall back to
 * normal `require("undici")` resolution from this module's own install
 * location (declared as a peerDependency: npm auto-installs it when the host
 * environment has no copy yet, and reuses the existing one otherwise).
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
	proxySource: "env" | "config" | "system" | "default";
	domains: string[];
	tapTelegramEnv: boolean;
	usingDefaults: boolean;
} {
	const envProxy = process.env.PROXY_URL?.trim();
	const envDomains = process.env.PROXY_DOMAINS
		?.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	let cfgProxy = "";
	let cfgDomains: string[] = [];
	// Fallback marker: true when neither config nor env specifies a whitelist
	let useDefaultDomains = true;
	let cfgTapTelegramEnv = true;

	// ── config file is the primary source of truth ──
	if (existsSync(CONFIG_PATH)) {
		try {
			const raw = JSON.parse(
				readFileSync(CONFIG_PATH, "utf-8")
			) as HttpProxyOptions;
			if (typeof raw.proxy === "string" && raw.proxy.trim()) {
				cfgProxy = raw.proxy.trim();
			}
			if (Array.isArray(raw.domains)) {
				cfgDomains = raw.domains.filter(domainLike);
				// config file explicitly defines a whitelist → don't fall back to defaults (even when empty)
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

	// ── env vars only fill in what the config file does not define ──
	if (useDefaultDomains && envDomains) {
		cfgDomains = envDomains;
		useDefaultDomains = false;
	} else if (useDefaultDomains) {
		cfgDomains = DEFAULT_DOMAINS.slice();
	}

	// ── proxy fallback chain: config file → PROXY_URL → system proxy env → built-in default ──
	let proxySource: "env" | "config" | "system" | "default";
	if (cfgProxy) {
		proxySource = "config";
	} else if (envProxy) {
		cfgProxy = envProxy;
		proxySource = "env";
	} else {
		const sysProxy = (
			process.env.HTTPS_PROXY ||
			process.env.https_proxy ||
			process.env.HTTP_PROXY ||
			process.env.http_proxy ||
			""
		).trim();
		if (sysProxy) {
			cfgProxy = sysProxy;
			proxySource = "system";
		} else {
			cfgProxy = DEFAULT_PROXY;
			proxySource = "default";
		}
	}

	return {
		proxy: cfgProxy,
		proxySource,
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
/** Whether the proxy address is trusted; only a guessed default starts false */
let proxyAlive = true;
let usingDefaultProxy = false;
let proxyAgent: {
	dispatch: (opts: unknown, handler: unknown) => unknown;
	close?: () => void;
} | null = null;

/**
 * TCP reachability check for the proxy address (short timeout). Used only to
 * gate a *guessed* default address so out-of-box machines without a local
 * proxy degrade to direct connections instead of hanging.
 */
function probeProxy(uri: string, timeoutMs = 2500): Promise<boolean> {
	try {
		const u = new URL(uri);
		const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
		return new Promise<boolean>((resolve) => {
			const sock = netConnect(
				{ host: u.hostname, port: port },
				() => {
					sock.destroy();
					resolve(true);
				}
			);
			sock.setTimeout(timeoutMs, () => {
				sock.destroy();
				resolve(false);
			});
			sock.on("error", () => resolve(false));
		});
	} catch {
		return Promise.resolve(false);
	}
}

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
		let raw: { proxy?: unknown; domains?: unknown } = {};
		if (existsSync(CONFIG_PATH)) {
			raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
				proxy?: unknown;
				domains?: unknown;
			};
		} // no file: treat as a fresh start (env / built-in defaults below)
		// Same precedence as loadConfig: config file first, env fills only what it omits
		const envDomains = process.env.PROXY_DOMAINS
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);
		const envProxy = process.env.PROXY_URL?.trim();

		const fileHasDomains = Array.isArray(raw.domains);
		const nextDomains: string[] = fileHasDomains
			? (raw.domains as unknown[]).filter(domainLike)
			: envDomains && envDomains.length > 0
				? envDomains
				: DEFAULT_DOMAINS.slice(); // nothing specified: built-in defaults, same as a fresh start
		const fileProxy =
			typeof raw.proxy === "string" && raw.proxy.trim()
				? raw.proxy.trim()
				: "";
		const nextProxy = fileProxy || envProxy || proxyUri;

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
		// Reloaded address comes from the user (file/env) — trust it again
		usingDefaultProxy = false;
		proxyAlive = true;
		const changed =
			nextDomains.length !== domains.length ||
			nextDomains.some((d, i) => d !== domains[i]) ||
			proxyChanged;
		domains = nextDomains;
		const note = !fileHasDomains
			? " (no domains key in file — using " +
				(envDomains?.length ? "PROXY_DOMAINS env" : "built-in defaults") + ")"
			: fileProxy
				? ""
				: envProxy
					? " (no proxy in file — using PROXY_URL env)"
					: " (no proxy in file)";
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

/** Whether whitelisted requests are currently routed through the proxy */
export function isProxyActive(): boolean {
	return proxyAlive;
}

export default function installHttpProxyAutoload(pi?: ExtensionAPI) {
	if (installed) return;
	installed = true;

	const cfg = loadConfig();
	const configFileExists = existsSync(CONFIG_PATH);
	if (cfg.domains.length === 0) {
		console.warn("[pi-httpproxy] whitelist is empty; every request will go direct");
	} else if (cfg.usingDefaults) {
		console.log(
			`[pi-httpproxy] using built-in default whitelist (${cfg.domains.length} rules); create ${CONFIG_PATH} to customize`
		);
	}
	if (!configFileExists) {
		// First-run hint: tell the user where to put their proxy URL + whitelist
		console.log(
			`[pi-httpproxy] TIP: edit ${CONFIG_PATH} to set your "proxy" URL and the "domains" whitelist you want routed through it. ` +
				`(No file yet — the built-in default whitelist is already active; run /httpproxy-reload after creating the file to apply it.)`
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
	usingDefaultProxy = cfg.proxySource === "default";
	// A guessed default address is untrusted until probed; user-provided
	// addresses (env / config) are trusted as-is.
	proxyAlive = !usingDefaultProxy;
	proxyAgent = new ProxyAgent(proxyUri);
	if (usingDefaultProxy) {
		void probeProxy(proxyUri).then((ok) => {
			if (ok) {
				proxyAlive = true;
				console.log(
					`[pi-httpproxy] default proxy ${proxyUri} reachable — routing enabled`
				);
			} else {
				console.warn(
					`[pi-httpproxy] default proxy ${proxyUri} unreachable — staying direct. ` +
						`Set PROXY_URL or create ${CONFIG_PATH} with your proxy address to enable routing.`
				);
			}
		});
	}
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
			const useProxy =
				domains.some((d) => matchRule(hostname, d)) && proxyAlive;
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
			`[pi-httpproxy] enabled: proxy=${proxyUri} (source=${usingDefaultProxy ? "default, probing" : "user"}, alive=${proxyAlive}), domains=${domains.length} rule(s), dispatchers=[${dn(proxyAgent)} <-> ${dn(directAgent)}], fetchWrapped=${globalThis.fetch !== origFetch}`
		);
	}
}