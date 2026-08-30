# pi-httpproxy 项目准则

## 项目定位

`pi-httpproxy` 是一个可发布的 pi coding agent 扩展（npm 包）。前身是本地定制扩展
`proxy-autoload`（位于 `~/.pi/agent/extensions/proxy-autoload.ts`），本项目的目标是
将其整理、泛化、发布为公开可安装的 pi 扩展包。

## 功能一句话

Pi 启动时自动安装「按域名白名单分流」的全局网络代理：白名单域名走指定 HTTP 代理，
其余直连。三重保险（global undici dispatcher / globalThis.fetch 包装 /
PI_TELEGRAM_NETWORK_FAMILY=auto），支持 `/proxy-domain-reload` 热重载（命令：`/httpproxy-reload`）。

## 硬性规则

1. **不要把作者的私有配置发布出去**：本地代理地址（如 `http://192.168.1.66:20172`）、
   个人白名单内容，只能出现在 `*.example.json` 示例文件或文档中作为「示意」，不允许
   作为包内默认值硬编码。
2. **扩展必须在「零配置」下安全空闲**：没有找到代理地址/配置文件时，只 warn、不改变
   任何网络行为，不得让其他用户的 pi 出现网络异常。
3. **依赖纪律**：运行时不得引入 npm 依赖（undici 等一律从 pi 自带环境解析）；
   devDependencies 只放类型检查/构建相关（typescript、@earendil-works/pi-coding-agent 等）。
4. **包格式遵循 pi 生态惯例**（参照 pi-memory / pi-web-access）：
   - `package.json` 含 `"pi": { "extensions": ["./index.ts"] }`、`"type": "module"`、
     keywords 含 `pi` / `pi-coding-agent` / `pi-package`
   - 入口为 TS 源文件（`index.ts`），由 pi 直接加载，不预编译
5. **文档语言**：README 用英文为主（面向国际用户），代码注释可以中英混合；
   运行日志/命令输出用英文（发布包面向所有用户）。

## 结构

```
pi-httpproxy/
├── index.ts              # 扩展入口（由 proxy-autoload.ts 泛化而来）
├── package.json          # @cdexs/pi-httpproxy
├── AGENTS.md             # 本文件
├── README.md
├── CHANGELOG.md
├── LICENSE               # MIT
├── tsconfig.json         # 仅用于 tsc --noEmit 类型检查
└── proxy-domains.example.json  # 配置示例（不含真实代理地址）
```

## 已确认的决策（2026-08-30）

- 配置文件路径保持 `~/.pi/proxy-domains.json`（不重命名）
- 热重载命令更名为 `/httpproxy-reload`
- 包名带 scope：`@cdexs/pi-httpproxy`（npm 上用小写 scope）

## 本地开发与验证

- 类型检查：`npm install && npm run typecheck`
- 真实验证：将 `index.ts` 复制/软链接到 `~/.pi/agent/extensions/` 并启动 pi，
  确认分流生效（`PI_PROXY_DEBUG=1`）与 `/proxy-domain-reload` 可用；验证后不要把
  本地副本忘在 extensions 目录造成双加载。