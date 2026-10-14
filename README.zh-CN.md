# Paseo for Raycast

从 Raycast 直接问你 Paseo 里那些 host 上跑着的 coding agent，并管理已有的 workspace 和 tab。

[English](README.md)

## 前提

- Paseo 桌面版在运行（daemon 随它自启，默认监听 `127.0.0.1:6767`）
- Node 22 或更高

host 列表直接取自 Paseo 自己的那份，所以你在它里面加过的东西——包括另一台机器上的 daemon，只要配了隧道或 relay 能连上——这里都会出现，不用再配一遍。

## 安装

```bash
npm install
npm run dev
```

`npm run dev` 会起 `ray develop` 把这个扩展加载进 Raycast。然后在 Raycast 里搜 "Ask Paseo"、"Paseo Workspaces"，或者某个 "Paseo Quick" 槽位。

它同时干一件必要的事。`ray develop` 写出的产物尾部挂着一整份内联 sourcemap（`@raycast/api` 里按环境写死 `inline`，没有开关），单条命令的包会从 9MB 涨到 35MB，解析时就顶满 Raycast 给每条命令的 100MB 堆，报「Command Out of Memory」。脚本等产物稳定后把内联 map 拆成同名 `.map` sidecar（行号调试信息不丢），再把 `.js` / `.js.map` **搬到** Raycast 真正读取的目录，原件删掉——磁盘上只留一份产物。CLI 自己写在 `~/.config/raycast-x/extensions/paseo`（win32 上它把 flavor 拼进目录名，空 flavor 才对应没有后缀的 `raycast`），app 读的是 `~/.config/raycast/extensions/paseo`。

「先拆再搬」的顺序不能反：直接让产物落在 app 的目录里，app 会在构建完成那一刻就去解析那个 35MB 的文件，报 `Command terminated after reaching the extension memory limit`。搬走之后 CLI 那边的目录里只剩 `package.json` 和 `assets`，这两样不搬、只复制，一旦和 app 那边的不一样就刷新一份——否则换了图标、改了命令清单，Raycast 那边永远还是第一次拷过去的那份。想只跑原版 `ray develop` 用 `npm run dev:ray`（那样会 OOM）。

## 命令

