# Curator Skills

> Life is short. Spend your time on things you'll love.

Bought more games than you have time to play? Have a shelf full of books and no idea what to read next?

Curator Skills gives your AI a way to learn what you enjoy and help you decide how to spend your limited free time. Unlike a storefront or a recommendation feed, your curator serves you — not engagement, sales, or consumption. Sometimes the best recommendation is something you already own, something worth revisiting, or nothing new at all.

## Quick start

[Install](#installation) Game Curator, Book Curator, or both, then try one of these conversations. You can start with what you tell your AI; importing a library is optional.

### 🎮 Game Curator

**Play what you already own.** Your next favorite game might already be in your Steam library.

> I bought way too many games during Steam sales. Look at my library and gaming history. I have a few hours this weekend — what should I play next?

**Make your next purchase count.** A great discount is only a good deal if you'll actually enjoy the game.

> Which game on my Steam wishlist is most worth buying next? Consider my tastes, what I already own, current discounts and historical sale prices where you can verify them. Tell me if I'd be better off waiting.

**Discover your own gaming tastes.** Talk about actual experiences, not just ratings or hours played.

> Let's talk about the games I've played recently. Ask me what I loved, what frustrated me, and why I stopped playing some of them. Help me figure out what kinds of games I really enjoy.

### 📚 Book Curator

**Read something you already have.** Make progress on your backlog instead of adding to it.

> What should I read next from my backlog? I'd prefer a book I already own but haven't read.

**Choose among new books and promotions.** Even a free book costs reading time.

> Which of this month's Kindle First Reads books should I pick, based on what I've enjoyed reading before?

**Learn from your reading experiences.** Understand what keeps you turning the pages.

> Let's talk about the last few books I read. Ask me what kept me reading, what didn't work for me, and what I'd like to read more of. Help me understand my reading preferences.

## Installation

The two skills are independent [Agent Skills](https://agentskills.io/specification). Install the ones you want with the [skills CLI](https://github.com/vercel-labs/skills) (requires Node.js 22.20+ and npm). Game Curator also uses Node.js for its data tools. No build step is needed.

**Codex**

```sh
npx skills add CatChen/curator-skills --skill game-curator --global --agent codex
npx skills add CatChen/curator-skills --skill book-curator --global --agent codex
```

**Claude Code**

```sh
npx skills add CatChen/curator-skills --skill game-curator --global --agent claude-code
npx skills add CatChen/curator-skills --skill book-curator --global --agent claude-code
```

Start a fresh session in your AI client. Ask one of the questions above, or explicitly invoke `$game-curator` or `$book-curator` in Codex, or `/game-curator` or `/book-curator` in Claude Code.

## Make your first recommendation more personal

You can start with a simple question. No import or account is required. If you'd like your curator to use more of your history, try:

> Get to know my gaming tastes using my Steam library, wishlist and reviews.

> Help me get started with my Goodreads reading history.

For automatic Steam data collection, use Codex Desktop or Claude Code in the Claude desktop app. The Goodreads workflow guides you through downloading your own export. You can also just talk about your favorite games or books.

## Supported platforms and data sources

Both skills work conversationally with Codex and Claude Code. You can also provide your own lists, notes or reading-history files. Other Agent Skills-compatible clients may also work.

| Skill | Data sources |
| --- | --- |
| [Game Curator](skills/game-curator/SKILL.md) | Steam library, wishlist, reviews and annual Replay reports; your own gaming history and feedback. |
| [Book Curator](skills/book-curator/SKILL.md) | Goodreads CSV exports; your own reading lists, files and feedback. |

**Steam:** Game Curator collects data read-only using compatible browser tools in Codex Desktop or Claude Code in the Claude desktop app (built-in browsers or Chrome integrations). Sign in yourself when needed. Collection can be partial. Other runtimes, including standalone CLI sessions, may lack browser access; you can still use existing data or your own gaming history.

**Goodreads:** Request and download your CSV from Goodreads' [Import/Export page](https://www.goodreads.com/review/import), then give your AI the file. The optional importer uses Python 3. See the [Goodreads workflow](skills/book-curator/references/goodreads.md). Amazon Kindle and Audible are not automated integrations. A Goodreads to-read shelf indicates interest, not necessarily ownership.

Your curator can also research current prices, past discounts and book promotions using accessible public sources when needed.

## A curator that learns with you

Tell your AI why a recommendation worked or didn't, which games you finished or abandoned, which books you reread, or how much time you have. Your own reactions are more useful than popularity alone. The curator distinguishes what you've actually said from tentative inferences and adapts when you correct it.

With your permission, each skill keeps a human-readable preference profile and feedback history in your own files. You can also separately choose to cache source data so future conversations don't have to start over or import everything again. Neither is required.

If Codex and Claude Code can access the same authorized persistent directory, they can use the same profile, feedback and cache. Switch AI clients without starting from scratch. There is no automatic cloud sync.

## Privacy and data ownership

Your personal data belongs to you. By default, optional persistent files live in `~/.curator/` when the runtime can access your real, user-controlled home. You can inspect or edit them, decline storage, revoke permission, or ask to remove your data.

- Profile and feedback persistence and raw data caching are separate opt-ins.
- Collection is read-only; the skills never ask for your passwords, cookies or tokens.
- This project adds no telemetry or hosted personal-data backend.
- Local storage does **not** mean local processing. Your AI runtime, provider and connected tools may process the information you share or authorize them to read.

See the [privacy principles](docs/privacy.md) for details and limitations.

## Roadmap

Curator Skills starts with Steam and Goodreads, but your interests aren't limited to a single platform.

### Game Curator

- [x] Steam
- [ ] Epic Games Store
- [ ] GOG

### Book Curator

- [x] Goodreads
- [ ] Amazon Kindle
- [ ] Audible

### Across all curators

- [ ] Explore [NeoDB](https://neodb.net/) support across media types.
- [ ] Support more AI runtimes.
- [ ] Make data collection more reliable and require less manual intervention.
- [ ] Improve recommendations through continued learning, including more helpful follow-up questions.

Future support depends on platform capabilities, access permissions and feasibility. We'd love to hear what you use and what you'd like your curator to help you with — [open an issue](https://github.com/CatChen/curator-skills/issues).

## Contributing and license

Contributions and real-world feedback are welcome. See [contribution guidance](CONTRIBUTING.md), [architecture](docs/architecture.md) and [product philosophy](docs/philosophy.md).

[MIT License](LICENSE).
