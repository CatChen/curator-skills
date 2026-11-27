# Architecture

## Status and organization

Game Curator is implemented with conversational curation and experimental partial Steam page collectors that return versioned records. Initial authenticated Chrome and IAB tests exercised collection; coverage and compatibility remain subject to runtime permissions and Steam changes. There is no automated multi-capture archive or historical-format importer; see [acquisition](../skills/game-curator/references/acquisition.md). Book Curator supports conversational curation and Goodreads CSV normalization tested with synthetic data and one authenticated export. Book Curator is export-first and does not automate Amazon or Kindle; existing Amazon snapshots are historical evidence only. Comprehensive Goodreads coverage and cross-session persistence remain unverified; see [Goodreads import](../skills/book-curator/references/goodreads.md).

Each skill lives in `skills/<skill-name>/` and is independently installable and self-contained. Follow the [Agent Skills specification](https://agentskills.io/specification): a valid `SKILL.md` is the entry point, with optional `references/`, `scripts/`, and useful `assets/`. Keep core instructions concise and load supporting material as needed. Do not create empty skills simply to represent plans.

## Responsibilities

The following are conceptual stages, not a shared framework or mandated pipeline:

1. **Acquisition:** obtain relevant data through an available, authorized source, retaining its origin and export time.
2. **Normalization and validation:** deterministically parse, merge, deduplicate, and check data; record schema version and quality warnings. Preserve missing values distinctly from zero.
3. **Preference inference:** interpret evidence qualitatively, separating observations and explicit statements from inferences and confirmed preferences, with provenance and uncertainty.
4. **Recommendations:** weigh likely fit against time, money, attention, and alternatives; explain the rationale and gaps, including when skipping or stopping is appropriate.
5. **Feedback:** use user corrections and changing context to update the understanding while retaining evidence and its provenance.

Use code for reliable repetitive extraction and calculations, and language models for semantic interpretation and personalized reasoning. Domain-specific formats and storage can evolve independently. Share implementation only when actual duplication justifies it; no universal schema is prescribed.

## Optional Curator Home

`~/.curator/` is a preferred convention for a real user-controlled persistent home, not a mandatory path or a guarantee that a cloud sandbox, Codex and Claude share storage. Skills may have sibling directories. Game Curator's instruction-driven convention uses `game-curator/profile.md` for a concise understanding, `feedback.md` for dated evidence, and optional `cache/steam/` JSON source captures. Profile/feedback persistence and raw caching require separate explicit user opt-ins and host filesystem permissions. With authorization, a minimal `settings.json` records those choices for a fresh session to inspect before personal files; invalid or unavailable settings fail closed. An unknown custom path cannot be assumed. The skill falls back to conversation or supplied data when storage is unavailable and does not add a database, sync service or telemetry. See [persistence](../skills/game-curator/SKILL.md#persistence) for formats, refresh and conflict handling.

## Capabilities and fallbacks

At the time of a task, inspect the tools and permissions actually available. Do not assume a particular client has a browser, or that browser navigation allows arbitrary JavaScript. Subject to relevance, freshness, access, and user permission, prefer:

1. Reusing sufficiently recent existing data.
2. Official APIs or authenticated browser access through available tools.
3. Deterministic collection scripts in a supported, permitted environment.
4. Browser navigation and DOM extraction.
5. Publicly accessible data.
6. A user-provided export or upload, with guidance where needed.

These are preferences, not a reason to bypass security or access controls. Fall back when a method is unavailable, report incomplete data, and produce useful advice from partial evidence without inventing missing values. Collection should be read-only unless a future feature explicitly requires and receives authorization for writes. See [privacy](privacy.md).

An adapter or collector failure does not establish that its browser is unavailable. Diagnose the intended operation through supported direct control of the same session; preserve partial results, adapt or temporarily repair within permissions, and verify source identity, fields and coverage. Bound retries and respect access restrictions. Permanent changes to installed skills require authorization. The detailed [recovery procedure](../skills/game-curator/references/acquisition.md#2-recovery) distinguishes operation failures from session failures.
