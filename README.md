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

For a published version, the optional [skills CLI](https://github.com/vercel-labs/skills) requires Node.js 22.20 or later and npm for installation, not for ordinary conversational use. It is interactive by default. Choose the intended agent:

```sh
npx skills add CatChen/curator-skills --skill game-curator --global --agent codex
npx skills add CatChen/curator-skills --skill game-curator --global --agent claude-code
```

The default repository branch does not include unmerged pull requests. To evaluate a particular revision, use a checkout pinned to its full commit and install from that local checkout using the CLI's documented local-path support, or use a pinned copy as described below. Review the [CLI commands and options](https://github.com/vercel-labs/skills/blob/main/docs/commands.md), [Codex skills](https://developers.openai.com/codex/skills), and [Claude Code skills](https://code.claude.com/docs/en/skills).

For development, from the desired repository checkout, a maintainer can link the source to the user-level skill directory:

```sh
mkdir -p "$HOME/.agents/skills"
ln -s "$(pwd)/skills/game-curator" "$HOME/.agents/skills/game-curator"
# Alternatively, for Claude Code:
mkdir -p "$HOME/.claude/skills"
ln -s "$(pwd)/skills/game-curator" "$HOME/.claude/skills/game-curator"
```

Inspect an existing destination first, including a dangling symlink; do not replace another installation without understanding it. A link follows subsequent source changes. For an independent evaluation, use a clean checkout at the full commit or copy its complete `game-curator` directory to an empty destination, checking that `SKILL.md`, `references/` and `scripts/` are present and no stale files remain. Do not merge a copy into an older installation.

The repository's `skills/game-curator` is source; a project-level `.agents/skills/game-curator` and user-level `~/.agents/skills/game-curator` are separate discovery locations. In a fresh Codex session outside this repository, check that `$game-curator` is available and selected, then verify the loaded path and its symlink target or revision and supporting files. Reading the checkout manually is not proof of installation. If absent, restart and check discovery and project-level masking. For Claude Code, start a fresh session and check `/game-curator` and its loaded path. Installation does not itself grant browser or filesystem access and should not alter `~/.curator`.

For Claude Cowork, package separately from the repository root with `(cd skills && zip -r /tmp/game-curator.zip game-curator)` and upload through Customize → Skills → + → Create skill → Upload a skill, subject to account capabilities. The ZIP must contain `game-curator/` at its root; Cowork upload is separate from Claude Code installation. Verify actual discovery in the target runtime.

Try “My favorite games are Portal 2, Fez, and Outer Wilds. What should I play next?”, “Review my wishlist,” or “Should I continue this game?” No import is required. For browser discovery ask: “Diagnose Game Curator's Steam data acquisition capabilities in this session.”

The skill includes experimental browser-runtime collectors for Steam library, wishlist, reviews, and Replay. They use read-only DOM evaluation and browser controls, return partial data, and do not need Python or browser-console access. Initial authenticated Chrome and IAB tests exercised all four; complete coverage and structured Replay metrics remain unverified. See [collector and data instructions](skills/game-curator/references/data.md), [diagnostics](skills/game-curator/references/acquisition.md), and [manual test procedures](docs/game-curator-testing.md). Run the optional development-only synthetic tests from the repository root with `node tests/game-curator/test_browser.mjs`.

## Privacy and contributions

Personal data should stay under your control. Collection is intended to be read-only and limited to what your task needs; this project does not introduce telemetry or a hosted data store by default. Your chosen agent runtime and connected services may process data under their own terms. Read the [privacy principles](docs/privacy.md) for details.

Game Curator can optionally remember your preferences and feedback in a user-controlled Curator Home, conventionally `~/.curator/game-curator/` if your runtime can access your real persistent home. Caching raw Steam data is a separate opt-in. With your permission, a minimal settings file records your choices for future sessions, subject to runtime access. You can use the skill without either; inspect and manage any saved files yourself. Persistence is instruction-driven and has not yet been independently verified across sessions or runtimes. See [persistence and cache details](skills/game-curator/references/persistence.md).

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [agent instructions](AGENTS.md). This repository is licensed under the [MIT License](LICENSE).
