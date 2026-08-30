# @cdexs/pi-httpproxy

[English](./README.md) | [中文说明](./README.zh-CN.md)

一个 [pi coding agent](https://github.com/badlogic/pi-mono) 扩展：启动时自动
安装**按域名白名单分流的全局 HTTP 代理**——白名单域名走你的代理，其余全部直连。

开箱即用，零配置安全——没有配置代理地址时扩展保持空闲，不会触碰你的网络。

## 工作原理

扩展通过三层机制让 pi 进程内**几乎所有**出站请求都被一致地按白名单分流：

1. **全局 undici dispatcher** —— pi 进程内所有经 undici 全局槽发出的请求
   （包括 `pi-web-access` 及其他使用全局 fetch 的插件）都按白名单分流；
   现代与遗留两个全局 dispatcher 槽位都会写入。
2. **`globalThis.fetch` 包装** —— 命中白名单的域名在请求初始化时显式注入
   `dispatcher`，不依赖全局槽位；即使其他包事后覆盖了
   `setGlobalDispatcher`，这层依然生效。
3. **`PI_TELEGRAM_NETWORK_FAMILY=auto`** —— 为
   [`pi-telegram`](https://www.npmjs.com/package/@llblab/pi-telegram) 固定
   网络策略，防止它退化到完全绕过 undici 的裸 `node:https` 请求（在 DNS
   污染环境下必然超时）。可通过配置关闭（见下文）。

命中白名单 → 走代理；未命中 → 直连。

## 安装

从 npm 安装（发布后）：

```bash
pi install @cdexs/pi-httpproxy
```

或直接从 GitHub 仓库安装：

```bash
pi install git:github.com/Cdexs/pi-httpproxy
# 或
pi install https://github.com/Cdexs/pi-httpproxy
```

安装后，pi 会自动在 `~/.pi/proxy-domains.json` 创建默认配置文件（即示例内容：
预置白名单、`proxy` 留空），并在启动时输出首次运行提示，例如：

```
[pi-httpproxy] created default config file at /Users/you/.pi/proxy-domains.json
(whitelist preloaded; "proxy" is empty — edit it to point at your proxy, or see
below for auto-detection)
[pi-httpproxy] TIP: edit /Users/you/.pi/proxy-domains.json and set "proxy" to
your HTTP proxy URL, then run /httpproxy-reload.
```

完全自定义分流只需要：直接编辑该文件里的 `proxy`（必要时改 `domains`），然后
执行 `/httpproxy-reload`。

## 配置

### 零配置

开箱即用（没有任何配置文件和环境变量）时，扩展使用：

- **内置默认白名单**：覆盖常见的需要走代理的服务（Google、GitHub、
  Telegram、Brave Search、Hugging Face、OpenAI、Anthropic/Claude、npm
  registry 等）——与
  [`proxy-domains.example.json`](./proxy-domains.example.json) 中的列表一致
- **代理地址回退链**：配置文件的 `proxy` → `PROXY_URL` 环境变量 →
  `HTTPS_PROXY` / `HTTP_PROXY` 系统环境变量 → 内置默认
  `http://127.0.0.1:7890`（Clash 系默认端口）

**配置文件是最高优先级的数据源**；`PROXY_URL` / `PROXY_DOMAINS` 环境变量只
负责填充配置文件中省略的字段（不会因为其他软件恰好设置了同名环境变量就劫持
你的文件配置）。

内置默认代理地址会先做一次快速的可达性探测：如果那里什么都没监听，扩展会
输出一条可操作的提示并保持**全直连**——开箱行为绝不会弄坏没有本地代理的
机器。用户主动提供的地址（环境变量 / 配置文件）则直接信任。

### 完整配置

开箱时配置文件已经存在（首次运行自动创建，内容即示例：`proxy` 留空、白名单
已预置）。直接编辑 `~/.pi/proxy-domains.json`：

```jsonc
{
  // 白名单域名走的 HTTP 代理
  "proxy": "http://127.0.0.1:7890",
  // 可选：是否给 pi-telegram 固定 fetch 路径（默认 true）
  "tapTelegramEnv": true,
  // 白名单规则；不像域名的纯文本分组行会被忽略
  "domains": [
    "github.com",
    "*.github.com",
    "google.com",
    "*.google.com"
  ]
}
```

规则语法（大小写不敏感）：

| 规则            | 匹配                                          |
| --------------- | --------------------------------------------- |
| `example.com`   | 精确匹配 `example.com`                        |
| `*.example.com` | `example.com` 的所有子域名（不含自身）        |
| `.example.com`  | `example.com` 及其所有子域名                  |

不像域名的行（如中英文分组标签）会被静默忽略，可以随意分组排版。

### 环境变量

| 变量             | 作用                                                     |
| ---------------- | -------------------------------------------------------- |
| `PROXY_URL`      | 配置文件没有 `proxy` 字段时的回退（文件配置永远优先）    |
| `PROXY_DOMAINS`  | 逗号分隔的白名单；仅在配置文件没有 `domains` 键时使用    |
| `PI_PROXY_DEBUG` | 设为 `1` 时把每次分流判定打到控制台                      |

配置文件中已定义的字段永远不会被环境变量覆盖，所以这些环境变量可以放心常驻。

注意：如果想刻意用空白名单（全部直连），在配置文件里写 `"domains": []`——
内置默认白名单只在 `domains` 键完全缺失时生效。

## 热重载

编辑 `~/.pi/proxy-domains.json` 后，在 pi 会话里执行：

```
/httpproxy-reload
```

白名单和 `ProxyAgent` 会原地重建——无需重启 pi。文件处于编辑中间态 /
JSON 半截时会沿用旧配置继续工作。

## 编程接口

```ts
import proxy, { reloadProxyConfig, isProxied, isProxyActive } from "@cdexs/pi-httpproxy";

proxy(pi); // 安装（通常由 pi 自动完成）

reloadProxyConfig();          // 原地重新应用配置文件
isProxied("https://github.com/foo"); // → 命中白名单返回 true
isProxyActive();              // → 当前是否真正在走代理分流
```

## 说明

- undici 优先从 pi 自带的运行时模块解析，其次走常规包解析——它被声明为
  peerDependency：如果宿主环境还没有 undici，npm 安装本扩展时会自动补装；
  本包自身永远不会带入第二份运行时副本。
- 扩展只在你的环境中尚未设置 `PI_TELEGRAM_NETWORK_FAMILY` 时才会写入它。

## 许可

MIT