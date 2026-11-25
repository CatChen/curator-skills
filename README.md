# Curator Skills

> Life is short. Spend your time on things you'll love.

Curator Skills is a collection of personal AI curator skills to help you discover what is worth your time, based on what you have actually experienced, what you enjoy, and what matters to you.

Most recommendation systems have incentives to increase engagement, consumption, or purchases. Your curator should serve you instead: it might suggest a game you already own, a particularly relevant book, skipping a popular title, stopping an unrewarding experience, or consuming nothing new. Time already spent, popularity, ratings, and discounts alone are not reasons to continue or buy.

## Skills

| Skill | Intended purpose | Status |
| --- | --- | --- |
| Game Curator (`game-curator`) | Decide what games to play, purchase, continue, or skip using personal gaming history and preferences. | Available for conversational use; experimental partial Steam collectors have limited live verification. |
| Book Curator (`book-curator`) | Decide what books to read, revisit, purchase, continue, or skip using personal reading history and preferences. Kindle and Goodreads are initial intended sources. | Planned; not implemented or installable. |

Steam collector reliability and completeness need further live verification. Book Curator is not yet installable.

## How they work

With your permission, a skill will use relevant information you provide or make available, such as history, reviews, and conversation feedback. It will distinguish observations from inferred preferences, explain its reasoning and uncertainty, and learn from your corrections. A long playtime or an unfinished book can have many explanations; neither proves enjoyment or dislike. Useful advice should still be possible with partial information.

Skills are independently installable packages following the [Agent Skills specification](https://agentskills.io/specification). See the [architecture](docs/architecture.md) and [philosophy](docs/philosophy.md) for the design.

## Install and try Game Curator

For Codex, from the repository root run `mkdir -p ~/.agents/skills && cp -R skills/game-curator ~/.agents/skills/`, then start a new session. For Claude, from the repository root run `(cd skills && zip -r /tmp/game-curator.zip game-curator)`. Upload the ZIP through Customize → Skills → + → Create skill → Upload a skill, subject to your account's capabilities. The ZIP must contain `game-curator/` at its root. Neither installation has been live-tested here.

Try “My favorite games are Portal 2, Fez, and Outer Wilds. What should I play next?”, “Review my wishlist,” or “Should I continue this game?” No import is required. For browser discovery ask: “Diagnose Game Curator's Steam data acquisition capabilities in this session.”

The skill includes experimental browser-runtime collectors for Steam library, wishlist, reviews, and Replay. They use read-only DOM evaluation and browser controls, return partial data, and do not need Python or browser-console access. Initial authenticated Chrome and IAB tests exercised all four; complete coverage and structured Replay metrics remain unverified. See [collector and data instructions](skills/game-curator/references/data.md), [diagnostics](skills/game-curator/references/acquisition.md), and [manual test procedures](docs/game-curator-testing.md). Run the optional development-only synthetic tests from the repository root with `node tests/game-curator/test_browser.mjs`.

## Privacy and contributions

Personal data should stay under your control. Collection is intended to be read-only and limited to what your task needs; this project does not introduce telemetry or a hosted data store by default. Your chosen agent runtime and connected services may process data under their own terms. Read the [privacy principles](docs/privacy.md) for details.

Game Curator can optionally remember your preferences and feedback in a user-controlled Curator Home, conventionally `~/.curator/game-curator/` if your runtime can access your real persistent home. Caching raw Steam data is a separate opt-in. You can use the skill without either; inspect and manage any saved files yourself. Persistence is instruction-driven and has not yet been independently verified across sessions or runtimes. See [persistence and cache details](skills/game-curator/references/persistence.md).

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [agent instructions](AGENTS.md). This repository is licensed under the [MIT License](LICENSE).
