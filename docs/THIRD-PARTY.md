# Third-party software

Agent Hive's own code is under the [MIT license](../LICENSE). It uses the projects below, each
under its own license. Thank you to their authors and maintainers.

## Inside the VM image

The VM's filesystem is built from `image/Containerfile`. It is downloaded by `hive setup` or built
locally with `npm run build:image && npm run build:rootfs`.

| Project | What it does in hive | License |
|---|---|---|
| [pi](https://pi.dev) (`@earendil-works/pi-coding-agent`) | The coding agent that runs each task | MIT |
| [Fedora](https://fedoraproject.org) | Base of the VM filesystem | Various (each package's own license) |
| [Chromium](https://www.chromium.org) | Headless browser for the agent's checks | BSD 3-Clause and others |
| [Node.js](https://nodejs.org) | Runs pi; available to the agent | MIT and others |
| [corepack](https://github.com/nodejs/corepack) | pnpm and yarn for the agent | MIT |
| [git](https://git-scm.com) | The agent's commits and the patch export | GPL-2.0, parts under other licenses |

## On the host

| Project | What it does in hive | License |
|---|---|---|
| [libkrun](https://github.com/containers/libkrun) | Boots each microVM (loaded by `vm/hive-vm` at run time; from the system for now) | Apache 2.0 |
| [libkrunfw](https://github.com/containers/libkrunfw) | The guest Linux kernel libkrun boots | LGPL-2.1 (library), GPL-2.0 (kernel) |
| [passt / pasta](https://passt.top) | The VM's isolated network | GPL-2.0-or-later and BSD 3-Clause |
| [git](https://git-scm.com) | Host-side clone, patch apply and push | GPL-2.0, parts under other licenses |
| [GitHub CLI](https://cli.github.com) (optional) | Repo lists, pull requests, issues, new repos | MIT |
| [Node.js](https://nodejs.org) | Runs the CLI and server; bundled in releases | MIT and others |

libkrun, libkrunfw, passt and git are used as separate programs or loaded libraries, not copied
into hive's source.

## npm packages

| Package | Used for | License |
|---|---|---|
| [Fastify](https://fastify.dev), `@fastify/static`, `@fastify/websocket` | The HTTP server and the live event stream | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | Reading `.env` files | BSD 2-Clause |
| [TypeScript](https://www.typescriptlang.org) (build) | The CLI, server and web UI | Apache 2.0 |
| [Vite](https://vite.dev) (build) | The web UI bundle | MIT |
| [esbuild](https://esbuild.github.io) (build) | The release's single-file CLI | MIT |

Packages these depend on are listed in `package-lock.json` and `ui/package-lock.json`, each with
its own license.
