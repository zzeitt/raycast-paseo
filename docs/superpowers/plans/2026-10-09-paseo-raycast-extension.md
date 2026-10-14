# Paseo Raycast 扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 做一个 Raycast 扩展，用 paseo 官方 TypeScript SDK 直连本机 daemon，提供「Ask Paseo」（提问 → 流式回答 → 原地追问）和「Paseo Sessions」（会话列表 → 继续 / 停止 / 归档 / 在桌面端打开）两条命令。

**Architecture:** Raycast 每条命令是一个独立 Node 进程，自己开一条 WebSocket 连到 `ws://127.0.0.1:6767/ws`，用 `@getpaseo/client` 的 `DaemonClient` 拿结构化数据。逻辑全部下沉到 `src/paseo/*` 的纯模块（可单测），UI 组件只做渲染和转发，不写业务逻辑。

**Tech Stack:** TypeScript、React（Raycast 内置）、`@raycast/api`、`@getpaseo/client@0.11.1`、vitest、esbuild（Raycast 自带，不需要自己配）。

**Spec:** 本仓库没有单独的设计文档。设计依据是对 paseo 官方源码（github.com/getpaseo/paseo，Apache-2.0，tag 对应 0.11.1）和 paseo.sh/docs 的阅读，关键结论抄录在下面的「已核实的事实」一节——**实现时照着写，不要重新猜接口**。

## 已核实的事实（读源码得来，别再验证一遍）

本机状态：桌面版 Paseo `0.11.1`，daemon 监听 `127.0.0.1:6767`，`serverId` 可在运行时取（不要硬编码），provider `claude` 可用。

鉴权（本地不做密码）：
- `resolvePaseoHome()` = `PASEO_HOME` 环境变量，否则 `~/.paseo`。
- 读 `<home>/paseo.pid` 的 `listen` 字段，归一化后必须等于你要连的目标，才读同目录 `<home>/local-credential`。
- `local-credential` 内容是 43 字符 base64url（32 字节 token）+ 换行，校验正则 `/^[A-Za-z0-9_-]{43}$/`。
- 这个 token 通过 `DaemonClient` 的 `localCredential` 回调传入（每次连接时重新读）。
- 出处：`packages/server/src/server/local-credential.ts`、`packages/cli/src/utils/client.ts:185-230`。

连接与 API 出处：`@getpaseo/client` 的包导出里有 `./internal/daemon-client` 子路径（CLI 自己就用它），`DaemonClient` 的构造配置字段与关键方法如下（均为已核实的真实签名）：

| 用途 | 调用 |
| --- | --- |
| 连接 | `new DaemonClient({ url, clientId, clientType: "cli", appVersion, localCredential, connectTimeoutMs, reconnect })` → `await client.connect()` |
| 取 serverId | `client.getLastServerInfoMessage()?.serverId` |
| 列会话 | `client.fetchAgents({ filter: { includeArchived: false } })` → `{ entries: [{ agent, project }] }` |
| 取单个 | `client.fetchAgent({ agentId })` → `{ agent } \| null` |
| 建 agent | `client.createAgent({ provider, model, cwd, title, initialPrompt, labels })` → `AgentSnapshotPayload`（`.id`） |
| 追问 | `client.sendAgentMessage(agentId, text, options?)` |
| 停止 | `client.cancelAgent(agentId)`（idle 时是 no-op，CLI 的 `stop` 就是它） |
| 归档 | `client.archiveAgent(agentId)` → `{ archivedAt }` |
| 流式 | `client.subscribeAgentTimeline(agentId, handler)` → `TimelineSubscription`（`() => void` 且带 `.ready: Promise<void>`、`.release()`） |
| 历史 | `client.fetchAgentTimeline({ agentId, direction, limit, projection })` |

流式事件的真实形状（出处 `packages/client/src/timeline-subscription/index.ts`、`packages/protocol/src/messages.ts:4087`）：

```ts
type TimelineMessage =
  | { type: "agent_stream"; payload: { agentId: string; event: AgentStreamEvent; timestamp: string; seq?: number; epoch?: string } }
  | { type: "agent.timeline.replacement"; payload: { agentId: string } }
  | { type: "agent.timeline.subscription_restored"; payload: { agentId: string; subscriptionId: string } }
  | { type: "agent.timeline.error"; payload: { agentId: string; error: string } };
```

`AgentStreamEvent` 里我们要的几种（出处 `packages/protocol/src/agent-types.ts:390+`）：
`{ type: "turn_started" }`、`{ type: "turn_completed", usage? }`、`{ type: "turn_failed", error, code? }`、`{ type: "turn_canceled", reason }`、`{ type: "timeline", item: AgentTimelineItem }`。

`AgentTimelineItem` 的判别联合（出处 `agent-types.ts:374-392`）：
`user_message{text}`、`assistant_message{text, messageId?}`、`reasoning{text}`、`tool_call{callId,name,status:"running"|"completed"|"failed"|"canceled",detail}`、`todo{items}`、`error{message}`、`notification{level,message}`、`compaction`、`plugin`。

**关键行为：assistant_message 是分片到达的，必须按 messageId 或"连续片段"自行拼接**（官方文档原话：Assistant messages can arrive in pieces）。结束信号只有 `turn_completed` / `turn_failed` / `turn_canceled`，**不要用状态变 idle 来判断**。

「在桌面端打开」不是 API：拉起 `Paseo.exe` 并传深链参数 `paseo://h/<encodeURIComponent(serverId)>/agent/<encodeURIComponent(agentId)>`（出处 `packages/cli/src/commands/open.ts` + `packages/protocol/src/agent-deep-link.ts`）。**注意是 `paseo://`——两个斜杠**：paseo 自己的模板是 `paseo:/${route}` 而 route 以 `/` 开头，所以实际字符串有两个斜杠。这不是美观问题：它的 `parseAgentDeepLink` 走 `new URL()`，双斜杠时 hostname 为 `h`、pathname 切出 3 段能解；单斜杠时 hostname 为空、切成 4 段，直接返回 null，链接静默失效。Windows 上 CLI 找的是 `%LOCALAPPDATA%\Programs\Paseo\Paseo.exe`，**但本机实际装在 `D:\Apps\Paseo\Paseo.exe`**，所以要有 preference 覆盖。

Raycast 侧：扩展跑在 Node 22（`@getpaseo/client` 要求 Node 22+，默认用 `globalThis.WebSocket`，**不需要装 `ws` 包**）。`ray` CLI 在 `ray.cmd`，已在 PATH 上，用 `npm run dev` / `npm run build` 间接调用。

## Global Constraints

- **Node ≥ 22**：`@getpaseo/client` 的硬要求，Raycast 运行时正好满足。不要在代码里用 Node 22 没有的 API。
- **`@getpaseo/client` 锁死 `0.11.1`**（不带 `^`）：必须与本机 daemon `0.11.1` 同版。升级 Paseo 桌面版时同步升这个版本号。
- **不引入 `ws` 依赖**：SDK 默认走 `globalThis.WebSocket`。
- **平台**：`package.json` 的 `platforms` 必须是 `["Windows", "macOS"]`（只写 macOS 的话 Windows 上不出现）。
- **所有面向用户的文案用中文**；代码标识符、提交信息用英文。
- **不要在纯模块里 import React 或 `@raycast/api`**，否则 vitest 跑不动。
- **每条命令一个进程**：命令之间不共享内存，连接状态不能跨命令缓存。
- 项目路径：`D:\work\raycast-paseo`。

## Review Focus

以下五类输入/失败场景，spec 没写但用户一定会撞上。每条都在对应 task 里补了测试或显式处理：

1. **daemon 没开**（用户关了桌面版就来跑命令）→ 必须给一句「Paseo 没在运行，先打开桌面版」的中文提示，不是抛 zod/WebSocket 堆栈。
2. **`local-credential` 与 `paseo.pid` 不匹配**（daemon 换了端口重启、或 `--host` 指向别处）→ 此时**不能**把 token 发过去，应降级为不带凭据连接并给出可操作的提示（Task 2 有测试）。
3. **回答正在跑时用户按了追问** → 不静默打断当前 turn：追问入口被替换成「正在回答…（先停止才能追问）」的提示，要打断只能显式按「停止」（判定逻辑 `canSendFollowUp` 在 Task 4 有测试，入口在 Task 7）。
4. **超长回答**（几千个分片）→ 每个分片都触发 React 重渲染会卡死；必须节流合并（Task 8 的 80ms 缓冲）。
5. **归档过的会话**仍在列表里出现 → 默认过滤掉，且归档/停止动作要有可见反馈（Task 10）。

---

## 文件结构

```
raycast-paseo/
├── package.json                              # manifest + 依赖 + preferences
├── tsconfig.json
├── vitest.config.ts
├── .gitignore
├── README.md
├── docs/superpowers/plans/2026-10-09-paseo-raycast-extension.md   # 本文件
└── src/
    ├── paseo/
    │   ├── credential.ts        # 纯函数：paseoHome / 目标归一化 / 读本地凭据
    │   ├── credential.test.ts
    │   ├── client.ts            # 建连接 + 连接失败的中文文案
    │   ├── timeline.ts          # 纯 reducer：TimelineMessage → 可渲染块
    │   ├── timeline.test.ts
    │   ├── agents.ts            # 列表/创建/追问/停止/归档 的薄封装 + DTO
    │   ├── agents.test.ts
    │   ├── desktop.ts           # 深链拼装 + 找 Paseo.exe + 打开
    │   └── desktop.test.ts
    ├── hooks/
    │   ├── use-paseo-endpoint.ts   # preferences → endpoint，不含逻辑
    │   └── use-conversation.ts     # 连接 + 订阅 + 80ms 节流 → React 状态
    ├── components/
    │   └── conversation-detail.tsx # 共享的会话视图（Detail + 追问表单 + 动作）
    ├── ask.tsx                  # 命令 1：Ask Paseo
    └── sessions.tsx             # 命令 2：Paseo Sessions
```

