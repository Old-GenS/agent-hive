# How Agent Hive works

Agent Hive lets a coding agent loose on your code without letting it loose on your computer. Every
run gets its own small virtual machine with a copy of the repo. The agent can do anything it likes
inside that VM: install packages, run builds, open a browser, commit. What comes back to you is a
set of patches you can read before anything touches your real repo or GitHub.

## The picture

```
 you
  │  hive run "fix the pager"      (or the web UI)
  ▼
┌──────────────────────── your computer (the host) ────────────────────────┐
│                                                                          │
│  1. clone your repo ───────────►  run folder                             │
│                                   ├── work/   the agent's copy           │
│                                   ├── io/     prompt in, events out      │
│                                   ├── out/    patches                    │
│                                   └── origin/ clean clone (host only)    │
│                                                                          │
│  2. boot a microVM  ┌──────────────── microVM ──────────────────┐        │
│                     │  sees only: /work  /io  ~/.cache          │        │
│                     │  one LLM API key, the internet            │        │
│                     │                                           │        │
│                     │  pi (the agent) reads, edits, runs, commits│       │
│                     └───────────────────────────────────────────┘        │
│                                                                          │
│  3. follow io/events.jsonl live     ◄── what the agent is doing          │
│  4. export: the VM turns commits into patch files ──► out/               │
│  5. apply the patches in origin/ ──► diff · apply · push · PR · zip      │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## A run, step by step

1. **Prepare.** hive makes a run folder and clones the code into `work/`: your current checkout,
   a GitHub repo (`--repo owner/name`), or an empty repo for a new project. The clone has no
   remote and shares no files with your repo.
2. **Boot.** hive starts a microVM with [libkrun](https://github.com/containers/libkrun), behind
   [pasta](https://passt.top) for networking. The VM boots its own Linux kernel and a Fedora
   filesystem with git, Node, Python, compilers and headless Chromium.
3. **Work.** Inside the VM, [pi](https://pi.dev) gets your prompt and does the task in `/work`,
   committing as it goes. It runs as root in the VM and never asks for permission: the VM is the
   boundary, not the agent's good behaviour.
4. **Follow.** pi writes its events (messages, tool calls, token use) to a log file in `io/`.
   hive reads that file as it grows and shows the progress in the terminal or the web UI.
5. **Optional review.** With review cycles turned on, a second agent step (optionally on another
   model) checks the changes and fixes real problems. Runs with no commits skip this.
6. **Export.** A short second VM turns the agent's commits into patch files in `out/`.
7. **Deliver.** On the host, hive applies the patches in `origin/`, a clean clone the VM never
   sees, and from there you choose: `hive diff`, `hive apply` into your checkout, `hive push` to a
   new branch, a pull request, or a download (zip, git bundle, or a Markdown report).

Follow-ups (`hive continue`, or the message box in the web UI) start a fresh VM on the same
`work/` and the same pi session, so the agent remembers what it did.

## What the VM can and can't reach

| The VM can | The VM can't |
|---|---|
| read and change its own copy of the repo | see your other files, your home folder or other runs |
| reach the internet (LLM API, npm, pip, git clone) | reach your computer, your router or your local network |
| use one LLM API key for the chosen provider | see your SSH keys, `gh` login, git credentials or other API keys |
| install anything; it's thrown away afterwards | push to GitHub (it has no remote and no credentials) |
| use a download cache (`~/.cache`) shared only with runs of the same repo | keep anything else between runs |

The VM's root filesystem is read-only, with a writable layer in RAM that disappears when the VM
stops. pasta gives it a private network that can reach the internet but not the host's loopback,
gateway or LAN addresses.

## How results get back safely

Text crosses the VM boundary only as files: the prompt goes in as a file, events come out as a log
file, and commits come out as patches. The host **never runs git inside `work/`**: the agent
controls `work/.git`, and a hook or config setting there could run code on your machine. Instead,
host git only runs in `origin/`, a clean clone the VM never mounts, with hooks turned off. Pushes,
pull requests and zip or bundle downloads are all built there from the patches.

Nothing reaches GitHub because the agent said so. Branches are pushed by the host after the run
(by the web UI automatically, by the CLI when you run `hive push`), and pull requests and issues
are only opened when you ask.

## Keeping runs under control

- **Time limit:** each agent step is stopped after `HIVE_SANDBOX_TIMEOUT_MIN` (60) minutes. The
  VM launcher enforces it itself, so it holds even if hive crashes.
- **Deadline note:** the agent is told when it will be stopped, and to wrap up with 10 minutes
  left.
- **Stall watchdog:** a run that changes no files and sends no events for `HIVE_STALL_MIN` (15)
  minutes is stopped, so a stuck agent doesn't burn tokens.
- **Disk limit:** an agent step is stopped when the run folder plus its cache bucket uses more than
  `HIVE_RUN_DISK_MAX_GB` (20) GB, or when less than `HIVE_MIN_FREE_DISK_GB` (2) GB are free on the
  disk holding the runs. Size is checked every minute, free space every 15 seconds.
- **Work is kept:** when a run times out, stalls, hits the disk limit, fails or is stopped, whatever
  the agent committed is still exported.
- **Startup cleanup:** if hive crashed or the machine rebooted mid-run, the next start stops any
  leftover VM and marks the run "interrupted".
- **Retention:** finished runs are deleted after `HIVE_RUN_RETENTION_DAYS` (14) days.

## One engine, two front ends

```
   hive (terminal)        web UI (browser)
          │                      │
          │               hive serve (small HTTP layer)
          │                      │
          └──────────┬───────────┘
                     ▼
              the run engine        src/runs.ts
                     │
              run folders on disk   ~/.cache/agent-hive/runs/
```

The terminal and the web UI use the same run engine and the same run folders, so a run started in
one shows up in the other, and runs survive restarts. The web UI adds a queue (`MAX_CONCURRENT_SESSIONS`
runs at once, the rest wait their turn) and automatic pushes to a `hive/<run>` branch.

## Models

pi talks to the model. hive supports DeepSeek, Z.AI, OpenRouter, Anthropic and OpenAI; you add a
key with `hive keys add <provider>` or in the web UI, and only the chosen provider's key enters the
VM. For OpenRouter, hive also picks a fixed order of upstream providers for the model (the model
maker's own endpoint first, then the most reliable, then the cheapest, skipping low-precision
endpoints), which keeps the prompt cache warm and costs down. See
[CONFIGURATION.md](CONFIGURATION.md).

## Where things live

```
~/.config/agent-hive/env                 your keys and settings (mode 600)
~/.cache/agent-hive/runs/<repo>-<time>/  one folder per run
  work/        the agent's copy (the VM's /work)
  io/          prompt, system prompt, pi's session, event log (the VM's /io)
  out/         exported patches
  origin/      clean clone hive pushes from (host only)
  meta.json    status, model, cost, commits, the agent's report
~/.cache/agent-hive/vm-cache/repos/<id>/  ~/.cache inside the VM, one per repo
~/.local/share/agent-hive/rootfs/        the VM's filesystem
```

For the exact security rules the code keeps, see [AGENTS.md](../AGENTS.md#security-model--keep-these-invariants).
