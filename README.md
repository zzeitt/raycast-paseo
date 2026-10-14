# Paseo for Raycast

Ask the coding agents running on the hosts your Paseo app knows straight from Raycast, and manage the workspaces and tabs you already have.

## Requirements

- Paseo desktop running (the daemon starts with it and listens on `127.0.0.1:6767` by default)
- Node 22 or newer

The hosts come from Paseo's own host list, so anything you have added there — including a daemon on another machine, reached through the tunnel or relay you set up for it — is offered here without being configured twice.

## Install

```bash
npm install
npm run dev
```

`npm run dev` starts `ray develop`, which loads the extension into Raycast. Then search for "Ask Paseo", "Paseo Workspaces", or one of the "Paseo Quick" slots.

It also does one necessary thing. The build output of `ray develop` carries a full inline sourcemap (hard-coded to `inline` in `@raycast/api`, with no switch), which turns a 9 MB bundle into 35 MB and blows the 100 MB heap Raycast gives each command, reporting "Command Out of Memory". Once the output settles, the script splits the inline map into a `.map` sidecar of the same name (debug line info is not lost), then **moves** the `.js` / `.js.map` into the directory Raycast actually reads and deletes the originals — so only one copy exists on disk. The CLI writes to `~/.config/raycast-x/extensions/paseo` (on win32 it appends the flavour to the directory name; only an empty flavour gives the suffix-free `raycast`), while the app reads `~/.config/raycast/extensions/paseo`.

The order matters: split first, move second. Let the output land in the app's directory instead and the app parses that 35 MB file the moment the build finishes, reporting `Command terminated after reaching the extension memory limit`. After the move the CLI's directory holds only `package.json` and `assets`; those two are copied across rather than moved, refreshed whenever they differ from what the app already has — otherwise a changed icon or manifest would never reach Raycast, and the app would go on reading the first copy ever made. To run plain `ray develop`, use `npm run dev:ray` — that one will OOM.

## The commands