这样分的理由：`src/paseo/*` 全部是无 React 依赖的纯逻辑（唯一例外 `client.ts` 只是 new 一个对象），可以用 vitest 直接跑；`hooks/` 和 `components/` 是薄壳，靠 `ray develop` 手验。两个命令共用 `conversation-detail.tsx`，追问逻辑只写一遍。

---

### Task 1: 脚手架 + 连接探针（走通全链路）

先把"依赖能不能打包、能不能连上 daemon"这件事验证掉，再写业务代码。这个 task 的产出是一个 `paseo-probe` 命令：跑起来显示 daemon 的 serverId、版本和当前会话数。

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `src/paseo-probe.tsx`
- Create: `README.md`

**Interfaces:**
- Consumes: 无
- Produces: 可编译可运行的扩展骨架；`package.json` 里的 preferences 定义（后续所有 task 都从 `getPreferenceValues()` 读这里的 key）

- [ ] **Step 1: 建目录并 git init**

```bash
mkdir -p "D:/work/raycast-paseo/src"
cd "D:/work/raycast-paseo"
git init
```

- [ ] **Step 2: 写 `package.json`**

```json
{
  "$schema": "https://www.raycast.com/schemas/extension.json",
  "name": "paseo",
  "title": "Paseo",
  "description": "从 Raycast 直接问 Paseo 的 coding agent，并管理已有会话",
  "author": "zzzeittt",
  "license": "MIT",
  "platforms": ["Windows", "macOS"],
  "categories": ["Developer Tools"],
  "commands": [
    {
      "name": "ask",
      "title": "Ask Paseo",
      "subtitle": "Paseo",
      "description": "问一句话，流式看回答，可原地追问",
      "mode": "view",
      "arguments": [
        {
          "name": "question",
          "type": "text",
          "placeholder": "问题（留空则用剪贴板，或用表单输入）",
          "required": false
        }
      ]
    },
    {
      "name": "sessions",
      "title": "Paseo Sessions",
      "subtitle": "Paseo",
      "description": "列出会话，继续 / 停止 / 归档 / 在桌面端打开",
      "mode": "view"
    },
    {
      "name": "paseo-probe",
      "title": "Paseo Probe",
      "subtitle": "Paseo",
      "description": "自检：连上本地 daemon 并显示状态",
      "mode": "view"
    }
  ],
  "preferences": [
    {
      "name": "daemonHost",
      "title": "Daemon 地址",
      "description": "host:port，默认 127.0.0.1:6767",
      "type": "textfield",
      "required": false,
      "default": "127.0.0.1:6767"
    },
    {
      "name": "paseoHome",
      "title": "Paseo Home",
      "description": "留空则用 PASEO_HOME 或 ~/.paseo",
      "type": "textfield",
      "required": false
    },
    {
      "name": "provider",
      "title": "Provider",
      "description": "默认 claude；也可写 provider/model",
      "type": "textfield",
      "required": false,
      "default": "claude"
    },
    {
      "name": "model",
      "title": "Model",
      "description": "留空则用 daemon 的默认模型",
      "type": "textfield",
      "required": false
    },
    {
      "name": "defaultCwd",
      "title": "默认工作目录",
      "description": "新 agent 的 cwd",
      "type": "textfield",
      "required": false,
      "default": "D:\\Acme\\Workshop\\.paseo"
    },
    {
      "name": "paseoAppPath",
      "title": "Paseo.exe 路径",
      "description": "留空则自动探测（本机是 D:\\Apps\\Paseo\\Paseo.exe）",
      "type": "textfield",
      "required": false
    }
  ],
  "dependencies": {
    "@getpaseo/client": "0.11.1",
    "@raycast/api": "^1.104.0",
    "@raycast/utils": "^1.19.1"
  },
  "devDependencies": {
    "@types/node": "^22.13.10",
    "@types/react": "^19.0.10",
    "typescript": "^5.8.2",
    "vitest": "^3.0.7"
  },
  "scripts": {
    "dev": "ray develop",
    "build": "ray build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 3: 写 `tsconfig.json`**

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "include": ["src/**/*"],
  "compilerOptions": {
    "lib": ["ES2023"],
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  }
}
```

`moduleResolution: "bundler"` 是必须的：`@getpaseo/client` 的 `internal/daemon-client` 子路径靠 `exports` 字段暴露，老的 `"node"` 解析模式找不到它。

- [ ] **Step 4: 写 `.gitignore`**

```
node_modules/
.raycast/
raycast-env.d.ts
*.log
.DS_Store
```

- [ ] **Step 5: 写连接探针 `src/paseo-probe.tsx`**

这一步故意用最小代码验证打包和连接，不引入 `src/paseo/*`：

```tsx
import { Detail, getPreferenceValues } from "@raycast/api";
import { useEffect, useState } from "react";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";

interface Preferences {
  daemonHost: string;
  paseoHome?: string;
  paseoAppPath?: string;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [text, setText] = useState("连接中…");

  useEffect(() => {
    let client: DaemonClient | undefined;
    (async () => {
      try {
        client = new DaemonClient({
          url: `ws://${prefs.daemonHost}/ws`,
          clientId: "raycast-paseo-probe",
          clientType: "cli",
          appVersion: "0.1.0",
          connectTimeoutMs: 5000,
          reconnect: { enabled: false },
        });
        await client.connect();
        const info = client.getLastServerInfoMessage();
        const agents = await client.fetchAgents({ filter: { includeArchived: false } });
        setText(
          [
            "# Paseo 连接正常",
            "",
            `- Node: ${process.version}`,
            `- serverId: ${info?.serverId ?? "(未上报)"}`,
            `- 会话数: ${agents.entries.length}`,
          ].join("\n"),
        );
      } catch (error) {
        setText(`# 连接失败\n\n\`\`\`\n${error instanceof Error ? error.message : String(error)}\n\`\`\``);
      }
    })();
    return () => {
      void client?.close();
    };
  }, [prefs.daemonHost]);

  return <Detail markdown={text} />;
}
```

注意这里**先不传 `localCredential`**，因为 daemon 对 localhost 连接是否强制凭据还没验证。如果这一步就报鉴权失败，加上凭据（Task 3 的代码）再试。

- [ ] **Step 6: 装依赖**

```bash
cd "D:/work/raycast-paseo"
npm install
```

- [ ] **Step 7: 类型检查 + 启动开发模式**

```bash
npm run typecheck
npm run dev
```

预期：`typecheck` 无错；`dev` 提示扩展已加载，Raycast 里能搜到 "Paseo Probe"。

- [ ] **Step 8: 手动验证**

Raycast 里跑 "Paseo Probe"。预期看到 `# Paseo 连接正常`，Node 版本是 v22+，会话数是个数字。
**如果失败**：把失败信息原样记下来，按这个顺序排查——(a) `moduleResolution` 解析不到子路径 → 改成 `"nodenext"` 并把 `package.json` 加 `"type": "module"`；(b) 鉴权失败 → 直接跳到 Task 2、3 补凭据；(c) 打包报 ESM 相关错 → 在 `package.json` 加 `"type": "module"` 后重试。

- [ ] **Step 9: 提交**

```bash
git add package.json tsconfig.json .gitignore src/paseo-probe.tsx
git commit -m "chore: scaffold Raycast extension with paseo daemon probe"
```

---

### Task 2: 本地凭据读取（纯函数 + 单测）

**Files:**
- Create: `src/paseo/credential.ts`
- Test: `src/paseo/credential.test.ts`
- Create: `vitest.config.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `resolvePaseoHome(env?: NodeJS.ProcessEnv): string`
  - `normalizeTarget(raw: string): string | null`
  - `readLocalCredentialFor(home: string, target: string, deps?: { readFile?: (p: string) => string }): string | undefined`

- [ ] **Step 1: 写 `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 2: 写失败的测试 `src/paseo/credential.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { normalizeTarget, readLocalCredentialFor, resolvePaseoHome } from "./credential";

const TOKEN = "a".repeat(43);

function fakeFs(files: Record<string, string>) {
  return (path: string): string => {
    const key = path.replace(/\\/g, "/");
    const value = files[key];
    if (value === undefined) throw new Error(`ENOENT: ${key}`);
    return value;
  };
}

const HOME = "C:/home/.paseo";
const PID = JSON.stringify({ listen: "127.0.0.1:6767" });

describe("resolvePaseoHome", () => {
  it("prefers PASEO_HOME", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "D:/paseo" })).toBe("D:/paseo");
  });

  it("treats blank PASEO_HOME as unset", () => {
    expect(resolvePaseoHome({ PASEO_HOME: "   " })).toMatch(/\.paseo$/);
  });
});

describe("normalizeTarget", () => {
  it("treats localhost and 127.0.0.1 as the same", () => {
    expect(normalizeTarget("localhost:6767")).toBe(normalizeTarget("127.0.0.1:6767"));
  });

  it("strips the tcp:// scheme", () => {
    expect(normalizeTarget("tcp://127.0.0.1:6767")).toBe(normalizeTarget("127.0.0.1:6767"));
  });

  it("expands a bare port", () => {
    expect(normalizeTarget("6767")).toBe(normalizeTarget("localhost:6767"));
  });

  it("returns null for junk", () => {
    expect(normalizeTarget("")).toBeNull();
    expect(normalizeTarget(":::")).toBeNull();
  });
});

describe("readLocalCredentialFor", () => {
  it("reads the token when the pid lock listens on the same target", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: PID,
      [`${HOME}/local-credential`]: `${TOKEN}\n`,
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBe(TOKEN);
  });

  it("returns undefined when the pid lock listens elsewhere", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: JSON.stringify({ listen: "127.0.0.1:7000" }),
      [`${HOME}/local-credential`]: `${TOKEN}\n`,
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });

  it("rejects a token that is not 43 base64url chars", () => {
    const readFile = fakeFs({
      [`${HOME}/paseo.pid`]: PID,
      [`${HOME}/local-credential`]: "too-short\n",
    });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });

  it("returns undefined when the credential file is missing", () => {
    const readFile = fakeFs({ [`${HOME}/paseo.pid`]: PID });
    expect(readLocalCredentialFor(HOME, "127.0.0.1:6767", { readFile })).toBeUndefined();
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/paseo/credential.test.ts`
Expected: FAIL，报 `Failed to resolve import "./credential"`。

