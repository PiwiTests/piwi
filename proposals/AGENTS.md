# Proposals — agent guide

Rules for the `proposals/` directory: the design records for work that is proposed or still being built. Read
[`../AGENTS.md`](../AGENTS.md) first for repo-wide conventions. Once its plan has shipped, a proposal becomes an
architecture decision record (ADR) in [`adr/`](../adr/); [`adr/AGENTS.md`](../adr/AGENTS.md) has the ADR format and
the move.

## Rules

- **Keep the Status paragraph current.** The paragraph under the title (`**Status.** …`) says what is built, what
  remains, and what was deferred or dropped. A pull request that builds part of a proposal updates it in the same
  commit.
- **Move it to `adr/` in the pull request that ships its last planned piece**, not in a later clean-up. When a
  proposal counts as shipped, and the steps of the move, are in
  [`adr/AGENTS.md`](../adr/AGENTS.md#when-a-proposal-has-shipped).
- **Do not move it early.** A proposal with planned work still unbuilt stays here, even when most of it is built.
- **`1.0-stabilization.md` is a register**, not a plan: other proposals add their entries to it. It stays here until
  1.0 ships.
- **Cross-references stay relative.** A link to another proposal is `[name.md](name.md)`; a link to an ADR is
  `[name.md](../adr/name.md)`.