- **Ask Paseo** — three arguments, filled in the Raycast search bar: the question, the host, and the workspace. Fill in a question, leave the host empty for this machine and the workspace empty for the one you last asked in there, press Enter, and the answer streams back. `⌘M` sends a follow-up. Press Enter with the question empty instead and the command opens a form: that is where you choose the host and workspace from a list, and where a name that matches nothing — or a host nothing has been asked on yet — sends you rather than guessing. Names are matched leniently: part of a host label, a workspace title, the last segment of its directory, or the whole directory path all count, and an ambiguous one is refused rather than resolved.
Four more commands, **Paseo Quick 1** to **Paseo Quick 4**, send the prompts you keep in the matching slot; see [Quick commands](#quick-commands).

- **Paseo Workspaces** — lists the tabs you have, grouped under the workspace that holds them. Open a tab to continue the conversation, stop it, archive it, or open it in the Paseo desktop app; `⌘]` drills into one workspace on its own, so the search bar searches inside it rather than across everything. The leading circle and the status tag are coloured by status, so a running tab stands out from an idle one. One dropdown answers two independent questions — which host, and whether archived tabs count — and since the collapsed label can only show the one you touched last, the list title spells out both (`work-laptop · Active`). A group's header names its host whenever more than one host is on screen. A host that cannot be reached gets a section saying so instead of disappearing, and costs you none of the others.

A section is titled only when it actually groups something — most workspaces hold a single tab, and a heading over one row just repeats it. Tabs whose workspace was archived out from under them still appear, collected under "Other".

In a conversation, thinking is collapsed to one line by default; `⌥T` expands the full text and the tool calls in place, so the final answer keeps the stage. Collapsing works by re-rendering a different markdown — Raycast's Detail only understands CommonMark and would print `<details>` as literal text.

When the agent stops to ask you something:

- **Permission prompts** (a tool call, a plan) arrive with their own buttons, which lead the action panel. One click sends the answer back.
- **Questions** are answered on a form: a single-select question is a dropdown, a multi-select one is a tag picker, and the tool's own "Other" affordance is a text field. One submit answers the whole batch — a request can carry up to four questions. When a request holds exactly one single-select question, each option also appears as its own action with `⌘1`–`⌘9`, so the common case never leaves the conversation view.

Answers go back through the permission response's `updatedInput`, keyed by each question's own text, with several picks joined by a comma.

## Quick commands

A quick command is a prompt you send often, with one place in it for what changes — `Summarize {{{link}}}`, plus the link.

Raycast only runs the commands an extension was packaged with, so there are four fixed slots: **Paseo Quick 1** through **Paseo Quick 4**. Each is configured in Settings with a name and a prompt, and each is a command in its own right, so it can carry an alias and a hotkey like any other. A slot that has not been configured says so when it is run; disable it in Raycast rather than leaving it in the list.

Running one takes its argument the way Ask takes its question — in the search bar: `Paseo Quick 1`, Tab, paste the link, Enter. Nothing else stands in the way, because the host and workspace are already settled; a form appears only when they are not, and then it carries the argument, the host and the workspace together. A slot whose prompt has no placeholder needs no argument at all, which makes a hotkey on it a single keystroke.

The argument field in the search bar is labelled only "Argument": a manifest is fixed when the extension is packaged, so its placeholder cannot be the prompt's own word the way the form's field label is.

The name works in Ask as well — `/summarize https://…` in the question argument expands the `summarize` prompt with that link, which is how to use one when you also want to name the host and workspace. A question that merely starts with a slash is left alone unless the name is one of your slots.

`{{{…}}}` in the prompt is where the argument goes, and every placeholder takes it; its wording becomes the label on the field, so `Summarize {{{link}}}` asks you for a *link*. A prompt written without a placeholder gets the argument appended, since dropping what you typed without saying so is worse. The braces are tripled so that a prompt can still carry braces of its own — JSON, a diff, a template.

## Settings

| Setting | What it is | Default |
| --- | --- | --- |
| Paseo Home | directory holding `server-id`, `paseo.pid` and `local-credential` | empty = `PASEO_HOME` or `~/.paseo` |
| Provider | which provider new agents use | `claude` |
| Model | leave empty for the daemon's default model | empty |
| Mode | session mode for new agents: `auto`, `plan`, `acceptEdits`, `default`, `bypassPermissions` | `auto` |
| Default Host | host label or server id to start on — shared by every command | empty = this machine |
| Default Workspace | the folder Ask starts in, chosen with the folder picker | empty = the one last used on that host |
| Default Working Directory | the `cwd` for Ask when no workspace is settled, on this machine | empty |
| Quick Workspace | the folder the Quick commands start in — their own setting, not Ask's | empty = the one last used on that host |
| Quick Working Directory | the `cwd` for Quick commands when no workspace is settled, on this machine | empty |
| Paseo.exe Path | used by Open in Paseo Desktop | empty = auto-detected |

There is no address to configure. Paseo's own host list is read from the desktop app's Local Storage — the same list the app's host switcher shows, with the labels and colours you gave it — and the host running on this machine is told apart from a tunnel to another one by the `server-id` in the Paseo Home.

Where a command starts, in order: the argument it was given, then that command's own settings above, then the workspace last used on that host, then — on this machine only, since the setting is a path — that command's working directory. A workspace this host does not have is passed over rather than being an error, and a Default Host that cannot be reached falls through to this machine, so a command is always possible even when a setting has gone stale.

Ask and the Quick commands each keep their own workspace and working directory, because the two are used for different work and a single pair meant one kept undoing the other's choice. Neither falls back to the other's: a Quick slot left with nothing configured stays that way even when Ask has a default. The host is the one target they share — which machine to start on is the same question whichever command asks it. So is the memory of where you last asked on a host: it is kept once per host, so a Quick send moves where Ask lands next time, and the other way round.

A workspace is named one way: by picking its folder. The value is a path, and each host resolves it against the workspaces it actually has — by the whole path, by the directory's own name, or by title — so a path this host does not have is passed over with a note rather than being an error.

That picker browses the machine Raycast runs on, which is the one real limit of these two settings: **on another host there is no way to set a default workspace at all**, because the path being picked is a path on this machine. Those hosts come out at the shared memory — the workspace last used there — and failing that at the in-command list. A workspace on a remote host can still be named for a single invocation by the `workspace` argument on Ask, and the Quick commands' slots take their argument there too.

Changing provider / model: the daemon's provider argument is already a "provider/model pair", so the Provider field accepts `provider/model` directly (e.g. `claude/deepseek-v4-pro[1m]`), or a bare provider such as `claude` with the model filled in separately under Model. If both are set, Provider wins and Model is ignored. An empty Model lets the daemon pick its own default.

Mode is the session mode the agent starts in — the same ids Paseo's own mode picker shows (`auto` is the one that has a model classifier review permission prompts). They belong to the provider rather than to this extension, so they are passed through as typed: a wrong id comes back as the daemon's error instead of being quietly replaced by a mode you did not ask for. An empty Mode leaves the choice to the daemon.

"Paseo.exe Path" is empty by default, and the extension then looks in `%LOCALAPPDATA%\Programs\Paseo\Paseo.exe`. Set it when Paseo is installed somewhere else; when neither is found, Open in Paseo Desktop says so rather than failing silently.

## Known limitations

- The daemon must be running. With Paseo desktop closed, both commands report that they cannot connect — that is not a crash. A host on another machine also needs whatever connects to it — the tunnel, say — to be up; that part is Paseo's, not this extension's.
- Only a host's direct TCP address is used. Paseo may also list a relay or a socket for the same host, and the extension lists that host as unreachable rather than pretending otherwise; the relay would need the SDK's encrypted transport, which is not wired up here.
- The host list is read from the desktop app's Local Storage, which is a leveldb the extension opens read-only and unpicks itself. If a Paseo update changes that layout, the command says which directory failed to give up its host list rather than showing an empty one.
- Each command opens its own WebSocket; connections are not shared between commands.
- You cannot send a follow-up while the agent is answering — the daemon would interrupt the current turn. Stop it first.
- History is not replayed after a reconnect. The view says the connection reconnected, and reopening the agent shows everything; whether the agent is currently running is asked of the daemon again, so the spinner does not get stuck.
- A pending question or permission request can only be answered while the view is open and the request arrives live. History does not contain pending requests, and the SDK has no "fetch pending permissions again" call, so closing and reopening the view loses it — answer it in the Paseo desktop app instead.
- Agents started from Raycast carry a `source=raycast` label, so you can tell where they came from inside Paseo.
