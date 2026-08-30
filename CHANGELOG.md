# Changelog

## 0.1.0 — 2026-08-30

Initial release. Publishable generalization of the local `proxy-autoload` extension.

- Domain-whitelist global proxy: whitelisted domains via proxy, everything else direct
- Triple routing coverage: global undici dispatcher, wrapped `globalThis.fetch`, pi-telegram network-family pin
- undici resolved from pi's bundled modules first, auto-installed via peerDependency when the host has none
- `~/.pi/proxy-domains.json` config; `PROXY_URL` / `PROXY_DOMAINS` env overrides
- Built-in default whitelist (common services) for zero-config first run; explicit `"domains": []` disables it
- Out-of-box proxy fallback chain: `PROXY_URL` → config → `HTTPS_PROXY`/`HTTP_PROXY` env → built-in default `127.0.0.1:7890`, with a reachability probe on the guessed default (falls back to direct with an actionable hint if unreachable)
- `isProxyActive()` export to query whether proxy routing is live
- `/httpproxy-reload` hot-reload command
- `tapTelegramEnv` config option to opt out of the pi-telegram env pin
- Safe no-op when no proxy address is configured
- English bilingual-safe output, `[pi-httpproxy]` log prefix