# The 50-filing test: rules fixed before the run

Written on 2026-11-21 before 10:30 AM ET, in words only. No test code exists yet. Claude Code writes the script at the event and runs it between 2:24 PM and 3:30 PM ET. The results go to the "Test results" page, screen 14.

The rules are fixed now so that nobody can pick easy filings or move a pass mark after the results are known. A copy of this file goes into the public repository with its date.

Changed on 2026-11-21 before 10:30 AM ET, before any run, on the owner's reply "Apply all". The change fixes the reply form of the two one-call checks in steps C and D, and the order of the questions in step E.

## What the test must show

The page reads a balance sheet from a picture and puts a tick on each number it has proven. The test answers one question: **how often does a tick sit on a wrong number, on filings nobody picked?** It compares that with one plain model call, which gives no warning at all.

## Which filings

1. Take every company in the SEC's list, `company_tickers.json`. Take each SEC number once, even when the list gives it several tickers.
2. For each company, compute the SHA-256 hash of the text `adds-up-2026-11-21:` followed by the company's SEC number without leading zeros. Sort the companies by that hash, smallest first. Check: Apple's SEC number 320193 gives a hash that starts `4307178eebec`.
3. Go down the sorted list. Skip a company, and write down the reason, when any of these holds:
   - Its newest filing of type 10-K or 10-Q is older than 2025-11-21, or it has none.
   - The filing has no balance sheet report under the rule in the shared plan.
   - The balance sheet table does not have exactly two number columns.
   - The table has fewer than 15 or more than 80 number rows.
   - It is Apple, the page's example, or one of the ten companies in Friday's test: PMTR, PSX, DXC, BOH, QSR, HGAS, PNW, ENSC, KNTK, KSCP.
4. Stop at 50 filings. Banks and insurers stay in.
5. The results file lists every skipped company with its reason.

## The answer key

The truth for each number is the value in the SEC's own report table for that filing. The models never see it. They get the picture only.

Two values match when they are the same number after these steps: remove the dollar sign, the commas and the spaces, and read a value in brackets as negative. A dash and an empty cell both mean "no value", and they match each other.

## What runs on each filing

| Step | What happens | What is recorded |
|---|---|---|
| A. Adds Up | The product's own reading: two half pictures, Hydrogen, then the adding rule. | Each number: right or wrong, and ticked or not. Each group marked as not adding up. The seconds taken. |
| B. One call | One Hydrogen call on the whole picture, with the same reading question. | Each number: right or wrong. Every number counts as "shown as right", because one call warns about nothing. |
| C. Hide one | Cover one number and run step A on the new picture. | Whether the page rebuilt the exact number. |
| C, one call | One Hydrogen call on the covered picture: "What number is under the box? Reply with the number only." | Whether its reply is the exact number, under the match rule above. |
| D. Change one | Change one number and run step A on the new picture. | Whether the page marks the group that holds the changed number. |
| D, one call | One Hydrogen call on the changed picture: "Does any total on this page fail to add up? Reply with one row label copied from the page, or NONE." | Whether its reply equals the label of the changed row or of its total. Spaces at the ends and capital letters make no difference. When two rows share a label, either row counts. |
| E. Second reader | Decision 1 answers yes-or-no questions about 20 numbers of the filing, 20 per request, at the top picture detail. Ten questions state the true value. Ten state a changed value. | The probability for each answer. |
| F. Hard copies | Steps A and B on a copy that is turned 2 degrees clockwise and blurred with a radius of 1.2 pixels. | The same as steps A and B. |

Which number each step uses:

- Number the cells by row and column. For each cell, compute the SHA-256 hash of the filing number, a colon, the row number, a colon, and the column number. Order the cells by that hash.
- Step C takes the first cell in that order that sits inside a group that exists in both columns.
- Step D takes the next such cell.
- Step E takes the first 20 cells in that order. The ten with the smallest hashes keep their true value.
- Step E sends its 20 questions in page order: by row number, then by column number. The hash order only picks the cells.
- A changed value is the printed number with 1 added to its second digit from the left. A 9 becomes 0. A one-digit number gets 1 added.

