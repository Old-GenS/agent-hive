# Research notes (2026-11-18)

Web search for the agent, front ends in similar projects, and workflow ideas.

## 1. Free web search for the agent

It's easy to add, and it can be done soon. The VM already has internet access, and pi supports search through plug-in packages, so it's mainly a setting plus one more key. Options:

| Option | Cost | Notes |
|---|---|---|
| **Tavily** | Free tier, about 1,000 credits a month, no card | Built for AI agents; the easiest to start with |
| **Exa** | Free monthly credit (sources differ on the exact amount) | Good for code and docs searches |
| **Brave Search** | About $5 a month of free credit, roughly 1,000 queries. A card may be required | Its separate free plan was reportedly removed in 2026 |
| **Keyless (DuckDuckGo fallback)** | Free | E.g. the pi package `pi-web-extension`. No signup, but it scrapes result pages, so it can break |
| **SearXNG, self-hosted** | Free | No vendor key, but you run the search server yourself |

These numbers come from comparison blogs that often disagree, so check each provider's pricing page before relying on them.

**Suggestion:** make search optional. The user adds a Tavily or Exa key the same way as a model key (the same screen in the onboarding mockup), and the key is passed into the VM only for runs that use it. Offer keyless search as a fallback. One bonus: the agent runs inside the VM, so a malicious web page that tries to manipulate it can't reach your machine.

## 2. What other projects do for front ends

- **opencode** (MIT license): the closest match to our plan. The agent runs as a local server, and the terminal UI, web UI and desktop app are all clients talking to it over HTTP plus server-sent events (a live event stream). That's exactly the planned `hive serve`. **Use:** the architecture, and its code is reusable under MIT.
- **OpenHands** (core under the MIT license, but its `enterprise/` folder isn't): React web UI with a live action panel showing every command the agent runs, which you can watch and interrupt. **Use:** UI patterns, like the action timeline, interrupt button and file-changes view. The code is reusable, but it's React and our UI is plain TypeScript.
- **Open WebUI:** a chat UI, not a coding tool. Since April 2025 its license doesn't allow removing or changing its branding once a deployment has more than 50 users. **Use:** ideas only, like its provider and connection settings with a "test connection" button. Don't copy its code.

## 3. Other workflow improvements worth adding

Roughly in order of value:
1. **A cost or time limit per run:** "stop at $0.50". Token costs are already tracked.
2. **A per-run network allowlist:** the VM can only reach the LLM API and package registries.
3. **Automatic checks:** run the repo's tests in the VM after the agent finishes, and show pass or fail in the summary.
4. **The same task on two models side by side,** then pick the better diff.
5. **Notifications** to your desktop or phone when a run finishes.
6. **Per-repo caches** for faster starts, extending the npm cache to pip and others.
7. **`hive continue`:** already planned.


Sources:
- [Vellum: best web search APIs for agents 2026](https://www.vellum.ai/blog/best-web-search-apis-and-mcps-for-ai-agents)
- [Firecrawl: best search tools for agents 2026](https://www.firecrawl.dev/blog/best-search-tools-for-agents)
- [Free web search and scraping APIs 2026](https://freetier.co/articles/free-web-search-scraping-apis-2026)
- [Best free web search API for AI agents 2026](https://groundroute.ai/best-free-web-search-api)
- [Best free web search APIs for LLM agents, tested](https://www.openwebninja.com/blog/best-free-web-search-apis-llm-agents)
- [mcp-searxng on GitHub](https://github.com/ihor-sokoliuk/mcp-searxng)
- [pi-web-extension README](https://cdn.jsdelivr.net/npm/pi-web-extension@0.1.2/README.md)
- [pi packages: pi-exa-gh-web-tools](https://pi.dev/packages/@coctostan/pi-exa-gh-web-tools)
- [OpenHands docs](https://docs.openhands.dev/overview/introduction)
- [OpenHands product update, May 2026](https://openhands.dev/blog/openhands-product-update---may-2026)
- [OpenHands on DataCamp](https://www.datacamp.com/tutorial/openhands)
- [opencode overview (aiwiki)](https://aiwiki.ai/wiki/opencode)
- [opencode architecture (basehub forum)](https://forums.basehub.com/anomalyco/opencode/8)
- [Open WebUI license](https://docs.openwebui.com/license/)
- [Open WebUI license 2026: branding clause (WZ-IT)](https://wz-it.com/en/blog/open-webui-license-branding-business/)