- [ ] **Step 4: 实现 `src/paseo/credential.ts`**

```ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 paseo server 端一致：32 字节 token 的 base64url 编码 */
export const LOCAL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.PASEO_HOME?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".paseo");
}

/**
 * 归一化成 `host:port`，用于比较"pid 锁里 daemon 监听的地址"和"我们要连的地址"。
 * 认不出返回 null。localhost / 127.0.0.1 视为同一个地址（与 paseo 自己的
 * normalizeLoopbackToLocalhost 行为一致）。
 */
export function normalizeTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) return normalizeTarget(`localhost:${trimmed}`);

  const withoutScheme = trimmed.replace(/^tcp:\/\//i, "");
  const withoutSlash = withoutScheme.replace(/\/+$/, "");
  const lastColon = withoutSlash.lastIndexOf(":");
  if (lastColon <= 0) return null;

  const host = withoutSlash.slice(0, lastColon).replace(/^\[|\]$/g, "").toLowerCase();
  const port = withoutSlash.slice(lastColon + 1);
  if (!host || !/^\d+$/.test(port)) return null;

  const normalizedHost = LOOPBACK_NAMES.has(host) ? "localhost" : host;
  return `${normalizedHost}:${port}`;
}

export interface ReadLocalCredentialDeps {
  readFile?: (path: string) => string;
}

/** 只有目标正好是 pid 锁里那个本地 daemon 时才交出 token，否则返回 undefined。 */
export function readLocalCredentialFor(
  home: string,
  target: string,
  deps: ReadLocalCredentialDeps = {},
): string | undefined {
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  try {
    const lock = JSON.parse(readFile(join(home, "paseo.pid"))) as { listen?: unknown };
    if (typeof lock.listen !== "string") return undefined;
    const selected = normalizeTarget(target);
    const listening = normalizeTarget(lock.listen);
    if (!selected || !listening || selected !== listening) return undefined;

    const token = readFile(join(home, "local-credential")).trim();
    return LOCAL_CREDENTIAL_PATTERN.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/paseo/credential.test.ts`
Expected: PASS（10 个用例）。

- [ ] **Step 6: 提交**

```bash
git add vitest.config.ts src/paseo/credential.ts src/paseo/credential.test.ts
git commit -m "feat: read paseo local credential gated on the pid lock target"
```

---

### Task 3: 连接封装

**Files:**
- Create: `src/paseo/client.ts`
- Test: `src/paseo/client.test.ts`

**Interfaces:**
- Consumes: `resolvePaseoHome`、`readLocalCredentialFor`（Task 2）
- Produces:
  - `interface PaseoEndpoint { host: string; home: string }`
  - `connectPaseo(endpoint: PaseoEndpoint, options?: { connectTimeoutMs?: number }): Promise<DaemonClient>`
  - `describeConnectionError(error: unknown, endpoint: PaseoEndpoint): string`

- [ ] **Step 1: 写失败的测试 `src/paseo/client.test.ts`**

只测错误文案这一件事（`connectPaseo` 是纯 IO，靠 Task 1 的探针和手验覆盖）：

```ts
import { describe, expect, it } from "vitest";
import { describeConnectionError } from "./client";

const endpoint = { host: "127.0.0.1:6767", home: "C:/home/.paseo" };

describe("describeConnectionError", () => {
  it("explains a refused connection in Chinese with a next step", () => {
    const message = describeConnectionError(new Error("connect ECONNREFUSED 127.0.0.1:6767"), endpoint);
    expect(message).toContain("Paseo 桌面版");
    expect(message).toContain("127.0.0.1:6767");
  });

  it("mentions the unreadable credential when auth fails", () => {
    const message = describeConnectionError(new Error("Unauthorized"), endpoint);
    expect(message).toContain("local-credential");
  });

  it("passes unknown errors through without inventing advice", () => {
    const message = describeConnectionError(new Error("boom"), endpoint);
    expect(message).toContain("boom");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/paseo/client.test.ts`
Expected: FAIL，`describeConnectionError is not a function`。

- [ ] **Step 3: 实现 `src/paseo/client.ts`**

```ts
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { readLocalCredentialFor } from "./credential";

export interface PaseoEndpoint {
  /** host:port，例如 127.0.0.1:6767 */
  host: string;
  /** paseo home 目录，用于读 paseo.pid 和 local-credential */
  home: string;
}

export const CLIENT_ID = "raycast-paseo";
export const APP_VERSION = "0.1.0";

export async function connectPaseo(
  endpoint: PaseoEndpoint,
  options: { connectTimeoutMs?: number } = {},
): Promise<DaemonClient> {
  const client = new DaemonClient({
    url: `ws://${endpoint.host}/ws`,
    clientId: CLIENT_ID,
    clientType: "cli",
    appVersion: APP_VERSION,
    localCredential: () => readLocalCredentialFor(endpoint.home, endpoint.host),
    connectTimeoutMs: options.connectTimeoutMs ?? 5000,
    reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 5000 },
  });
  await client.connect();
  return client;
}

export function describeConnectionError(error: unknown, endpoint: PaseoEndpoint): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|connect timeout/i.test(raw)) {
    return `连不上 Paseo daemon（${endpoint.host}）。先打开 Paseo 桌面版，确认它在运行，再试一次。`;
  }
  if (/unauthor|forbidden|401|403/i.test(raw)) {
    return `daemon 拒绝了这次连接。多半是 ${endpoint.home}\\local-credential 读不到或和 paseo.pid 对不上（daemon 重启过？），检查一下这个文件，或把“Daemon 地址”这项设置改成 daemon 实际监听的地址。`;
  }
  return `连接 Paseo 失败：${raw}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/paseo/client.test.ts`
Expected: PASS（4 个用例）。

- [ ] **Step 5: 用探针验证真实连接（含凭据）**

把 `src/paseo-probe.tsx` 里 `new DaemonClient({...})` 那段替换成：

```tsx
const endpoint = { host: prefs.daemonHost, home: prefs.paseoHome?.trim() || resolvePaseoHome() };
client = await connectPaseo(endpoint);
```

并 import `connectPaseo` / `describeConnectionError`，catch 分支改用 `describeConnectionError(error, endpoint)`。

Run: `npm run dev`，Raycast 里跑 "Paseo Probe"。
Expected: 仍然显示「Paseo 连接正常」。若 Task 1 没加凭据也能连上，这一步同样必须通过——它证明加了凭据不会把好好的连接弄坏。

- [ ] **Step 6: 提交**

```bash
git add src/paseo/client.ts src/paseo/client.test.ts src/paseo-probe.tsx
git commit -m "feat: connect to the local paseo daemon with a localized error message"
```

---

### Task 4: 时间线归约器（核心纯逻辑）

这是整个扩展最容易写错的地方：分片拼接、结束判定、工具调用状态更新。全部做成不可变 reducer，逐个测。

**Files:**
- Create: `src/paseo/timeline.ts`
- Test: `src/paseo/timeline.test.ts`

**Interfaces:**
- Consumes: `TimelineMessage`（从 `@getpaseo/client/internal/daemon-client` 拿类型；若该类型未导出，就按「已核实的事实」里的形状在本地声明一个同名联合类型）
- Produces:
  - `type BlockKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice"`
  - `type TimelineInput = { type: string; payload?: Record<string, unknown> }`（reducer 的输入类型，Task 8 会用它做边界断言）
  - `interface Block { key: string; kind: BlockKind; text: string; done: boolean; toolName?: string; toolStatus?: string }`
  - `interface ConversationState { blocks: Block[]; running: boolean; notices: string[] }`
  - `createConversationState(): ConversationState`
  - `canSendFollowUp(state: ConversationState): boolean`
  - `reduceTimeline(state: ConversationState, message: TimelineMessage): ConversationState`
  - `toMarkdown(state: ConversationState): string`

