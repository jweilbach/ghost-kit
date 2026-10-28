# Reckoning tenets (Layer C): the file format

Tenets are the repo's own stated goals. They live in `.ghost/tenets.md` at the
repo root. Every finder receives every tenet, and a finding may cite a tenet id
in place of, or alongside, a `P-…` principle. In the Scroll's scorecard, each
tenet is rated *holds*, *strained* or *violated*.

A tenet carries weight at filing time too: a verified, major-or-worse violation
already meets the backlog's "someone would prioritise it" bar, because the
Hunter wrote the rule. The verdict may still leave one as a note (another action
covers it, or a documented exception applies), but never silently — it is
capped `tenet-not-filed` and listed in the Scroll. So write tenets you mean.

## Format

Anything before the first tenet (a title, a note) is ignored. Each tenet is one
block in this exact shape:

```
## T-<kebab-id> — <Title>
**Statement:** one sentence.
**Violation looks like:** bullets.
**Deliberate exceptions:** bullets citing the Augury / Imprint / PR / doc that settled it (refuters use these to kill findings that re-argue settled decisions). Omit if none.
**Evidence pointers:** where the goal is stated (`doc/path:line` "a phrase from that line").
```

**Ids**
- The skill extracts ids with `^## (T-[a-z0-9-]+)`. A heading that does not
  match is not a tenet. The skill prints the extracted ids at launch, so check
  that list.
- Ids are lowercase kebab-case, unique and **stable**. The next reckoning
  re-checks the previous themes by id, so renaming an id orphans that history.

**Fields**
- **Violation looks like:** concrete and checkable. A finder must be able to
  point at a `path:line`.
- **Deliberate exceptions:** each one cites what settled it: an answered
  Augury id, an Imprint id, a PR or commit, a doc `path:line`, or a code
  comment `path:line`. An uncited exception is a preference, not a settlement,
  and refuters weigh it that way.
- **Evidence pointers:** where the goal is *stated*, not where it is
  implemented. If a person said it, quote them and say where and when.

**Pointers.** Write a file pointer as a backticked `path:line`, relative to the
repo root, followed by a short quoted phrase from that line:
`` `CLAUDE.md:76` "Reads stay fast as an org grows" ``. A bare line number
rots with every edit above it, and a refuter that reads the wrong line cannot
find the settlement. At launch, prep checks every pointer against the pinned
tree. It warns when the file is gone, when a bare line is blank or past the end
of the file, and when the phrase is no longer on its line. A moved phrase is
reported with the line it moved to.

**Size.** Every finder and refuter reads the whole file, and nothing truncates
it, so each byte is paid for on every agent. Aim for about 1–1.5 KB per tenet.
Prep warns past 24 KB.

## When a repo has no `.ghost/tenets.md`

- The reckoning runs on Layers A and B only, and the scorecard carries only
  principle rows.
- The Scroll's "decisions needed" section suggests authoring the file in this
  format and names the repo docs that state goals worth capturing.
- **Tenets are never invented.** A tenet is a goal that a person or a doc
  stated. Inferring tenets from the code would grade the code against itself.
