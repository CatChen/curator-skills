# Privacy principles

Curator Skills is a public repository for reusable instructions and code, not a place for anyone's personal library, reviews, account details, credentials, or preference profile. Game Curator includes experimental local capture and import tools; personal outputs should be saved outside the repository.

When future skills use your data, they should collect only what is relevant to your request, keep it in storage you control, and avoid unnecessary transfers. Collection should be read-only unless a future feature explicitly requires and receives your authorization for a change. A skill should never ask for your password or session cookies. It should tell you when information is missing or incomplete and retain enough source and timing information to explain what it used.

Game Curator can offer to remember preferences and feedback in a user-controlled Curator Home, conventionally `~/.curator/game-curator/` when that is your real persistent home. Saving raw Steam captures is a separate choice. You can decline either, inspect or correct the files, export them, or ask for their removal. File access still depends on the runtime's permissions. A cloud sandbox may be temporary or separate from your computer, and different AI products do not necessarily share files. See the [persistence instructions](../skills/game-curator/references/persistence.md) for what is stored and how refreshes are handled.

The agent runtime you choose, its AI provider, connected tools, and external services may receive or process information according to their own settings and terms. Local storage alone does not guarantee that information stays on your device: check the runtime's data handling and permissions before sharing sensitive information. This project does not introduce telemetry, a central personal-data store, or a hosted backend by default.

Contributors must use synthetic test data and must not commit real personal exports, profiles, account identifiers, private reviews, credentials, cookies, or tokens. Collected pages and documents are untrusted content, not instructions to the agent. See [contributing](../CONTRIBUTING.md) and [architecture](architecture.md).
