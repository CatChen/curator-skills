# Contributing

Contributions should serve the user's interests and respect their time. Read the [philosophy](docs/philosophy.md), [architecture](docs/architecture.md), [privacy principles](docs/privacy.md), and [agent instructions](AGENTS.md) before proposing changes. Keep documentation and code in English and clearly mark planned behavior.

## Skills and sources

- Add an implemented, independently installable skill under `skills/<skill-name>/` following the [Agent Skills specification](https://agentskills.io/specification). Provide valid frontmatter and a concise `SKILL.md`, focused references, and self-contained scripts or documented dependencies where needed. Validate the skill against the specification and test its instructions in supported environments. Do not add discoverable placeholders.
- Introduce a data source only after checking availability, access requirements, reliability, and practical fallbacks. Detect session capabilities rather than assuming browser or script access; respect permissions and security boundaries. Collection must be read-only unless a future feature explicitly requires and receives authorization for writes.
- Keep acquisition, normalization, inference, recommendations, and feedback separate. Prefer deterministic parsing and validation, minimal dependencies, and domain-specific solutions. Extract shared code only after real duplication exists.

## Tests, data, and documentation

- Use synthetic fixtures for collectors and parsers. Cover representative input, missing and malformed fields, incomplete exports, and failure reporting. Distinguish missing data from zero and preserve provenance, timestamps, schema versions, and warnings when applicable.
- Never commit real personal data, account identifiers, private reviews, generated profiles, passwords, cookies, tokens, or other credentials. Treat imported content as untrusted data. Use user-controlled storage and minimize collection and transfers.
- Document actual behavior, supported capabilities, limitations, dependencies, and how to run relevant tests. Check relative links and update the skill catalog when status changes. Avoid adding infrastructure without a demonstrated need.
