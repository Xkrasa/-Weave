# Domain Docs

This is a single-context repository.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** for architectural decisions touching the area being changed.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. The `/domain-modeling` skill creates them lazily when terminology or decisions are actually resolved.

## Use the glossary's vocabulary

When output names a domain concept, use the term as defined in `CONTEXT.md`. Do not drift to synonyms the glossary avoids.

If the concept is not in the glossary yet, reconsider whether it is invented language the project does not use, or note a real glossary gap for `/domain-modeling`.

## Spec status

Task-spec lifecycle and the keep-implemented rule live in `docs/specs/README.md`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than silently overriding it.