- **Ask Paseo** —— 三个参数，都在 Raycast 搜索栏里填：问题、host、workspace。问题填上，host 留空表示本机，workspace 留空表示上次在那里问过的那个，回车，回答就流式回来。`⌘M` 追问。反过来，问题留空直接回车，命令会打开一个表单：那才是从列表里选 host 和 workspace 的地方，也是「名字匹配不上」或「这个 host 还没问过」时把你送过去的地方——而不是替你猜一个。名字是宽松匹配的：host 标签的一部分、workspace 的标题、它目录的最后一段、或者整条目录路径都算，歧义时拒绝解析而不是随便挑一个。
  另外四条命令 **Paseo Quick 1** 到 **Paseo Quick 4** 发送你在对应槽位里存的提示词，见[快捷命令](#快捷命令)。

- **Paseo Workspaces** —— 列出你手上的 tab，按所属 workspace 分组。打开可继续对话、停止、归档，或在 Paseo 桌面端打开；`⌘]` 下钻到单个 workspace，让搜索框只搜它里面的 tab 而不是所有。开头的圆环和状态标签按状态着色，跑着的一眼能认出来。一个下拉同时回答两个互不相干的问题——哪台 host，以及是否算上已归档的——而折叠起来的标签只能显示你最后动过的那个，所以列表标题把两个都写出来（`work-laptop · 活跃`）。屏幕上不止一台 host 时，分组标题会带上它的 host。连不上的 host 会得到一个说明自己连不上的分区，而不是凭空消失，也不影响其他 host。

分组标题只在该组真的装了多个 tab 时才显示 —— 多数 workspace 只有一个 tab，一行的上面再压个标题等于重复。workspace 已被归档、tab 却还留着的那些不会丢，归到 "Other" 一组。

回答页里：思考默认折成一行，按 `⌥T` 原地展开全文和工具调用，让最终答复当主角。折叠是换一份 markdown 重渲染实现的 —— Raycast 的 Detail 只认 CommonMark，`<details>` 会原样显示成文字。

agent 停下来问你的时候，分两种：

- **权限请求**（要执行某个工具、要确认计划）自带按钮，排在动作面板最前面，点一下就把回答回传。
- **提问**走表单：多选一是下拉框，多选多是标签选择器，工具自带的「其他」是一个输入框。一次提交把整批问题一起答完，一个请求最多带四个问题。只有一个多选一问题的请求，每个选项还会单独摊成一个动作，配 `⌘1`–`⌘9` 快捷键，常见情况不用离开会话页。

答案通过权限响应的 `updatedInput` 回传，键是问题原文，多选的值用逗号拼起来。

## 快捷命令

快捷命令就是一条你经常发的提示词，里面留一个位置给会变的东西——`总结一下 {{{链接}}}`，加上那个链接。

Raycast 只能运行打包时就带上的命令，所以槽位是固定的四个：**Paseo Quick 1** 到 **Paseo Quick 4**。每个在设置里配一个名字和一条提示词，每个本身就是一条命令，因此能像别的命令一样带别名和快捷键。没配过的槽位在运行时说明自己没配；用不上就在 Raycast 里禁掉它，别留在列表里。

运行时的参数像 Ask 的问题一样在搜索栏里填：`Paseo Quick 1` → Tab → 粘贴链接 → 回车。中间没有别的东西挡路，因为 host 和 workspace 早就定好了；只有定不下来时才出现表单，那时它会把参数、host、workspace 放在一起问。提示词里没有占位符的槽位根本不需要参数，于是给它挂个快捷键就是一键的事。

搜索栏里那个参数框只能叫 "Argument"：清单在扩展打包时就固定了，所以它的 placeholder 没法像表单里的字段标签那样用提示词自己的词。

名字在 Ask 里也认——问题参数里写 `/summarize https://…` 会把 `summarize` 那条提示词和这个链接展开，这是「既想用快捷命令、又想指定 host 和 workspace」时的用法。只以斜杠开头、名字却不是某个槽位的，原样当作问题。

提示词里的 `{{{…}}}` 是参数放进去的位置，每个占位符都会收到它；占位符的措辞会变成表单字段的标签，所以 `总结一下 {{{链接}}}` 问你要的是一个*链接*。没写占位符的提示词会把参数附在末尾——悄悄丢掉你输入的东西比这更糟。花括号写成三层，是为了让提示词自己还能带花括号——JSON、diff、模板。

## 设置

| 设置 | 说明 | 默认 |
| --- | --- | --- |
| Paseo Home | 含 `server-id`、`paseo.pid` 和 `local-credential` 的目录 | 空 = `PASEO_HOME` 或 `~/.paseo` |
| Provider | 新建 agent 用哪个 provider | `claude` |
| Model | 留空则用 daemon 的默认模型 | 空 |
| Mode | 新建 agent 的会话模式：`auto`、`plan`、`acceptEdits`、`default`、`bypassPermissions` | `auto` |
| Default Host | 要启动在哪台 host：标签或 server id——所有命令共用 | 空 = 本机 |
| Default Workspace | Ask 启动的文件夹，用文件夹选择器挑 | 空 = 该 host 上次用过的那个 |
| Default Working Directory | Ask 在没有匹配到 workspace 时的 `cwd`，仅本机 | 空 |
| Quick Workspace | Quick 命令启动的文件夹——它们自己的一套，不跟 Ask 共用 | 空 = 该 host 上次用过的那个 |
| Quick Working Directory | Quick 命令在没有匹配到 workspace 时的 `cwd`，仅本机 | 空 |
| Paseo.exe Path | 「在桌面端打开」要用 | 空 = 自动探测 |

没有地址需要配置。host 列表是从桌面端的 Local Storage 里读的——就是 app 自己那个 host 切换器显示的那份，带你起过的标签和颜色——本机跑着的那个 host 与通往另一台机器的隧道，靠 Paseo Home 里的 `server-id` 区分。

一条命令落在哪里，按顺序：它拿到的参数 → 上面那条命令自己那套设置 → 该 host 上次用过的 workspace → （仅本机，因为这个设置是路径）该命令的工作目录。该 host 没有的 workspace 会被跳过而不是当成错误；连不上的 Default Host 会落到本机——所以某个设置过期了，命令照样能用。

Ask 和 Quick 各自保留一套 workspace / cwd 设置，因为两者干的是不同的活，共用一套等于互相把对方的设定改掉。两者**互不回落**：某个 Quick 槽位没配就是没配，即使 Ask 有默认值也一样。它们共用的只有 host（启动在哪台机器上，谁问都是同一个问题），以及「该 host 上次用在哪里」这条记忆——它按 host 只存一份，所以 Quick 发一次会改变 Ask 下次落在哪，反之亦然。

workspace 只用一个字段指定：挑文件夹。值是一条路径，交给该 host 拿它自己有的 workspace 去解析（整条路径 / 目录名 / 标题都能对上），对不上就跳过并给一条提示，不当作错误。

选择器浏览的是 **Raycast 所在那台机器**，这是这两个设置唯一的硬限制：**在别的 host 上没有办法设默认 workspace**，因为你挑的是本机路径。那些 host 会退到共享记忆（该 host 上次用过的那个），再没有就退到命令内的列表。单次调用仍可用 Ask 的 `workspace` 参数指名远程 host 上的 workspace，Quick 的参数也是填在那里。

改 provider / model：daemon 的 provider 参数本来就是「provider/model 对」，所以 Provider 这一格可以直接写 `provider/model` 形式（例如 `claude/deepseek-v4-pro[1m]`），也可以只写 provider（如 `claude`）把模型单独填在 Model 里。两格都写了的话以 Provider 为准，Model 被忽略。留空 Model 时由 daemon 挑默认模型。

Mode 是 agent 启动时的会话模式——就是 Paseo 自己的模式选择器里那些 id（`auto` 是那个会让模型分类器复核权限请求的）。这些 id 属于 provider 而不是这个扩展，所以原样传过去：写错了会以 daemon 的报错回来，而不是被悄悄换成一个你没要的模式。留空 Mode 则由 daemon 决定。

「Paseo.exe Path」默认为空，此时会去找 `%LOCALAPPDATA%\Programs\Paseo\Paseo.exe`。Paseo 装在别处时改这一格；都找不到时「在桌面端打开」会弹一条说明，不会静默失败。

## 已知限制

- daemon 必须开着。关掉 Paseo 桌面版后命令会提示连不上，不是崩溃。另一台机器上的 host 还需要连到它的那条链路（比如隧道）是通的——那部分归 Paseo 管，不归这个扩展。
- 只用一个 host 的 direct TCP 地址。Paseo 可能还为同一个 host 列着 relay 或 socket，扩展会把该 host 标成不可达而不是假装能连——relay 需要 SDK 的加密传输，这里没接。
- host 列表是从桌面端 Local Storage 里读的，那是个 leveldb，扩展只读地打开并自己解析。Paseo 更新改了那套布局的话，命令会说出是哪个目录没能交出 host 列表，而不是显示一个空列表。
- 每条命令各开一条 WebSocket 连接，不跨命令复用。
- 回答进行中不能追问（daemon 会打断当前这一轮），要先按「停止」。
- 重连后不重放历史，会提示「连接重连过」，重新打开该 agent 即可看到完整内容。重连时当前是否「正在跑」会重新向 daemon 问一次，不会卡在转圈上。
- 挂起的提问 / 权限请求只在视图开着、请求当场到达时才能应答：历史里不含挂起的请求，SDK 也没有「重新拉一次待处理权限」的接口，所以关掉再打开就看不到它了（要回答就回 Paseo 桌面端）。
- 从 Raycast 起的 agent 带 `source=raycast` 标记，方便在 Paseo 里区分来源。
