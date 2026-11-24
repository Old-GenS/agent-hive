# How hive stays up to date

A hive release is made of pieces that each get their own updates and security fixes. This page is
what keeps them current, and how updates reach you.

## What's in a release

| Piece | What it is | Where its version comes from |
|---|---|---|
| libkrun | the library that boots each run's microVM | built from source at a pinned tag (`versions.json`) |
| libkrunfw | the Linux kernel inside the VM | upstream's prebuilt, pinned by version and checksum |
| pasta | network isolation for the VM | your distro's `passt` package; a pinned static build as a fallback |
| Node.js | runs hive itself | pinned, checked against nodejs.org's checksums |
| pi | the coding agent inside the VM | pinned in `image/Containerfile` |
| The VM filesystem | Fedora, Chromium, git, compilers inside the VM | Fedora's packages at the time it is built |
| npm packages | hive's server and web UI | `package-lock.json` |

Every pinned version lives in one place (`versions.json`, `image/Containerfile`,
`package-lock.json`), so a release can be rebuilt exactly and every change is a small diff.

## What happens automatically

- **Renovate watches the pinned native pieces** — libkrun, libkrunfw, passt, Rust, the manylinux
  build image, Node.js and pi — and lists what moved on the repository's **Dependency Dashboard**.
  It opens a pull request on its own for a version it can update in one place (Node.js, pi,
  manylinux). The pins that are several fields at once (libkrun's tag and commit, libkrunfw's URLs
  and SHA-256, passt's URL and SHA-256) wait on the dashboard until you tick them, and are updated
  with `node scripts/check-updates.mjs --apply <component>` so a half-updated pin is never built.
  A major version of anything needs a click on the dashboard first. **Dependabot** covers npm
  packages and GitHub Actions, and opens security fixes as soon as an advisory is published.
- **Every change is tested on a real VM before it merges.** CI builds the whole release, boots it
  with KVM and checks HTTPS through the egress proxy, that the local network and cloud metadata
  addresses are refused, that headless Chromium loads a page, that DNS works, and that a run
  reaches the model API. An update's pull request is armed with GitHub's own auto-merge (the
  workflow only makes the enable call, since a bot may not merge its own work), so it merges as soon
  as the required checks pass; the maintainer only steps in when something fails (it stays open).
- **The VM filesystem is rebuilt from scratch every week** (`test.yml`): no podman cache, the
  distro base pulled again, so Chromium, git and every other package a task uses get their security
  updates. The result is booted in a real VM and put through the same smoke test as a release, then
  published as a test build — so a failure is a red run and a success is something you can promote,
  rather than a broken package update found here and not
  in someone's task. No VM filesystem is downloaded for it: the next release carries whatever the
  last good rebuild proved.
- **GitHub's security checks** watch the code: Dependabot alerts, secret scanning with push
  protection, and private vulnerability reporting (the Security tab).

## How updates reach you

There is one channel: **releases**. `hive update` installs the newest published release after
checking its signature. There are no nightly or beta prereleases to follow.

`hive update --check` only reports, `hive update --rollback` goes back one version, and a build
that was installed while prereleases existed still moves to the next full release (never a
downgrade).

hive also tells you once a day, when you run it, if a newer release is out.

## What's yours to update

- **Your distro:** your normal system updates keep `passt`, `gh` and the kernel's KVM support current.
- **Windows:** the `agent-hive` WSL distro gets Ubuntu's automatic security updates while it runs;
  WSL itself updates through the Microsoft Store (`wsl --update`).

Details for maintainers (the workflows, keys and cutting a release) are in
[RELEASING.md](RELEASING.md).