Steps A to D are the minimum. Steps E and F run only when A to D have finished before 3:10 PM ET. A step that did not run shows "not run" on the page, never a guess.

## What the page shows, and how each figure is counted

| Measure on the page | One call | Adds Up |
|---|---|---|
| Numbers read correctly | Right numbers in step B, as a share of all numbers. | The same for step A. |
| Wrong numbers shown as right | Wrong numbers in step B, as a share of all numbers. | Wrong numbers that carry a tick in step A, as a share of all numbers. |
| Clean pages flagged by mistake | Does not apply. One call flags nothing. | Filings where step A marks any group as not adding up, out of 50. |
| Hidden numbers rebuilt | Exact answers out of 50. | Exact rebuilds out of 50. |
| Changed numbers caught | Right rows named out of 50. | Right groups marked out of 50. |
| Same test on blurred, tilted copies | The first two measures on step F. | The same. |

The headline figure is "Adds Up, wrong numbers shown as right".

## What earns a tick

A tick means one thing: the number sits inside a total that plain code re-added. No model's opinion earns a tick. The demo script says the same in its line at 0:25.

A number outside every total gets the second reader, Decision 1. Its probability puts the number in one of three classes:

| Class | Probability | What the page shows |
|---|---|---|
| The second reader agrees | At or above the upper cut-off | "Not proven", with no question. |
| The second reader is unsure | Between the cut-offs | "Needs your eye". |
| The second reader disagrees | Below the lower cut-off | "Needs your eye", marked in red. |

Before the test, the cut-offs are 0.90 and 0.30. The test sets them from step E on the first 20 filings in the list:

- The upper cut-off is the lowest of 0.90, 0.95, 0.98 and 0.99 that no changed value reached.
- The lower cut-off is the highest of 0.30, 0.20, 0.10 and 0.05 that no true value fell under.
- When a changed value reached even 0.99, no number counts as agreed. When a true value fell under even 0.05, no number counts as disagreed. The page says so.

The table "How sure is the re-check?" uses step E on the other 30 filings only, because the cut-offs were not set on them.

**Decided by the owner on 2026-11-21, with the reply "Change labels".** The approved results screen labelled the three rows "Tick", "Ask you" and "Not proven". Under the rule above, the first row cannot say "Tick". The three row labels are now "The second reader agrees", "The second reader is unsure" and "The second reader disagrees".

## Pass marks, fixed now

| Measure | Pass mark |
|---|---|
| Adds Up, wrong numbers shown as right | Zero, or at most one tenth of the one-call figure. |
| Clean pages flagged by mistake | At most 2 of 50. |
| Hidden numbers rebuilt | At least 45 of 50. |
| Changed numbers caught | At least 48 of 50. |

One filing passes when no wrong number carries a tick and no group is marked by mistake. The page shows every mark as met or missed. A missed mark stays on the page.

## Before the full run

1. Run steps A to D on the first 5 filings. Read every result by hand.
2. Write down the cost of those 5, and project the cost of 50. Stop and ask the owner when the projection is over $15. The whole day's budget is $50.
3. Start the full run only when the 5 results are scored correctly. A scoring mistake is fixed first.

## Failures

- The results file keeps every failing filing: the company, the step, the number, what the page showed and the truth.
- Claude Code reads the result of every filing, not only the failures. The two most common causes of failure go under "Where it still fails" on the page, in plain words.
- The page always carries the line "Numbers outside every total cannot be proven", with the share of such numbers.
- A changed number outside every total cannot be caught from the picture alone. Step D therefore uses only numbers inside a group, and the page says so.

## Limits to state on the page

- The pictures are drawn from each filing's own table. Scans, photos and original layouts are harder. Step F is only a first look at that.
- Fifty filings find big problems. They do not measure a small failure rate. If 1 filing in 100 fails, a test of 50 shows it only about 40 times in 100.