- [ ] **Step 1: 写失败的测试 `src/paseo/timeline.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { canSendFollowUp, createConversationState, reduceTimeline, toMarkdown } from "./timeline";

function stream(event: unknown) {
  return {
    type: "agent_stream",
    payload: { agentId: "a1", event, timestamp: "2026-10-09T00:00:00.000Z" },
  } as never;
}

function item(value: unknown) {
  return stream({ type: "timeline", provider: "claude", item: value });
}

describe("reduceTimeline", () => {
  it("concatenates assistant pieces into one block", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "assistant_message", text: "你好" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "，世界" }));
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].text).toBe("你好，世界");
  });

  it("starts a new assistant block after a user message", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "assistant_message", text: "第一轮" }));
    state = reduceTimeline(state, item({ type: "user_message", text: "再来" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "第二轮" }));
    expect(state.blocks.map((b) => b.kind)).toEqual(["assistant", "user", "assistant"]);
    expect(state.blocks[2].text).toBe("第二轮");
  });

  it("marks the turn finished only on turn_completed", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    expect(state.running).toBe(true);
    state = reduceTimeline(state, item({ type: "assistant_message", text: "ok" }));
    expect(state.running).toBe(true);
    state = reduceTimeline(state, stream({ type: "turn_completed", provider: "claude" }));
    expect(state.running).toBe(false);
    expect(state.blocks.every((b) => b.done)).toBe(true);
  });

  it("records a failed turn as an error block and stops running", () => {
    let state = createConversationState();
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    state = reduceTimeline(state, stream({ type: "turn_failed", provider: "claude", error: "额度用完了" }));
    expect(state.running).toBe(false);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "error", text: "额度用完了" });
  });

  it("updates a tool call block in place instead of appending", () => {
    let state = createConversationState();
    state = reduceTimeline(
      state,
      item({ type: "tool_call", callId: "c1", name: "Read", status: "running", detail: { type: "unknown", input: {}, output: null } }),
    );
    expect(state.blocks[0]).toMatchObject({ kind: "tool", toolName: "Read", toolStatus: "running" });
    state = reduceTimeline(
      state,
      item({ type: "tool_call", callId: "c1", name: "Read", status: "completed", detail: { type: "unknown", input: {}, output: "ok" } }),
    );
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0].toolStatus).toBe("completed");
  });

  it("blocks follow-ups while a turn is running", () => {
    let state = createConversationState();
    expect(canSendFollowUp(state)).toBe(true);
    state = reduceTimeline(state, stream({ type: "turn_started", provider: "claude" }));
    expect(canSendFollowUp(state)).toBe(false);
    state = reduceTimeline(state, stream({ type: "turn_completed", provider: "claude" }));
    expect(canSendFollowUp(state)).toBe(true);
  });

  it("surfaces subscription lifecycle messages as notices without breaking the stream", () => {
    let state = createConversationState();
    state = reduceTimeline(state, {
      type: "agent.timeline.subscription_restored",
      payload: { agentId: "a1", subscriptionId: "s1" },
    } as never);
    state = reduceTimeline(state, item({ type: "assistant_message", text: "继续" }));
    expect(state.blocks.at(-1)?.text).toBe("继续");
    expect(state.notices.join()).toContain("重连");
  });

  it("reports an observation error", () => {
    const state = reduceTimeline(createConversationState(), {
      type: "agent.timeline.error",
      payload: { agentId: "a1", error: "boom" },
    } as never);
    expect(state.blocks.at(-1)).toMatchObject({ kind: "error", text: "boom" });
  });
});

describe("toMarkdown", () => {
  it("renders the user's question and the assistant answer", () => {
    let state = createConversationState();
    state = reduceTimeline(state, item({ type: "user_message", text: "workdir is ?" }));
    state = reduceTimeline(state, item({ type: "assistant_message", text: "是 .paseo" }));
    const markdown = toMarkdown(state);
    expect(markdown).toContain("workdir is ?");
    expect(markdown).toContain("是 .paseo");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/paseo/timeline.test.ts`
Expected: FAIL，`Failed to resolve import "./timeline"`。

- [ ] **Step 3: 实现 `src/paseo/timeline.ts`**

