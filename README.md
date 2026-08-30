# @cdexs/pi-httpproxy

A [pi coding agent](https://github.com/badlogic/pi-mono) extension that
auto-installs a **domain-whitelist global HTTP proxy** on startup: whitelisted
domains are routed through your proxy, everything else goes direct.

Zero-config safe — without a configured proxy address the extension is inert
and does not touch your network.

## How it works

The extension applies three layers of coverage so that essentially *every*
outbound request in the pi process is routed consistently:

1. **Global undici dispatcher** — every request issued through undici's global
   dispatcher slots (including `pi-web-access` and any plugin using global
   fetch) is routed per the whitelist. Both the modern and legacy global
   dispatcher slots are set.
2. **`globalThis.fetch` wrapper** — for whitelisted domains a `dispatcher` is
   explicitly injected into the request init at call time. This does not rely
   on the global slot, so it keeps working even if some other package later
   overwrites `setGlobalDispatcher`.
3. **`PI_TELEGRAM_NETWORK_FAMILY=auto`** — pinned for
   [`pi-telegram`](https://www.npmjs.com/package/@llblab/pi-telegram) so it
   never degrades to bare `node:https` requests that bypass undici entirely
   (those fail behind polluted/censored DNS). Opt out via config (see below).

Match hit → proxy; miss → direct connection.

## Install

```bash
pi install @cdexs/pi-httpproxy
```

## Configure

### Zero config

If `~/.pi/proxy-domains.json` does not define a `domains` array, the extension
uses a **built-in default whitelist** covering commonly-proxied services
(Google, GitHub, Telegram, Brave Search, Hugging Face, OpenAI, Anthropic/
Claude, npm registry, and more) — same list as
[`proxy-domains.example.json`](./proxy-domains.example.json) below. Setting
only `PROXY_URL` is enough:

```bash
PROXY_URL=http://127.0.0.1:7890 pi
```

### Full config

Create `~/.pi/proxy-domains.json` (you can start from
[`proxy-domains.example.json`](./proxy-domains.example.json)):

```jsonc
{
  // HTTP proxy used for whitelisted domains
  "proxy": "http://127.0.0.1:7890",
  // optional: pin pi-telegram to the fetch path (default true)
  "tapTelegramEnv": true,
  // whitelist rules; plain-text group labels are ignored
  "domains": [
    "github.com",
    "*.github.com",
    "google.com",
    "*.google.com"
  ]
}
```

Rule syntax (case-insensitive):

| Rule           | Matches                                    |
| -------------- | ------------------------------------------ |
| `example.com`  | exactly `example.com`                      |
| `*.example.com`| any subdomain of `example.com` (not itself)|
| `.example.com` | `example.com` plus all its subdomains      |

Lines that don't look like domains (e.g. Chinese/English group labels) are
silently ignored, so you can organize the list freely.

### Environment variables

| Var              | Effect                                                        |
| ---------------- | ------------------------------------------------------------- |
| `PROXY_URL`      | Overrides the `proxy` field in the config file                |
| `PROXY_DOMAINS`  | Comma-separated whitelist; overrides the `domains` array      |
| `PI_PROXY_DEBUG` | Set to `1` to log every routing decision to the console       |

Fields locked by env vars are also excluded from hot reload.

Note: to explicitly start with an empty whitelist (all direct), set a config
file containing `"domains": []` — the built-in defaults only apply when the
`domains` key is missing entirely.

## Hot reload

Edit `~/.pi/proxy-domains.json`, then run in your pi session:

```
/httpproxy-reload
```

The whitelist and the `ProxyAgent` are rebuilt in place — no pi restart needed.
If the file is mid-edit / half-written, the previous config keeps serving.

## Programmatic API

```ts
import proxy, { reloadProxyConfig, isProxied } from "@cdexs/pi-httpproxy";

proxy(pi); // install (normally done automatically by pi)

reloadProxyConfig(); // re-apply the config file in place
isProxied("https://github.com/foo"); // → true if whitelisted
```

## Notes

- undici is resolved from pi's bundled runtime modules first, then via normal
  package resolution (optional peer dependency) — the package adds no runtime
  dependencies.
- The extension only sets `PI_TELEGRAM_NETWORK_FAMILY` when it is not already
  set in your environment.

## License

MIT