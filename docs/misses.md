# Misses

A miss is a bug found after the work was reported as done. Each fix adds a regression test and one row here.

| Date | What broke | Who found it | Layer that should have caught it | What changed so it is caught next time |
|---|---|---|---|---|
| 2026-11-21 | The 50-filing test marked a group as not adding up on 3 of 50 clean pages. On two of them a line had a value in one column and none in the other, and the rule did not allow for that. The third, Leef Brands, has a table that does not add up in the filing itself. | The 50-filing test. | Unit tests. | The real Luxfer Holdings case became a test (case C15 in `docs/test-cases.md`). A group is now marked only when its total row has no group of its own in that column. |
| 2026-11-21 | The fix for that let a hidden number rebuild wrongly, with a tick, on Alphabet, AbbVie and Welltower. | An independent review, before release. | Unit tests. | A replay of all 79 saved statements is now a test. The page hides or changes a number only when its group exists in both columns. |