```ts
/**
 * 把 paseo 的 timeline 事件流归约成可以直接渲染的块序列。
 * 纯函数：同样的输入必然得到同样的输出，方便单测和 React 增量刷新。
 */

export type BlockKind = "user" | "assistant" | "reasoning" | "tool" | "error" | "notice";

export interface Block {
  key: string;
  kind: BlockKind;
  text: string;
  done: boolean;
  toolName?: string;
  toolStatus?: string;
}

export interface ConversationState {
  blocks: Block[];
  running: boolean;
  notices: string[];
}

/**
 * reducer 的输入类型。故意放宽：SDK 的事件联合类型在不同版本间会动，这里只依赖
 * `type` 和 `payload.event/item` 这几个我们在「已核实的事实」里确认过的字段。
 * 边界处由调用方断言（见 Task 8），reducer 本身不碰未确认的字段。
 */
export type TimelineInput = { type: string; payload?: Record<string, unknown> };

export function createConversationState(): ConversationState {
  return { blocks: [], running: false, notices: [] };
}

/**
 * 回答进行中不允许追问：daemon 收到新消息会打断当前这一轮（SendMessageOptions 的
 * activeTurnBehavior 省略即为 interrupt），静默打断不是用户想要的。要插话先显式停止。
 */
export function canSendFollowUp(state: ConversationState): boolean {
  return !state.running;
}

function append(state: ConversationState, block: Block): ConversationState {
  return { ...state, blocks: [...state.blocks, block] };
}

function replaceLast(state: ConversationState, patch: Partial<Block>): ConversationState {
  if (state.blocks.length === 0) return state;
  const blocks = state.blocks.slice();
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...patch };
  return { ...state, blocks };
}

/** 分片到达的 assistant_message 追加到上一个 assistant 块；否则开新块。 */
function appendAssistant(state: ConversationState, text: string): ConversationState {
  const last = state.blocks[state.blocks.length - 1];
  if (last && last.kind === "assistant" && !last.done) {
    return replaceLast(state, { text: last.text + text });
  }
  return append(state, { key: `assistant-${state.blocks.length}`, kind: "assistant", text, done: false });
}

function upsertTool(
  state: ConversationState,
  callId: string,
  name: string,
  status: string,
): ConversationState {
  const index = state.blocks.findIndex((block) => block.key === `tool-${callId}`);
  const done = status === "completed" || status === "failed" || status === "canceled";
  if (index === -1) {
    return append(state, {
      key: `tool-${callId}`,
      kind: "tool",
      text: "",
      done,
      toolName: name,
      toolStatus: status,
    });
  }
  const blocks = state.blocks.slice();
  blocks[index] = { ...blocks[index], toolName: name, toolStatus: status, done };
  return { ...state, blocks };
}

function handleItem(state: ConversationState, itemValue: Record<string, unknown>): ConversationState {
  const itemType = String(itemValue.type ?? "");
  switch (itemType) {
    case "user_message":
      return append(state, {
        key: `user-${state.blocks.length}`,
        kind: "user",
        text: String(itemValue.text ?? ""),
        done: true,
      });
    case "assistant_message":
      return appendAssistant(state, String(itemValue.text ?? ""));
    case "reasoning":
      return append(state, {
        key: `reasoning-${state.blocks.length}`,
        kind: "reasoning",
        text: String(itemValue.text ?? ""),
        done: true,
      });
    case "tool_call":
      return upsertTool(
        state,
        String(itemValue.callId ?? ""),
        String(itemValue.name ?? "tool"),
        String(itemValue.status ?? "running"),
      );
    case "error":
      return append(state, {
        key: `error-${state.blocks.length}`,
        kind: "error",
        text: String(itemValue.message ?? "agent 报错"),
        done: true,
      });
    case "notification":
      return append(state, {
        key: `notice-${state.blocks.length}`,
        kind: "notice",
        text: String(itemValue.message ?? ""),
        done: true,
      });
    default:
      return state;
  }
}

export function reduceTimeline(state: ConversationState, message: TimelineInput): ConversationState {
  switch (message.type) {
    case "agent_stream": {
      const payload = (message.payload ?? {}) as { event?: Record<string, unknown> };
      const event = (payload.event ?? {}) as Record<string, unknown>;
      switch (String(event.type ?? "")) {
        case "timeline":
          return handleItem(state, (event.item ?? {}) as Record<string, unknown>);
        case "turn_started":
          return { ...state, running: true };
        case "turn_completed":
        case "turn_canceled": {
          const finished = { ...state, running: false };
          return { ...finished, blocks: finished.blocks.map((block) => ({ ...block, done: true })) };
        }
        case "turn_failed": {
          const finished = { ...state, running: false };
          return append(
            { ...finished, blocks: finished.blocks.map((block) => ({ ...block, done: true })) },
            {
              key: `error-${state.blocks.length}`,
              kind: "error",
              text: String(event.error ?? "这一轮失败了"),
              done: true,
            },
          );
        }
        default:
          return state;
      }
    }
    case "agent.timeline.subscription_restored":
      return {
        ...state,
        notices: [...state.notices, "连接重连过，中间可能漏了内容；重新打开这个会话可看到完整历史。"],
      };
    case "agent.timeline.error":
      return append(state, {
        key: `error-${state.blocks.length}`,
        kind: "error",
        text: String((message.payload ?? {}).error ?? "时间线订阅失败"),
        done: true,
      });
    case "agent.timeline.replacement":
      return {
        ...state,
        notices: [...state.notices, "会话在别处被替换了，重新打开可看到最新内容。"],
      };
    default:
      return state;
  }
}

const KIND_LABEL: Record<BlockKind, string> = {
  user: "🧑 你",
  assistant: "🐾 Paseo",
  reasoning: "💭 思考",
  tool: "🔧 工具",
  error: "⚠️ 错误",
  notice: "ℹ️ 提示",
};

export function toMarkdown(state: ConversationState): string {
  if (state.blocks.length === 0) {
    return state.running ? "等待 agent 开始…" : "还没有内容。";
  }
  return state.blocks
    .map((block) => {
      if (block.kind === "tool") {
        const status = block.toolStatus ?? "running";
        return `\`${block.toolName ?? "tool"}\` — ${status}`;
      }
      const label = KIND_LABEL[block.kind];
      if (block.kind === "assistant") return `**${label}**\n\n${block.text}`;
      if (block.kind === "user") return `> **${label}**：${block.text}`;
      return `**${label}**：${block.text}`;
    })
    .join("\n\n---\n\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/paseo/timeline.test.ts`
Expected: PASS（9 个用例）。

- [ ] **Step 5: 类型对齐检查**

`@getpaseo/client/internal/daemon-client` 未必导出 `TimelineMessage`。用下面命令确认：

```bash
grep -n "TimelineMessage" node_modules/@getpaseo/client/dist/daemon-client.d.ts
```

- 有导出：给 `reduceTimeline` 的参数加上 `& TimelineMessage`（或把 `TimelineInput` 定义成 `TimelineMessage` 的宽松超集），让编辑器能提示字段名。别删掉 `TimelineInput`——Task 8 靠它做边界断言。
- 没导出：保持现状，`TimelineInput` 已经是「已核实的事实」里那份形状的宽松版。

- [ ] **Step 6: 提交**

```bash
git add src/paseo/timeline.ts src/paseo/timeline.test.ts
git commit -m "feat: reduce paseo timeline events into renderable blocks"
```

---

### Task 5: 会话操作封装

**Files:**
- Create: `src/paseo/agents.ts`
- Test: `src/paseo/agents.test.ts`

**Interfaces:**
- Consumes: `DaemonClient` 类型（`@getpaseo/client/internal/daemon-client`）
- Produces:
  - `interface SessionRow { id: string; title: string; status: string; cwd: string; updatedAt: string; archivedAt: string | null }`
  - `toSessionRow(agent: unknown): SessionRow`
  - `listSessions(client: AgentsClient, options?: { includeArchived?: boolean }): Promise<SessionRow[]>`
  - `startAgent(client: AgentsClient, params: { provider: string; model?: string; cwd: string; prompt: string; title?: string }): Promise<string>`
  - `sendFollowUp(client: AgentsClient, agentId: string, text: string): Promise<void>`
  - `stopAgent(client: AgentsClient, agentId: string): Promise<void>`
  - `archiveAgent(client: AgentsClient, agentId: string): Promise<void>`
  - `interface AgentsClient { fetchAgents; createAgent; sendAgentMessage; cancelAgent; archiveAgent }`（鸭子类型，便于用假对象测）

- [ ] **Step 1: 写失败的测试 `src/paseo/agents.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { listSessions, startAgent, stopAgent, toSessionRow } from "./agents";

describe("toSessionRow", () => {
  it("maps the daemon snapshot to the fields the list view needs", () => {
    const row = toSessionRow({
      id: "abc123",
      title: "问 paseo 工作目录",
      status: "idle",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      updatedAt: "2026-10-09T03:00:00.000Z",
      archivedAt: null,
    });
    expect(row).toEqual({
      id: "abc123",
      title: "问 paseo 工作目录",
      status: "idle",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      updatedAt: "2026-10-09T03:00:00.000Z",
      archivedAt: null,
    });
  });

  it("falls back to the short id when the agent has no title", () => {
    expect(toSessionRow({ id: "abcdef123456", title: null }).title).toBe("abcdef1");
  });
});

describe("listSessions", () => {
  it("drops archived sessions by default", async () => {
    const client = {
      fetchAgents: vi.fn(async () => ({
        entries: [
          { agent: { id: "a", title: "keep", status: "idle", cwd: "/x", updatedAt: "t", archivedAt: null } },
          { agent: { id: "b", title: "gone", status: "idle", cwd: "/x", updatedAt: "t", archivedAt: "2026-10-01T00:00:00.000Z" } },
        ],
      })),
    };
    const rows = await listSessions(client as never);
    expect(rows.map((row) => row.id)).toEqual(["a"]);
  });

  it("keeps archived sessions when asked", async () => {
    const client = {
      fetchAgents: vi.fn(async () => ({
        entries: [
          { agent: { id: "b", title: "gone", status: "idle", cwd: "/x", updatedAt: "t", archivedAt: "2026-10-01T00:00:00.000Z" } },
        ],
      })),
    };
    const rows = await listSessions(client as never, { includeArchived: true });
    expect(rows).toHaveLength(1);
  });
});

describe("startAgent", () => {
  it("passes provider, cwd, prompt and labels through", async () => {
    const createAgent = vi.fn(async () => ({ id: "new-1" }));
    const id = await startAgent({ createAgent } as never, {
      provider: "claude",
      cwd: "D:\\Acme\\Workshop\\.paseo",
      prompt: "workdir is ?",
    });
    expect(id).toBe("new-1");
    expect(createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "claude",
        cwd: "D:\\Acme\\Workshop\\.paseo",
        initialPrompt: "workdir is ?",
        labels: { source: "raycast" },
      }),
    );
  });
});

describe("stopAgent", () => {
  it("calls cancelAgent", async () => {
    const cancelAgent = vi.fn(async () => undefined);
    await stopAgent({ cancelAgent } as never, "a1");
    expect(cancelAgent).toHaveBeenCalledWith("a1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/paseo/agents.test.ts`
Expected: FAIL，`Failed to resolve import "./agents"`。

- [ ] **Step 3: 实现 `src/paseo/agents.ts`**

```ts
/** 会话操作的薄封装。只做参数搬运和 DTO 映射，方便用假 client 单测。 */

export interface AgentsClient {
  fetchAgents(options?: unknown): Promise<{ entries: Array<{ agent: unknown }> }>;
  createAgent(options: unknown): Promise<unknown>;
  sendAgentMessage(agentId: string, text: string, options?: unknown): Promise<void>;
  cancelAgent(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
}

export interface SessionRow {
  id: string;
  title: string;
  status: string;
  cwd: string;
  updatedAt: string;
  archivedAt: string | null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function toSessionRow(agent: unknown): SessionRow {
  const raw = (agent ?? {}) as Record<string, unknown>;
  const id = asString(raw.id);
  return {
    id,
    title: asString(raw.title) || id.slice(0, 7),
    status: asString(raw.status, "unknown"),
    cwd: asString(raw.cwd),
    updatedAt: asString(raw.updatedAt),
    archivedAt: typeof raw.archivedAt === "string" ? raw.archivedAt : null,
  };
}

export async function listSessions(
  client: AgentsClient,
  options: { includeArchived?: boolean } = {},
): Promise<SessionRow[]> {
  const result = await client.fetchAgents({ filter: { includeArchived: options.includeArchived === true } });
  return result.entries
    .map((entry) => toSessionRow(entry.agent))
    .filter((row) => options.includeArchived === true || row.archivedAt === null);
}

export async function startAgent(
  client: AgentsClient,
  params: { provider: string; model?: string; cwd: string; prompt: string; title?: string },
): Promise<string> {
  const agent = (await client.createAgent({
    provider: params.provider,
    ...(params.model?.trim() ? { model: params.model.trim() } : {}),
    cwd: params.cwd,
    ...(params.title ? { title: params.title } : {}),
    initialPrompt: params.prompt,
    labels: { source: "raycast" },
  })) as { id?: unknown };
  const id = asString(agent?.id);
  if (!id) throw new Error("daemon 没有返回 agent id");
  return id;
}

export function sendFollowUp(client: AgentsClient, agentId: string, text: string): Promise<void> {
  return client.sendAgentMessage(agentId, text);
}

export function stopAgent(client: AgentsClient, agentId: string): Promise<void> {
  return client.cancelAgent(agentId);
}

export function archiveAgent(client: AgentsClient, agentId: string): Promise<{ archivedAt: string }> {
  return client.archiveAgent(agentId);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/paseo/agents.test.ts`
Expected: PASS（8 个用例）。

- [ ] **Step 5: 提交**

```bash
git add src/paseo/agents.ts src/paseo/agents.test.ts
git commit -m "feat: wrap paseo session operations behind a testable facade"
```

---

### Task 6: 在桌面端打开

**Files:**
- Create: `src/paseo/desktop.ts`
- Test: `src/paseo/desktop.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `buildAgentDeepLink(serverId: string, agentId: string): string`
  - `paseoAppCandidates(env?: NodeJS.ProcessEnv): string[]`
  - `openAgentInDesktop(params: { serverId: string; agentId: string; preferredPath?: string; launch?: (command: string, args: string[]) => Promise<void>; exists?: (path: string) => boolean }): Promise<void>`

- [ ] **Step 1: 写失败的测试 `src/paseo/desktop.test.ts`**

```ts
import { describe, expect, it, vi } from "vitest";
import { buildAgentDeepLink, openAgentInDesktop, paseoAppCandidates } from "./desktop";

describe("buildAgentDeepLink", () => {
  it("matches paseo's own deep link format", () => {
    expect(buildAgentDeepLink("srv_0123456789ab", "abc123")).toBe(
      "paseo://h/srv_0123456789ab/agent/abc123",
    );
  });

  it("percent-encodes both ids", () => {
    expect(buildAgentDeepLink("srv/a", "id b")).toBe("paseo://h/srv%2Fa/agent/id%20b");
  });

  it("agrees with the deep link builder paseo itself ships", async () => {
    const { buildAgentDeepLink: theirs } = await import("@getpaseo/protocol/agent-deep-link");
    for (const [serverId, agentId] of [
      ["srv_0123456789ab", "abc123"],
      ["srv/a", "id b"],
      ["  padded  ", "  also padded  "],
    ]) {
      expect(buildAgentDeepLink(serverId, agentId)).toBe(theirs({ serverId, agentId }));
    }
  });

  it("builds a link paseo's own parser can read back", async () => {
    const { parseAgentDeepLink } = await import("@getpaseo/protocol/agent-deep-link");
    for (const [serverId, agentId] of [
      ["srv_0123456789ab", "abc123"],
      ["srv/a", "id b"],
    ]) {
      expect(parseAgentDeepLink(buildAgentDeepLink(serverId, agentId))).toEqual({ serverId, agentId });
    }
  });

  it("refuses an empty id instead of building a link nothing can parse", () => {
    expect(() => buildAgentDeepLink("", "a1")).toThrow();
    expect(() => buildAgentDeepLink("srv1", "   ")).toThrow();
  });
});

describe("paseoAppCandidates", () => {
  it("prefers the local app data install", () => {
    const candidates = paseoAppCandidates({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" });
    expect(candidates[0]).toBe("C:\\Users\\me\\AppData\\Local\\Programs\\Paseo\\Paseo.exe");
  });

  it("returns nothing when LOCALAPPDATA is unset", () => {
    expect(paseoAppCandidates({})).toEqual([]);
  });
});

describe("openAgentInDesktop", () => {
  it("launches the preferred executable with the deep link", async () => {
    const launch = vi.fn(async () => undefined);
    await openAgentInDesktop({
      serverId: "srv1",
      agentId: "a1",
      preferredPath: "D:\\Apps\\Paseo\\Paseo.exe",
      launch,
      exists: () => true,
    });
    expect(launch).toHaveBeenCalledWith("D:\\Apps\\Paseo\\Paseo.exe", [
      "paseo://h/srv1/agent/a1",
    ]);
  });

  it("falls back to a discovered path", async () => {
    const launch = vi.fn(async () => undefined);
    await openAgentInDesktop({
      serverId: "srv1",
      agentId: "a1",
      launch,
      exists: (path) => path.endsWith("Programs\\Paseo\\Paseo.exe"),
    });
    expect(launch).toHaveBeenCalledOnce();
  });

  it("throws a Chinese hint when no executable is found", async () => {
    await expect(
      openAgentInDesktop({ serverId: "srv1", agentId: "a1", launch: vi.fn(), exists: () => false }),
    ).rejects.toThrow(/Paseo\.exe/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/paseo/desktop.test.ts`
Expected: FAIL，`Failed to resolve import "./desktop"`。

- [ ] **Step 3: 实现 `src/paseo/desktop.ts`**

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 输出与 paseo 自带的 `@getpaseo/protocol/agent-deep-link` 一致：两端 trim，
 * 空值抛错，`paseo://`——**两个**斜杠（原因见上文「已核实的事实」）。
 *
 * 刻意不 import 那一个：protocol 的 exports 是 `./*` 通配，等于把每个内部文件
 * 都暴露出来、没有任何稳定性承诺；而 URL 格式本身是必须稳定的契约。测试里有
 * 交叉校验 + 往返校验，格式漂移会在测试阶段炸出来。
 */
export function buildAgentDeepLink(serverId: string, agentId: string): string {
  const server = serverId.trim();
  const agent = agentId.trim();
  if (!server || !agent) {
    throw new Error("深链需要 server id 和 agent id，收到空值。");
  }
  return `paseo://h/${encodeURIComponent(server)}/agent/${encodeURIComponent(agent)}`;
}

/** CLI 在同平台找的顺序；本机装在 D:\Apps，所以偏好里可以覆盖。 */
export function paseoAppCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const localAppData = env.LOCALAPPDATA?.trim();
  return localAppData ? [join(localAppData, "Programs", "Paseo", "Paseo.exe")] : [];
}

export interface OpenAgentInDesktopParams {
  serverId: string;
  agentId: string;
  preferredPath?: string;
  launch?: (command: string, args: string[]) => Promise<void>;
  exists?: (path: string) => boolean;
}

function defaultLaunch(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // 桌面版要从 CLI 的环境里摘掉 ELECTRON_RUN_AS_NODE，否则会以纯 Node 进程启动。
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const child = spawn(command, args, { detached: true, stdio: "ignore", env });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export async function openAgentInDesktop(params: OpenAgentInDesktopParams): Promise<void> {
  const exists = params.exists ?? existsSync;
  const launch = params.launch ?? defaultLaunch;

  // 先算链接：id 为空时要在启动任何进程之前就失败。
  const link = buildAgentDeepLink(params.serverId, params.agentId);

  const preferred = params.preferredPath?.trim();
  const candidates = [
    ...(preferred ? [preferred] : []),
    ...paseoAppCandidates(),
  ];
  const app = candidates.find((candidate) => exists(candidate));
  if (!app) {
    throw new Error(
      "没找到 Paseo.exe。请在扩展设置里把「Paseo.exe 路径」填上（本机一般是 D:\\Apps\\Paseo\\Paseo.exe）。",
    );
  }
  await launch(app, [link]);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/paseo/desktop.test.ts`
Expected: PASS（10 个用例）。

- [ ] **Step 5: 手动验证一次真实深链**

```bash
node -e "const {spawn}=require('child_process');const p='D:\\\\Apps\\\\Paseo\\\\Paseo.exe';const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;spawn(p,['paseo://h/'+encodeURIComponent('srv_0123456789ab')+'/agent/'+encodeURIComponent('<粘贴一个真实 agent id>')],{detached:true,stdio:'ignore',env}).unref()"
```

agent id 用 `paseo ls` 里任意一个。预期：Paseo 桌面版窗口被拉到前台并打开那个会话。

- [ ] **Step 6: 提交**

```bash
git add src/paseo/desktop.ts src/paseo/desktop.test.ts
git commit -m "feat: open a paseo agent in the desktop app via deep link"
```

---

### Task 7: 共享会话视图组件

**Files:**
- Create: `src/components/conversation-detail.tsx`

**Interfaces:**
- Consumes: `ConversationState` / `toMarkdown` / `canSendFollowUp`（Task 4）
- Produces:
  - `interface ConversationDetailProps { agentId: string; state: ConversationState; onFollowUp: (text: string) => void; onStop: () => void; onArchive: () => void; onOpenDesktop: () => void }`
  - `export default function ConversationDetail(props: ConversationDetailProps): JSX.Element`

组件不碰 `DaemonClient` / `serverId` / preference：所有副作用都由上层 command 通过回调注入，这样两条命令能共用同一个视图。

- [ ] **Step 1: 写组件 `src/components/conversation-detail.tsx`**

```tsx
import { Action, ActionPanel, Detail, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import { canSendFollowUp, toMarkdown } from "../paseo/timeline";
import type { ConversationState } from "../paseo/timeline";

interface ConversationDetailProps {
  agentId: string;
  state: ConversationState;
  onFollowUp: (text: string) => void;
  onStop: () => void;
  onArchive: () => void;
  onOpenDesktop: () => void;
}

function FollowUpForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="发送"
            onSubmit={(values: { text: string }) => {
              const text = values.text.trim();
              if (!text) return;
              onSubmit(text);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="text" title="追问" placeholder="继续问这个 agent…" autoFocus />
      <Form.Description text="agent 正在回答时发消息会打断当前这一轮；要插话请先停止。" />
    </Form>
  );
}

export default function ConversationDetail(props: ConversationDetailProps) {
  const { state } = props;
  const markdown = toMarkdown(state);

  return (
    <Detail
      isLoading={state.running}
      markdown={markdown}
      metadata={
        <Detail.Metadata>
          <Detail.Metadata.Label title="Agent" text={props.agentId} />
          <Detail.Metadata.Label title="状态" text={state.running ? "正在回答" : "空闲"} />
        </Detail.Metadata>
      }
      actions={
        <ActionPanel>
          {canSendFollowUp(state) ? (
            <Action.Push
              title="追问"
              icon={Icon.Message}
              target={<FollowUpForm onSubmit={props.onFollowUp} />}
              shortcut={{ modifiers: ["cmd"], key: "enter" }}
            />
          ) : (
            <Action
              title="正在回答…（先停止才能追问）"
              icon={Icon.Clock}
              onAction={() =>
                showToast({ style: Toast.Style.Animated, title: "agent 正在回答，先按「停止」" })
              }
            />
          )}
          <Action title="停止" icon={Icon.Stop} onAction={props.onStop} />
          <Action.CopyToClipboard title="复制 agent id" content={props.agentId} />
          <Action title="在 Paseo 桌面端打开" icon={Icon.Window} onAction={props.onOpenDesktop} />
          <Action
            title="归档这个会话"
            icon={Icon.Trash}
            style={Action.Style.Destructive}
            onAction={props.onArchive}
          />
        </ActionPanel>
      }
    />
  );
}
```

回答进行中「追问」这一项会换成一条提示动作（Review Focus 第 3 条）：判定逻辑在 `canSendFollowUp`，不在组件里，所以它是被单测覆盖的。

- [ ] **Step 2: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。这里用到的 `Icon.Message` / `Icon.Stop` / `Icon.Clock` / `Icon.Window` / `Icon.Trash` 和 `Action.Style.Destructive` 都是 `@raycast/api` 的稳定导出；若某个报不存在，按 IDE 提示换同义 icon。

- [ ] **Step 3: 提交**

```bash
git add src/components/conversation-detail.tsx
git commit -m "feat: add a shared conversation detail view with follow-up form"
```

---

### Task 8: 连接与订阅的 hook（含 80ms 节流）

**Files:**
- Create: `src/hooks/use-paseo-endpoint.ts`
- Create: `src/hooks/use-conversation.ts`

**Interfaces:**
- Consumes: `connectPaseo` / `describeConnectionError` / `PaseoEndpoint`（Task 3）、`reduceTimeline` / `createConversationState` / `TimelineInput`（Task 4）、`sendFollowUp` / `stopAgent` / `archiveAgent` / `AgentsClient`（Task 5）
- Produces（`src/hooks/use-paseo-endpoint.ts`）：
  - `usePreferences(): Preferences`（`{ daemonHost, paseoHome?, provider, model?, defaultCwd?, paseoAppPath? }`）
  - `usePaseoEndpoint(): PaseoEndpoint`
- Produces（`src/hooks/use-conversation.ts`）：
  - `useConversation(params: { endpoint: PaseoEndpoint; agentId?: string }): { state: ConversationState; error?: string; send: (text: string) => Promise<void>; stop: () => Promise<void>; archive: () => Promise<void> }`

- [ ] **Step 1: 写 `src/hooks/use-paseo-endpoint.ts`**

```ts
import { getPreferenceValues } from "@raycast/api";
import { useMemo } from "react";
import { resolvePaseoHome } from "../paseo/credential";
import type { PaseoEndpoint } from "../paseo/client";

interface Preferences {
  daemonHost: string;
  paseoHome?: string;
  provider: string;
  model?: string;
  defaultCwd?: string;
  paseoAppPath?: string;
}

export function usePreferences(): Preferences {
  return getPreferenceValues<Preferences>();
}

export function usePaseoEndpoint(): PaseoEndpoint {
  const prefs = usePreferences();
  return useMemo(
    () => ({
      host: prefs.daemonHost?.trim() || "127.0.0.1:6767",
      home: prefs.paseoHome?.trim() || resolvePaseoHome(),
    }),
    [prefs.daemonHost, prefs.paseoHome],
  );
}
```

- [ ] **Step 2: 写 `src/hooks/use-conversation.ts`**

节流是硬要求：agent 回答时每几毫秒来一个分片，每个分片都 setState 会让 Raycast 界面卡死。

```ts
import { useEffect, useRef, useState } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectPaseo, describeConnectionError } from "../paseo/client";
import type { PaseoEndpoint } from "../paseo/client";
import { createConversationState, reduceTimeline } from "../paseo/timeline";
import type { ConversationState, TimelineInput } from "../paseo/timeline";
import { archiveAgent, sendFollowUp, stopAgent } from "../paseo/agents";
import type { AgentsClient } from "../paseo/agents";

const FLUSH_INTERVAL_MS = 80;

export function useConversation(params: { endpoint: PaseoEndpoint; agentId?: string }) {
  const { endpoint, agentId } = params;
  const [state, setState] = useState<ConversationState>(createConversationState);
  const [error, setError] = useState<string>();

  const pendingRef = useRef(state);
  const clientRef = useRef<DaemonClient>();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let release: (() => void) | undefined;

    (async () => {
      try {
        const connected = await connectPaseo(endpoint);
        if (cancelled) {
          void connected.close();
          return;
        }
        clientRef.current = connected;

        if (agentId) {
          const subscription = connected.subscribeAgentTimeline(agentId, (message) => {
            // 边界断言：SDK 的事件类型比 reducer 认识的字段多，这里收窄成 TimelineInput。
            pendingRef.current = reduceTimeline(pendingRef.current, message as unknown as TimelineInput);
          });
          await subscription.ready;
          release = () => void subscription.release();
          // 历史先拉一页，避免只看到订阅之后的增量。
          const page = await connected.fetchAgentTimeline({
            agentId,
            direction: "before",
            limit: 200,
            projection: "projected",
          });
          for (const entry of page.entries) {
            // 历史条目同构于流式事件里的 item，包一层就能复用同一个 reducer（这里不需要断言）。
            pendingRef.current = reduceTimeline(pendingRef.current, {
              type: "agent_stream",
              payload: { agentId, event: { type: "timeline", provider: entry.provider, item: entry.item } },
            });
          }
          setState(pendingRef.current);
        }

        timer = setInterval(() => {
          setState((current) => (pendingRef.current === current ? current : pendingRef.current));
        }, FLUSH_INTERVAL_MS);
      } catch (connectError) {
        if (!cancelled) setError(describeConnectionError(connectError, endpoint));
      }
    })();

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      release?.();
      const current = clientRef.current;
      clientRef.current = undefined;
      void current?.close();
    };
  }, [endpoint.host, endpoint.home, agentId]);

  return {
    state,
    error,
    send: async (text: string) => {
      if (!clientRef.current || !agentId) return;
      await sendFollowUp(clientRef.current as unknown as AgentsClient, agentId, text);
    },
    stop: async () => {
      if (!clientRef.current || !agentId) return;
      await stopAgent(clientRef.current as unknown as AgentsClient, agentId);
    },
    archive: async () => {
      if (!clientRef.current || !agentId) return;
      await archiveAgent(clientRef.current as unknown as AgentsClient, agentId);
    },
  };
}
```

- [ ] **Step 3: 用 d.ts 核对时间线两处调用**

```bash
grep -n -A 14 "fetchAgentTimeline\|subscribeAgentTimeline" node_modules/@getpaseo/client/dist/daemon-client.d.ts
```

确认三件事：`fetchAgentTimeline` 的参数对象里有 `direction` / `limit` / `projection`，返回值有 `entries`，且 `entries` 的元素带 `provider` 和 `item`。对不上就按 d.ts 改上面那段代码——源码里这三个名字已核实，但 d.ts 才是最终裁判。

- [ ] **Step 4: 类型检查**

Run: `npm run typecheck`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/hooks/
git commit -m "feat: connect and stream a paseo conversation with throttled state updates"
```

---

### Task 9: 命令 1 — Ask Paseo

**Files:**
- Create: `src/ask.tsx`
- Modify: `src/paseo-probe.tsx` → 删除（探针使命完成）

**Interfaces:**
- Consumes: `useConversation`（Task 8）、`usePaseoEndpoint` / `usePreferences`（Task 8）、`ConversationDetail`（Task 7）、`startAgent` / `AgentsClient`（Task 5）、`connectPaseo` / `describeConnectionError`（Task 3）、`openAgentInDesktop`（Task 6）
- Produces: `default function Command(props: LaunchProps<{ arguments: { question?: string } }>)`

- [ ] **Step 1: 写 `src/ask.tsx`**

```tsx
import { Action, ActionPanel, Clipboard, Detail, Form, LaunchProps } from "@raycast/api";
import { useEffect, useState } from "react";
import ConversationDetail from "./components/conversation-detail";
import { useConversation } from "./hooks/use-conversation";
import { usePaseoEndpoint, usePreferences } from "./hooks/use-paseo-endpoint";
import { startAgent } from "./paseo/agents";
import type { AgentsClient } from "./paseo/agents";
import { connectPaseo, describeConnectionError } from "./paseo/client";
import { openAgentInDesktop } from "./paseo/desktop";

type AskProps = LaunchProps<{ arguments: { question?: string } }>;

function QuestionForm({ onSubmit }: { onSubmit: (text: string) => void }) {
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="提问"
            onSubmit={(values: { text: string }) => {
              const text = values.text.trim();
              if (text) onSubmit(text);
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextArea id="text" title="问题" placeholder="问 paseo 什么？" autoFocus />
    </Form>
  );
}

export default function Command(props: AskProps) {
  const prefs = usePreferences();
  const endpoint = usePaseoEndpoint();
  const [question, setQuestion] = useState<string | undefined>(props.arguments.question?.trim() || undefined);
  const [agentId, setAgentId] = useState<string>();
  const [serverId, setServerId] = useState<string>();
  const [error, setError] = useState<string>();

  // 参数没给、剪贴板也没有时，等用户用表单填
  useEffect(() => {
    if (question) return;
    (async () => {
      const clipboard = (await Clipboard.readText())?.trim();
      if (clipboard) setQuestion(clipboard);
    })();
  }, [question]);

  // 有问题、还没建 agent 时：建一个，然后交给会话视图
  useEffect(() => {
    if (!question || agentId) return;
    let cancelled = false;
    (async () => {
      try {
        const client = await connectPaseo(endpoint);
        if (cancelled) return void client.close();
        setServerId(client.getLastServerInfoMessage()?.serverId);
        const created = await startAgent(client as unknown as AgentsClient, {
          provider: prefs.provider || "claude",
          model: prefs.model,
          cwd: prefs.defaultCwd?.trim() || process.cwd(),
          prompt: question,
          title: question.slice(0, 60),
        });
        await client.close();
        if (!cancelled) setAgentId(created);
      } catch (createError) {
        if (!cancelled) setError(describeConnectionError(createError, endpoint));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [question, agentId, endpoint, prefs.provider, prefs.model, prefs.defaultCwd]);

  const conversation = useConversation({ endpoint, agentId });

  if (!question) {
    return (
      <QuestionForm
        onSubmit={(text) => {
          setQuestion(text);
        }}
      />
    );
  }

  if (error || conversation.error) {
    return <Detail markdown={`# 出错了\n\n${error ?? conversation.error}`} />;
  }

  if (!agentId) {
    return <Detail isLoading markdown="正在创建 agent…" />;
  }

  return (
    <ConversationDetail
      agentId={agentId}
      state={conversation.state}
      onFollowUp={(text) => void conversation.send(text)}
      onStop={() => void conversation.stop()}
      onArchive={() => void conversation.archive()}
      onOpenDesktop={() => {
        if (!serverId) return;
        void openAgentInDesktop({ serverId, agentId, preferredPath: prefs.paseoAppPath });
      }}
    />
  );
}
```

两个 hook 文件的分工是固定的：`use-paseo-endpoint.ts` 只做 preference → 配置的搬运，`use-conversation.ts` 管连接、订阅、副作用。按上面的 import 路径写，不要建 barrel 文件。

`client as unknown as AgentsClient` 这个双重断言是故意的：`AgentsClient` 是给单测用的鸭子类型（参数放宽到 `unknown`），真实的 `DaemonClient` 结构上兼容但签名更严，直接赋值 TS 不让过。改动 `AgentsClient` 的方法名时，**必须同步改 `src/paseo/*.ts` 里的真实调用**——这就是它的风险所在，所以只在命令层断言一次，业务逻辑保持在封装函数里。

- [ ] **Step 2: 删掉探针**

```bash
git rm src/paseo-probe.tsx
```

同时从 `package.json` 的 `commands` 数组里删掉 `paseo-probe` 那一项。

- [ ] **Step 3: 类型检查 + 手动验证**

```bash
npm run typecheck
npm run dev
```

Raycast 里跑 "Ask Paseo"，输入 `workdir is ?`。预期：
1. 先显示"正在创建 agent…"，约 1 秒后开始出现 `🐾 Paseo` 的内容并**逐字增长**；
2. 回答结束后不再有 loading 圈；
3. `⌘↵` 打开追问表单，发一句 `用一句话总结`，回答接在下面；
4. 回答过程中按「停止」，流停止；
5. 「在 Paseo 桌面端打开」能把桌面版拉到前台并打开这个 agent。

- [ ] **Step 4: 提交**

```bash
git add src/ask.tsx package.json
git commit -m "feat: add the Ask Paseo command"
```

---

### Task 10: 命令 2 — Paseo Sessions

**Files:**
- Create: `src/sessions.tsx`

**Interfaces:**
- Consumes: `useConversation` / `usePaseoEndpoint` / `usePreferences`（Task 8）、`ConversationDetail`（Task 7）、`listSessions` / `stopAgent` / `archiveAgent`（Task 5）、`openAgentInDesktop`（Task 6）
- Produces: `default function Command()`

- [ ] **Step 1: 写 `src/sessions.tsx`**

```tsx
import { Action, ActionPanel, Icon, List, Toast, showToast } from "@raycast/api";
import { useCachedPromise } from "@raycast/utils";
import ConversationDetail from "./components/conversation-detail";
import { useConversation } from "./hooks/use-conversation";
import { usePaseoEndpoint, usePreferences } from "./hooks/use-paseo-endpoint";
import { archiveAgent, listSessions, stopAgent } from "./paseo/agents";
import type { AgentsClient, SessionRow } from "./paseo/agents";
import { connectPaseo, describeConnectionError } from "./paseo/client";
import { openAgentInDesktop } from "./paseo/desktop";

function statusLabel(row: SessionRow): string {
  switch (row.status) {
    case "running":
      return "正在跑";
    case "idle":
      return "空闲";
    default:
      return row.status;
  }
}

function SessionDetail({ row, serverId }: { row: SessionRow; serverId: string }) {
  const endpoint = usePaseoEndpoint();
  const prefs = usePreferences();
  const conversation = useConversation({ endpoint, agentId: row.id });

  return (
    <ConversationDetail
      agentId={row.id}
      state={conversation.state}
      onFollowUp={(text) => void conversation.send(text)}
      onStop={() => void conversation.stop()}
      onArchive={() => void conversation.archive()}
      onOpenDesktop={() =>
        void openAgentInDesktop({ serverId, agentId: row.id, preferredPath: prefs.paseoAppPath })
      }
    />
  );
}

export default function Command() {
  const endpoint = usePaseoEndpoint();
  const prefs = usePreferences();

  const {
    data: sessions,
    isLoading,
    error,
    revalidate,
  } = useCachedPromise(async () => {
    const client = await connectPaseo(endpoint);
    try {
      const rows = await listSessions(client as unknown as AgentsClient);
      const serverId = client.getLastServerInfoMessage()?.serverId ?? "";
      return { rows, serverId };
    } finally {
      await client.close();
    }
  }, [endpoint.host, endpoint.home]);

  if (error) {
    return (
      <List>
        <List.EmptyView icon={Icon.Warning} title="连不上 Paseo" description={describeConnectionError(error, endpoint)} />
      </List>
    );
  }

  const rows = sessions?.rows ?? [];
  const serverId = sessions?.serverId ?? "";

  return (
    <List isLoading={isLoading} searchBarPlaceholder="按标题或目录筛选…">
      {rows.length === 0 && !isLoading ? (
        <List.EmptyView title="没有活跃会话" description="用 Ask Paseo 起一个新会话" />
      ) : null}
      {rows.map((row) => (
        <List.Item
          key={row.id}
          icon={row.status === "running" ? Icon.CircleProgress : Icon.Circle}
          title={row.title}
          subtitle={statusLabel(row)}
          accessories={[{ text: row.cwd }]}
          keywords={[row.cwd, row.id]}
          actions={
            <ActionPanel>
              <Action.Push
                title="打开会话"
                icon={Icon.Message}
                target={<SessionDetail row={row} serverId={serverId} />}
              />
              <Action
                title="停止"
                icon={Icon.Stop}
                onAction={async () => {
                  const client = await connectPaseo(endpoint);
                  try {
                    await stopAgent(client as unknown as AgentsClient, row.id);
                    await showToast({ style: Toast.Style.Success, title: "已停止" });
                  } finally {
                    await client.close();
                  }
                  revalidate();
                }}
              />
              <Action
                title="在 Paseo 桌面端打开"
                icon={Icon.Window}
                onAction={() =>
                  void openAgentInDesktop({
                    serverId,
                    agentId: row.id,
                    preferredPath: prefs.paseoAppPath,
                  })
                }
              />
              <Action.CopyToClipboard title="复制 agent id" content={row.id} />
              <Action
                title="归档"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                onAction={async () => {
                  const client = await connectPaseo(endpoint);
                  try {
                    await archiveAgent(client as unknown as AgentsClient, row.id);
                    await showToast({ style: Toast.Style.Success, title: "已归档" });
                  } finally {
                    await client.close();
                  }
                  revalidate();
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
```

- [ ] **Step 2: 确认 import 路径**

本文件从 `./hooks/use-conversation` 取 `useConversation`，从 `./hooks/use-paseo-endpoint` 取 `usePaseoEndpoint` / `usePreferences`。跟 Task 9 完全一致——跑 `npm run typecheck` 确认两个路径都能解析。

- [ ] **Step 3: 类型检查 + 手动验证**

```bash
npm run typecheck
npm run dev
```

Raycast 里跑 "Paseo Sessions"。预期：
1. 列出所有未归档会话，正在跑的显示「正在跑」；
2. 回车进入会话，能看到历史消息（历史是 refetch 拉的，不是订阅增量）；
3. 追问、停止、归档、桌面端打开都生效；
4. 归档后列表里不再出现（revalidate 之后）；
5. 关掉 Paseo 桌面版再跑一次 → 显示「连不上 Paseo」而不是堆栈。

- [ ] **Step 4: 提交**

```bash
git add src/sessions.tsx src/hooks/
git commit -m "feat: add the Paseo Sessions command"
```

---

### Task 11: 收尾

**Files:**
- Create: `README.md`
- Modify: `package.json`（只在 `ray build` 报缺 icon 时补一个 `assets/icon.png`）

**Interfaces:** 无新接口。

本地 `ray develop` 不需要 manifest 的 `icon` 字段；只有要发布到商店时才需要 512×512 的 PNG。本次不发布，所以**不要**为了凑 icon 去手搓二进制文件。

- [ ] **Step 1: 写 `README.md`**

````markdown
# Paseo for Raycast

从 Raycast 直接问本机 Paseo 的 coding agent，并管理已有会话。

## 前提

- Paseo 桌面版在运行（daemon 随它自启，默认监听 `127.0.0.1:6767`）
- Node 22 或更高

## 安装

```bash
npm install
npm run dev
```

`npm run dev` 会把这个扩展加载进 Raycast，然后在 Raycast 里搜 "Ask Paseo" / "Paseo Sessions"。

## 两条命令

- **Ask Paseo** — 输入问题（留空则用剪贴板，剪贴板也空就用表单填）后新建一个 agent，回答流式显示；`⌘↵` 可追问。
- **Paseo Sessions** — 列出未归档的会话，可打开继续对话、停止、归档，或在 Paseo 桌面端打开。

## 设置

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| Daemon 地址 | daemon 的 `host:port` | `127.0.0.1:6767` |
| Paseo Home | 含 `paseo.pid` 和 `local-credential` 的目录 | 空 = `PASEO_HOME` 或 `~/.paseo` |
| Provider | 新建 agent 用哪个 provider | `claude` |
| Model | 留空则用 daemon 的默认模型 | 空 |
| 默认工作目录 | 新建 agent 的 `cwd` | `D:\work\.paseo` |
| Paseo.exe 路径 | 「在桌面端打开」要用 | 空 = 自动探测 |

改 provider / model：设置里的 Provider 可以直接写 `provider/model` 形式（例如 `claude/deepseek-v4-pro[1m]`），也可以分开填 Provider 和 Model。留空 Model 时由 daemon 挑默认模型。

## 已知限制

- daemon 必须开着。关掉 Paseo 桌面版后两条命令都会提示连不上，不是崩溃。
- 只连本地 daemon：凭据来自 `paseo.pid` 对应的 `local-credential`，不支持远程 / relay。
- 每条命令各开一条 WebSocket 连接，不跨命令复用。
- 回答进行中不能追问（daemon 会打断当前这一轮），要先按「停止」。
- 重连后不重放历史，会提示「连接重连过」，重新打开会话即可看到完整内容。
````

- [ ] **Step 2: 跑全量测试**

Run: `npm test`
Expected: 全部 PASS（credential 10 + client 4 + timeline 9 + agents 8 + desktop 10 = 41 个用例）。

- [ ] **Step 3: 跑最终手验清单**

在 Raycast 里逐条确认：

1. Ask Paseo 输入 `workdir is ?` → 先出现「正在创建 agent…」，随后 `🐾 Paseo` 的内容逐字增长；回答结束后 loading 消失。
2. Ask Paseo 回答进行中 → 动作面板里「追问」变成「正在回答…（先停止才能追问）」；按「停止」后能追问。
3. Ask Paseo 追问一句 `用一句话总结` → 回答接在下面，`>` 引用的是你的问题。
4. Ask Paseo 「在 Paseo 桌面端打开」→ 桌面版窗口到前台并打开同一个 agent。
5. Paseo Sessions 列表 → 未归档会话都在，正在跑的标「正在跑」；回车进去能看到历史。
6. Paseo Sessions 「归档」→ 提示「已归档」，刷新后该会话消失。
7. 关掉 Paseo 桌面版，再跑任意一条命令 → 显示「连不上 Paseo」的中文说明，不是堆栈。

- [ ] **Step 4: 提交**

```bash
git add README.md package.json
git commit -m "docs: document preferences and known limits"
```

- [ ] **Step 5: 提醒用户（不要自动做）**

Nutstore 会同步 `D:\work\...\forProjects\raycast-paseo\node_modules`（几万个文件）。让用户在 Nutstore 的忽略规则里加上
`node_modules`、`.raycast`、`raycast-env.d.ts`，否则同步会很慢。**不要**替用户改 Nutstore 配置。

---

## 附录：本机的关键实测值（写死在代码里的东西都来自这里）

| 项 | 值 |
| --- | --- |
| paseo CLI | `D:\Apps\Paseo\resources\bin\paseo.cmd` |
| Paseo.exe | `D:\Apps\Paseo\Paseo.exe` |
| daemon | `127.0.0.1:6767`，版本 `0.11.1`，随桌面版自启 |
| paseo home | `C:\Users\you\.paseo`（`local-credential` 43 字符） |
| ray CLI | `ray.cmd`（PATH 上，用 `npm run dev` 调用） |
| 本机 Node | v24.9.0（开发用）；Raycast 运行时是 Node 22 |
| 默认工作目录 | `D:\work\.paseo` |

**不要**把这些路径写死进代码——全部走 preference，只有默认值可以填。上表只用于排错。
