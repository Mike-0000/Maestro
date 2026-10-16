# Grounding the voice agent's prompts in the project

How should the Maestro voice agent (the conductor) look things up in a project before it writes a
prompt for another agent, so that project jargon and complicated requests turn into the right
brief?

Written 2026-10-16 as research. The four recommendations were then built the same day; see
[Implementation status](#implementation-status) for what exists and what is still unverified. Paths that start with `conductor/` are
under `apps/emdash-desktop/src/core/features/`. This note builds on
[the sub-agent feasibility study](../conductor-subagent-feasibility.md) and
[the code-check plan](../conductor-subagent-plan.md), and does not repeat their measurements.

## Recommendation in short

**Do not build something new. Finish, retarget, and extend the code-check scout that is already
in the tree.** It is option 1 (a Claude Code CLI sub-process), built with the containment the two
earlier studies worked out, and it is one switch away from being usable.

1. **Ship the scout for prompt writing.** Turn on `CODE_CHECKS_UI`, and point the tool description
   and system prompt at unfamiliar project terms and complicated briefs, not only at plans.
2. **Add one fast, native lookup tool** (`find_in_project`) on top of Maestro's existing
   host-portable file search. It answers "where does this word appear?" in under a second, on
   every kind of project, Windows, WSL and SSH included, with no model and no CLI.
3. **Make WSL projects work with the scout.** Today they are refused, and the developer's own
   Maestro checkout is a WSL project.
4. **Keep bypass permissions out of the voice path.** Wider access is an explicit list of extra
   folders, still read-only. Whole-drive exploration with full permissions is a normal, visible
   agent the developer starts and watches.

The default scope: **off until the developer turns it on; when on, the project's folder (or the
named agent's worktree) only, read-only, secret files denied, no shell, no web.** Extra folders
are opt-in, one named folder at a time.

## 1. What exists today

### How a prompt gets written

A request reaches the conductor in one of three ways (`handleUtterance`,
`conductor/browser/conductor-store.ts`):

| Route | Who writes the prompt | Can it look anything up? |
| --- | --- | --- |
| Grammar (`conductor/api/grammar.ts`) | No prompt; fixed commands | No |
| Jev router (`conductor/api/jev-router/`) | With `jevVerbatimRouting` on (the default), the developer's own words go to the agent unchanged (`send_verbatim`, `spawn_with_brief`) | No, and it does not need to: the receiving agent reads the words itself |
| The model (text model, or the realtime voice line when it is on) | The model writes the `spawn_agent` / `send_to_agent` prompt, or a plan's subtasks | Only through `investigate`, which is hidden (below) |

For long requests (50 words or more), Maestro also appends the verbatim transcript to the prompt
(`withVerbatimRequest`, `conductor/api/prompt-fidelity.ts`). The system prompt tells the model to
organize a dictated brief without condensing it (`conductor/api/system-prompt.ts:22`).

So the receiving agent always gets either the developer's words or the model's version plus the
words. The jargon problem is therefore not that the coding agent cannot find out what a term
means; it can. It is that **the conductor makes decisions from the words before the agent sees
them**:

- which project and which agent the request goes to;
- whether it is one agent or a plan, and how a plan is split (`owned_paths`);
- how the brief is organized, which terms it treats as the subject, and what it calls the task;
- whether to ask the developer a question first.

A misread term ("the desk", "Jev", "the mirror", "Chorus") makes each of those wrong in a way the
verbatim attachment cannot fix. That is the gap this note is about.

### The scout is already built

The `investigate` tool from the code-check plan is implemented and merged:

| Part | Where |
| --- | --- |
| Tool schema and description (1 to 3 questions, a project or an agent's worktree) | `conductor/api/tools.ts:275`, `:370` |
| Claude Code arguments, prompt, answer schema, start-event preflight | `conductor/node/investigation/claude-scout.ts` |
| Process runner with forced tree kill and watchdog | `conductor/node/investigation/scout-runner.ts` |
| Secret-file deny list | `conductor/node/investigation/scout-deny.ts` |
| Narrowed child environment | `conductor/node/investigation/scout-env.ts` |
| Quote check against the file | `conductor/node/investigation/evidence.ts` |
| Self-test per CLI version (hooks off, outside reads denied, `.env` denied) | `conductor/node/investigation/containment-self-test.ts` |
| Service: limits, queue, local-only, usage | `conductor/node/investigation/investigation-service.ts` |
| Wire live job `investigate` | `conductor/api/contract.ts:472` |
| Tool call, two checks per turn, cancel, interim "Checking the code" | `investigateTool`, `conductor-store.ts:1670` |
| Fenced tool result | `conductor/api/investigation-format.ts` |
| Tainted-turn rule: after a check, actions need an explicit yes | `conductor/api/tainted-turn.ts` |
| Realtime voice line can call it before the transcript lands | `LINE_INSTANT_TOOLS`, `conductor/api/voice-line.ts:18` |
| Settings group | `CodeCheckSettings`, `conductor/browser/settings/chorus-settings-page.tsx:892` |

Two switches keep it off: the setting `investigations` defaults to `false`, and the build-time
constant `CODE_CHECKS_UI` is `false` (`conductor/api/contract.ts:132`), so the settings group is
not rendered and the feature cannot be turned on from the app.

### What the scout cannot do today

| Gap | Detail |
| --- | --- |
| **Hidden** | `CODE_CHECKS_UI` is `false`. The step-7 gates in the plan (containment on Windows, scout quality, conductor behaviour, voice runs) were the condition for flipping it |
| **Aimed at plans, not words** | The description says to use it "before propose_plan or spawn_agent when the plan depends on a fact about the code". Nothing tells the model that an unfamiliar term is a reason to check |
| **Local projects only** | `investigation-service.ts:195` refuses any host that is not `local`. WSL distros are machines, like SSH hosts, so a `<name> (WSL)` project is refused (`docs/chorus/wsl.md`, Limits). This checkout is one |
| **Jev skips the model** | A confident Jev decision acts without the model, so no check can happen. That is fine for verbatim sends, but a brief that Jev sends verbatim to the wrong project is not caught |
| **One check costs a confirmation** | After a check, `spawn_agent` and `send_to_agent` (`DIRECT_TOOLS`, `conductor/api/tools.ts:414`) need a spoken yes. Correct for safety, but every grounded prompt now asks twice |

## 2. The options

### Option 1: a Claude Code CLI sub-process

**How it works in Maestro.** The main process starts `claude -p` in the project folder with closed
standard input, a fixed argument list, a narrowed environment, a time limit and a spend cap. The
question goes in on standard input. The structured answer (`answer`, `found`, `evidence[]`) comes
back as a Wire live job result, each quote is looked up in its file, and the conductor receives a
fenced block that says it is data. This is exactly the scout above.

**Latency and cost per voice turn.** Measured in the earlier studies: Haiku 9 to 13 s at $0.003
to $0.005 a question, Sonnet 6 to 14 s at $0.04 to $0.07; three questions in parallel took 15 s.
A probe for this note (Claude Code 2.1.302 in WSL, Haiku, a trivial read) took 4.3 s for $0.001.
A turn that checks once and then spawns an agent adds roughly 10 to 20 s, plus the confirmation.
The scout's tokens are not the conductor's: a scout may read 100,000 tokens of code and the voice
model receives a few hundred characters.

**Reliability.** Good for "where is X / does X exist / what does X mean here", which is the
jargon case. The model behind it is capable at search and reading. Weak points: flag drift
between CLI versions (covered by the per-run preflight and the per-version self-test), sign-in
state (a signed-out CLI reports `not-signed-in` and the feature marks itself unavailable), and
confident wrong answers (covered partly by the quote check).

**Security, with the restricted mode.** `--restricted` removes Bash and every code-running tool,
ignores user and project settings (so a project's hooks and `CLAUDE.md` cannot steer it), refuses
`bypassPermissions`, and confines file tools to the working folder plus any `--add-dir`. The probe
for this note confirmed the last point: with `--add-dir extra`, files in the project and in
`extra` were read and a file in a third folder was denied (`permission_denials` listed it).

**Security with bypass permissions reaching whole drives.** This is the developer's preferred
idea, and it is the one part of option 1 this note recommends against for the voice path:

| Risk | Why it matters here |
| --- | --- |
| **It turns reading into running** | Bypass mode comes with Bash. A scout reads untrusted text: repository files, dependency sources, downloaded files, logs. Any of it can say "run this". With bypass there is no prompt between that text and a command running as the developer |
| **Whole drives hold the developer's secrets** | `~/.ssh`, `~/.aws`, browser profiles, password-manager exports, every project's `.env`, `%APPDATA%` tokens, the distro's `~/.claude` credentials. The deny list covers known names inside a project; it cannot cover a whole disk |
| **Everything read leaves the machine** | Whatever the scout reads is sent to Anthropic as context. A whole-drive search can send files from unrelated projects and personal folders |
| **The containment proofs stop applying** | `--restricted` refuses bypass, so bypass means dropping `--restricted`, which also brings back the project's hooks and `CLAUDE.md`. The self-test and preflight were built to prove the opposite |
| **The safety net is on the wrong side** | The tainted-turn rule makes the conductor ask before acting after a check. It does nothing about what the scout itself does during the check |
| **It is slow on the drives that matter** | Searching `C:\` from Windows, or `/mnt/c` from WSL, takes minutes, not seconds. That does not fit a voice turn |
| **Nobody is watching** | A scout is headless and finishes in seconds. A full-permission agent should be one the developer can see and stop |

The developer's underlying want, an agent that can look anywhere on the computer, is real and
already served by the normal path: "start a Claude Code agent and have it find out where my old
deploy scripts are" spawns a visible tile, under the permission mode the developer chose for
Claude Code agents (`autoApprove`, or bypass if they set it), in a terminal they can watch and
interrupt. Its answer comes back through the completion report. That is the right home for
full-permission exploration; the voice turn's inline lookup is not.

**Cross-platform.** Claude Code runs on Windows, macOS, Linux and inside WSL. The runner already
handles Windows `.cmd` shims (forced tree kill) and hides console windows. For WSL projects the
CLI must run inside the distro, under the distro's own sign-in (see section 4).

**How results come back.** Final answer only, never the transcript; capped, redacted, quotes
checked; fenced as data; and the turn is marked tainted so actions that follow need a yes.

### Option 2: native lookup tools built into Maestro

**How it works in Maestro.** New conductor tools (for example `find_in_project`, `read_file`,
`list_folder`) run in the main process and return results straight into the conductor model's
context. The model does the exploring itself, one round trip per step.

**The cross-platform part is mostly already solved.** The fear in the original request ("that
could get messy, especially on different platforms") is less true than it looks, because Maestro
already has host-portable runtimes that the editor and search UI use:

| Need | Existing runtime | Hosts |
| --- | --- | --- |
| Find files by name | `fileSearch.searchPaths` (`packages/core/src/runtimes/file-search/api/contract.ts`) | Local, SSH, WSL (through the workspace server) |
| Search file contents | `fileSearch.searchContent`, a live job backed by ripgrep (`file-search/node/content/ripgrep`) | Same |
| Read a file | `files.readText` (`packages/core/src/runtimes/files/api/contract.ts`) | Same |
| List a folder | `files.enumerate` | Same |
| Stay inside a root | `apps/emdash-desktop/src/main/core/files/realpath-containment.ts` | Local |
| Path translation, Windows and WSL | `nativePathFromHost`, `resolveRelativePath` (`@core/primitives/desktop-runtime/api`), used by `src/main/core/file-search/runtime-client.ts` | All |

Using these, a native tool gets Windows drive letters, WSL `/home/...` paths, SSH hosts, search
exclusions and ripgrep for free, and it is read-only because only read procedures are called.

**Latency and cost.** Each call takes milliseconds (a ripgrep search of this repository is well
under a second). The cost is in the model: every result lands in the conductor's own context, at
the conductor's prices (Opus by default, or the realtime voice model), and each exploration step
is a full model round trip. On the realtime line, each round trip is also spoken-turn latency.
The text loop allows 8 round trips per utterance (`MAX_TOOL_ITERATIONS`, `conductor-store.ts:339`),
so a three-step exploration uses almost half of them before the conductor does anything.

**Reliability.** Exact for facts ("this word appears in these 6 files"), weak for judgement
("what does the developer mean by the desk"). A voice model reading raw code is worse at that than
a coding agent built for it, and the realtime models are tuned for speech, not code reading.

**Security.** Strong containment, because Maestro writes the tools: one root, read-only, deny
list (`SCOUT_DENY` can be reused), size caps. The exposure that remains: file contents enter the
voice model's context, so they go to the conductor's provider (Anthropic, OpenRouter, or the
realtime provider) instead of only to Anthropic through Claude Code. Repository text in the
conductor's own context is also a prompt-injection path, which the tainted-turn rule would need to
cover exactly as it covers scout answers.

**How results come back.** Directly, as tool results, sized by Maestro. No second model.

### Option 3: hybrids and others

| Option | What it is | Verdict |
| --- | --- | --- |
| **Facts tool plus scout** (recommended) | A fast native `find_in_project` for "where does this term live", and the scout for "what does it mean / how does it work" | Each does what it is best at; the conductor picks by the question |
| **Lean on the receiving agent** | Already true: the brief carries the verbatim words. Add one line to the brief: "terms you do not recognise are this project's own; find them in the code first" | Free and worth doing anyway, but it does not fix the conductor's own routing and splitting decisions |
| **A project glossary in context** | Give the conductor a short term list per project: names from the project's `AGENTS.md`/`CLAUDE.md` headings, top-level folder and package names, and the developer's own definitions saved through standing instructions ("when I say the desk I mean Canvas Pro desks") | Cheap, instant, no lookup at all for terms it knows. Must be small (it is in every turn's prefix) and is only as good as its source |
| **Headless ACP session** | Run the scout as a chat session through the ACP runtime instead of `claude -p` | The earlier study's stage 2: needed for long or visible investigations and remote hosts. More plumbing, no better for a 10-second lookup |
| **Claude Agent SDK in process** | The same agent loop as a library | Adds a dependency for what `claude -p` already gives; no gain |
| **Our own agent loop on a small model** | The native tools from option 2, driven by Haiku instead of the conductor model | Keeps the conductor's context small and works on every host, but rebuilds an agent harness. Worth it only if the CLI path proves unreliable |
| **Ask the developer** | When a term is unknown and no lookup helps, ask "by the desk, do you mean Canvas Pro desks?" | Always the fallback; the model already may ask |

## 3. Side by side

| | 1a. Scout, restricted (built) | 1b. Scout, bypass, whole drives | 2. Native tools | 3. Facts tool + scout (recommended) |
| --- | --- | --- | --- | --- |
| Added wait per voice turn | 10 to 20 s | 10 s to minutes | Under 1 s per call, plus a model round trip each | Under 1 s for a term; 10 to 20 s when meaning is needed |
| Money per lookup | $0.001 to $0.005 (Haiku) | Unbounded without a cap | Conductor tokens for every result | Facts free; scout as 1a |
| Understands meaning | Yes | Yes | Weakly | Yes, when it calls the scout |
| Can run commands | No | Yes | No | No |
| Reads outside the project | Only named extra folders (`--add-dir`) | Everything the user can read | Only what we allow | Only named extra folders |
| Repo hooks and `CLAUDE.md` | Ignored | Run and obeyed | Not applicable | Ignored |
| Where file contents go | Anthropic, via Claude Code | Anthropic, via Claude Code | The conductor's provider | Facts: nowhere but file names; scout: Anthropic |
| Windows | Works (shim kill tested) | Works | Works | Works |
| WSL projects | Refused today; fixable | Same | Works today | Facts work today; scout fixable |
| SSH projects | No | No | Works today | Facts work; scout no |
| Needs a CLI sign-in | Yes | Yes | No | Only for the scout |
| Built | Yes, hidden | No | No, but its runtimes exist | Half |

## 4. The recommended design

### The three tiers

1. **Know it.** A small per-project glossary in the conductor's context, built from what the
   project already documents plus terms the developer defined. No lookup, no wait.
2. **Find it** (new, native). `find_in_project { terms[1..5], project? | agent? }` returns, per
   term, up to 8 matching file paths and folder names and a hit count, from `searchPaths` and
   `searchContent` on the project's host. File names only, never file contents, so nothing from
   inside a file enters the voice model's context and the turn is not tainted. Under a second.
   Answers "is 'mirror' a thing in this project, and where".
3. **Understand it** (the existing scout). `investigate` when the meaning or the shape of the code
   decides the prompt: "what does Jev do, and is the routing change the developer described in
   `jev-router` or in the grammar?" 10 to 20 s, tainted turn.

Beyond the tiers, anything that needs a shell, minutes, or access beyond named folders is a visible
agent, started by the developer.

### When the voice agent looks things up

The model decides, inside hard caps, which matches the request ("at least when it feels like it
might need to"):

- **System prompt line** (one change, rebuilds the cached prefix once): "Before writing a prompt
  for an agent, if the request uses a name or term you cannot place in this project's context,
  call find_in_project with it. If what the term does would change which project, which agent,
  how the work is split, or what the brief says, call investigate. Do neither for requests you
  can route from what you already know."
- **The `investigate` description** gains "or when the developer uses a project term you do not
  recognise and the brief depends on it".
- **The developer can force it**: "check first", "look it up before you write it". A grammar or
  Jev cue for these phrases should route to the model, never to a verbatim send.
- **Caps stay**: two scout calls per turn and the daily limits already exist. `find_in_project`
  gets its own cap (for example four calls per turn), since it is cheap but each call is a round
  trip.

### Making WSL projects work

The developer's checkout is a `Maestro (WSL)` project, so this matters first. Two paths, in order:

1. **Mirrored projects: read the Windows side.** A project created by **Run in WSL** has a live
   mirror of a Windows folder (`WslMirrorService`, `src/core/services/wsl-mirror/`). For a scout on
   a mirrored WSL project, run Claude Code on Windows against the mirror's Windows folder, which
   is a local project the scout already handles. Contents are the same except for ignored files.
   Small change; no new spawn path.
2. **Unmirrored WSL projects: run the scout in the distro.** Start `claude -p` through the same
   `wsl.exe -d <distro> --exec` path the WSL machine uses (`docs/chorus/wsl.md`, How it works),
   with the folder as the distro path. This needs the distro's own Claude Code sign-in, a
   self-test run inside the distro, and the forced-stop rules checked again for `wsl.exe` as the
   parent process. A medium change, in the high-risk spawn area.

`find_in_project` needs neither: the file-search runtime already serves WSL and SSH hosts.

SSH projects keep the earlier plan's answer: the facts tool works; the scout waits for the ACP
path or a remote runner.

### Safe default scope

| Setting | Default | Opt-in |
| --- | --- | --- |
| Lookups at all | Off; a one-time hint offers them (exists) | On, globally |
| Folder | The request's project, or the named agent's worktree | Extra folders, listed one by one in settings and passed as `--add-dir`. A drive root, the home folder, and folders on the deny list are refused at entry |
| Tools | `Read`, `Grep`, `Glob` (scout); path and content search (facts) | None. No shell, no web, no MCP servers for a voice-turn lookup |
| Secret files | Denied (`SCOUT_DENY`) | Not adjustable |
| Model | Haiku | Sonnet, or a model id |
| Time | 45 s per question | 15 to 60 s |
| Spend | $0.25 per question, $2 and 100 questions per day | Adjustable |
| Whole computer, full permissions | Not available as a lookup | A visible Claude Code agent, started and watched by the developer, under the permission mode the developer set for Claude Code |

### How the answer shapes the prompt

- The fenced result stays as it is. The model uses it to choose project, agent and split, and to
  word the brief.
- **The brief may name the files the scout found** ("the routing lives in
  `conductor/api/jev-router/`"), which saves the receiving agent its own search. It must not copy
  scout text as instructions. The brief rules in `system-prompt.ts:22` (no added scope, no added
  restrictions) still apply.
- The verbatim transcript is still attached, so a wrong lookup cannot erase what the developer
  said.
- After a scout check, `spawn_agent` and `send_to_agent` ask for a yes with the full prompt shown
  (tainted-turn rule). After only a facts lookup, they do not, because no file contents were read.

## 5. Latency and cost on a voice turn

Estimates from the measurements above, not measured end to end:

| Request | Today | With the design |
| --- | --- | --- |
| Short command, known terms | Grammar or Jev, about 1 s | Unchanged; no lookup |
| Brief with one unknown term | Model writes a guessed prompt | One `find_in_project` call and one extra round trip: about 1 to 3 s more |
| Complicated brief whose meaning depends on the code | Guessed prompt or plan | One scout call: 10 to 20 s more, then a spoken yes before the agent starts; about $0.005 on Haiku |
| "Look across my whole drive for…" | A visible agent, if asked for | Unchanged: a visible agent |

The interim spoken line "Checking the code." already covers the scout's wait.

## 6. Steps, if the developer goes ahead

Each step is small and can merge alone. None is done.

| Step | Work | Main files |
| --- | --- | --- |
| 1 | Run the plan's step-7 gates and flip `CODE_CHECKS_UI` | `conductor/api/contract.ts` |
| 2 | Retarget: the `investigate` description and one system-prompt line for unfamiliar terms; "check first" routes to the model | `conductor/api/tools.ts`, `conductor/api/system-prompt.ts`, Jev and grammar routing evals |
| 3 | `find_in_project`, appended last to the tool list, file names and counts only, on the project's host, untainted | `conductor/api/tools.ts`, `conductor-store.ts`, a new conductor Wire procedure over the file-search runtime |
| 4 | Scout on mirrored WSL projects via the Windows folder | `conductor/node/investigation/investigation-service.ts`, the WSL mirror service |
| 5 | Extra folders setting, passed as `--add-dir`, validated in main; self-test extended to prove an unlisted folder is still denied | `claude-scout.ts`, `containment-self-test.ts`, settings page |
| 6 | Project glossary in context | `conductor/node/project-context.ts`, `system-prompt.ts` |
| 7 | Scout inside the distro for unmirrored WSL projects | `scout-runner.ts`, WSL exec path; high-risk review |

## Implementation status

Built on 2026-10-16. All four recommendations, behind the existing **Let the conductor read
project files** switch, which still defaults to off.

| Recommendation | What was built | Where |
| --- | --- | --- |
| 1. Ship the scout, aimed at prompts | `CODE_CHECKS_UI` is `true`, so the Code checks group shows in Settings. The `investigate` description now names unfamiliar project terms and briefs for `send_to_agent`, and one system-prompt rule tells the model to look before it writes when the lookup tools are offered. Explicit asks ("check the code first", "look it up before you write the prompt") skip Jev and reach the model (`lookupBypass`) | `conductor/api/contract.ts`, `conductor/api/tools.ts`, `conductor/api/system-prompt.ts`, `conductor/api/jev-router/trace.ts` |
| 2. `find_in_project` | A new live job over the search slice's `searchWorkspaceFiles` and `searchWorkspaceContent`, so it runs on every host. Up to 5 terms; per term, up to 8 paths that contain it and the 8 files that mention it most, with counts. Deny-listed files are never named. File names only, so it does not taint the turn. Four per turn. Sent with `investigate` while the switch is on, on the text model and the voice line | `conductor/node/investigation/project-lookup.ts`, `conductor/browser/conductor-store.ts`, `conductor/api/investigation-format.ts`, `talk/api/voice-prompt.ts` |
| 3. WSL projects | A code check on a WSL project resolves the mirror (`ssh.machines.getWslMirrors()`) whose machine and Linux folder match, and reads the Windows folder instead. Only seeded mirrors count. The result says it read the Windows copy. Projects on other machines are now offered to the tool, and the main process explains why one cannot be read | `investigation-service.ts` (`mirroredWindowsPath`), `src/core/manifests/node/controllers.ts` |
| 4. Extra folders | A new setting, `investigationFolders`, edited with **Add folder…** (a folder picker, then `checkInvestigationFolder` in main). Each folder is checked again before every check: absolute, exists, a real directory, not a drive root, not the home folder or anything holding it, no hidden, `AppData`, `Library` or deny-listed segment, no pattern characters, at most 10. Folders go to Claude Code through the settings file (`permissions.additionalDirectories`) and the prompt, never the command line, and every deny rule is repeated anchored at each folder's absolute path. Quotes from extra folders are verified like project quotes | `scout-folders.ts`, `scout-deny.ts`, `scout-runner.ts`, `evidence.ts`, `claude-scout.ts`, the settings page |

The self-test gained a fourth check: the fixture now has an extra folder with a secret file that
must be refused. `SCOUT_PROFILE` changed with it, so every installed CLI version runs the
self-test again before its next check.

### What was found while building it

- **Relative deny rules do not reach extra folders.** With an extra folder given through
  `additionalDirectories` (or `--add-dir`), the scout read a `.env` in it, although
  `Read(**/.env)` was on the deny list. Rules anchored at the folder's absolute path
  (`Read(//abs/folder/**/.env)`) were honoured, for `Read` and for `Grep`. Measured with Claude
  Code 2.1.302 on Linux. This is why every rule is repeated per folder.
- **The Windows form of an absolute rule is not measured.** `claudeRulePath` writes `C:\x` as
  `//c/x`, the form the permission docs describe. If the installed CLI reads it differently, the
  self-test's new check fails and code checks stay unavailable until it passes: the feature fails
  closed, not open.

### Not verified

- Nothing was run on Windows, in a packaged build, or in the Electron app; the WSL checkout used
  for this work has none of them. The code-check plan's step-7 gates (containment on Windows with
  a `.cmd` shim, 20 self-tests in a row, the scout-quality and conductor-behaviour evals, and the
  spoken runs) were not run. Flipping `CODE_CHECKS_UI` before them was the developer's call.
- The settings page's folder list and picker are unit-typed only; no UI test drives them.
- A task worktree of a WSL project is not under the mirror's folder, so a code check on such an
  agent's folder is still refused. `find_in_project` works there.

## Open questions for the developer

1. **Bypass permissions.** Is "whole computer, full permissions" acceptable as a *visible agent you
   start*, rather than an inline lookup the voice agent runs by itself? This note recommends that
   split. If you want the inline version anyway, it needs at least a separate setting, a spoken
   yes per run, and no `--restricted` guarantees.
2. **Extra folders.** Which folders beyond the project should lookups be allowed to read (other
   repositories, a notes folder)? Should a drive root ever be allowed?
3. **Who decides.** The model on its own within caps, only when you say "check first", or the
   model with a spoken heads-up ("let me check what the mirror is")?
4. **The extra yes.** After a scout check, starting the agent needs a spoken yes. Keep that, or
   accept it only for checks that found something unexpected?
5. **Which provider sees file contents.** The scout sends code to Anthropic through Claude Code.
   Native tools would send file names (facts) or contents (if a `read_file` were added) to the
   conductor's provider, including the realtime voice provider. Is either acceptable for every
   project, or should some projects be excluded?
6. **WSL first or Windows first.** Your Maestro checkout is a WSL project. Is the mirrored-folder
   shortcut (step 4) enough, or do you need the scout running in the distro (step 7)?
7. **Glossary source.** Generate it from `AGENTS.md`/`CLAUDE.md`, keep it by hand, or only learn it
   from what you define by voice ("when I say X I mean Y")?
8. **Model for the scout.** Haiku (fast, a fraction of a cent) or Sonnet (slower to start, about
   ten times the cost, better on deep questions)?
9. **Jev's verbatim sends.** Should a request with an unknown term ever be held back from Jev's
   fast path so the conductor can check it, at the cost of the fast path's speed?

## Appendix: the probe for this note

Claude Code 2.1.302 in the WSL distro, Haiku, from a temporary project folder, with a second
folder given as `--add-dir` and a third folder not given:

```
claude -p --model haiku --tools "Read,Grep,Glob" --restricted --strict-mcp-config \
  --permission-prompts none --no-session-persistence --max-budget-usd 0.10 \
  --add-dir <extra> --output-format json
```

The project file and the extra folder's file were read; the third folder's file was denied and
listed in `permission_denials`. 4.3 s wall time, $0.001 reported. One run; it shows that
`--restricted` honours `--add-dir` and still confines everything else, not how a real question
performs.
