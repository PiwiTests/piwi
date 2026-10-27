# Proposals: agent guide

Rules for the `proposals/` directory: the design records for work that is proposed or still being built. Read
[`../AGENTS.md`](../AGENTS.md) first for the repository-wide conventions. Once its plan has shipped, a proposal moves to
[`adr/`](../adr/) as an architecture decision record (ADR).

## Rules

- **Keep the Status paragraph current.** The paragraph under the title (`**Status.** …`) says what is built, what
  remains, and what was deferred or dropped. A pull request that builds part of a proposal updates it in the same
  commit.
- **One shape for every record**: `# Title`, one intro paragraph saying what the record is, the `**Status.**`
  paragraph, then `**Summary.**` or the sections. The Status opens with `Proposed YYYY-MM-DD.` and says in a few lines
  what is built, what remains and what was deferred; how the build differs from the text goes in an `## As built`
  section, not in the Status. Prose is hard-wrapped at 120 characters.
- **Move it to `adr/` in the pull request that ships its last planned piece**: not earlier, even when most of it is
  built, and not in a later clean-up. When a proposal counts as shipped, and the steps of the move:
  [`adr/AGENTS.md`](../adr/AGENTS.md#when-a-proposal-has-shipped).
- **`1.0-stabilization.md` is a register**, not a plan: other proposals add their entries to it, and it stays here until
  1.0 ships.
- **Cross-references stay relative.** A link to another proposal is `[name.md](name.md)`; a link to an ADR is
  `[name.md](../adr/name.md)`.
