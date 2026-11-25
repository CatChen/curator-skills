# Architecture

## Status and organization

This repository currently contains foundational documentation only. Game Curator and Book Curator are planned; no skills, collectors, schemas, installation instructions, or data processing are implemented. Steam is an intended initial game source; Kindle and Goodreads are intended initial book sources. Their individual data availability and reliability require investigation.

When implemented, each skill will live in `skills/<skill-name>/` and be independently installable and self-contained. Follow the [Agent Skills specification](https://agentskills.io/specification): a valid `SKILL.md` is the entry point, with optional `references/`, `scripts/`, and useful `assets/`. Keep core instructions concise and load supporting material as needed. Do not create empty skills simply to represent plans.

## Responsibilities

The following are conceptual stages, not a shared framework or mandated pipeline:

1. **Acquisition:** obtain relevant data through an available, authorized source, retaining its origin and export time.
2. **Normalization and validation:** deterministically parse, merge, deduplicate, and check data; record schema version and quality warnings. Preserve missing values distinctly from zero.
3. **Preference inference:** interpret evidence qualitatively, separating observations and explicit statements from inferences and confirmed preferences, with provenance and uncertainty.
4. **Recommendations:** weigh likely fit against time, money, attention, and alternatives; explain the rationale and gaps, including when skipping or stopping is appropriate.
5. **Feedback:** use user corrections and changing context to update the understanding while retaining evidence and its provenance.

Use code for reliable repetitive extraction and calculations, and language models for semantic interpretation and personalized reasoning. Domain-specific formats and storage can evolve independently. Share implementation only when actual duplication justifies it; no universal schema is prescribed.

## Capabilities and fallbacks

At the time of a task, inspect the tools and permissions actually available. Do not assume a particular client has a browser, or that browser navigation allows arbitrary JavaScript. Subject to relevance, freshness, access, and user permission, prefer:

1. Reusing sufficiently recent existing data.
2. Official APIs or authenticated browser access through available tools.
3. Deterministic collection scripts in a supported, permitted environment.
4. Browser navigation and DOM extraction.
5. Publicly accessible data.
6. A user-provided export or upload, with guidance where needed.

These are preferences, not a reason to bypass security or access controls. Fall back when a method is unavailable, report incomplete data, and produce useful advice from partial evidence without inventing missing values. Collection should be read-only unless a future feature explicitly requires and receives authorization for writes. See [privacy](privacy.md).
