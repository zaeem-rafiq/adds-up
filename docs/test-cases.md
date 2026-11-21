# Test cases with fixed expected results

Written on 2026-11-21 before 10:30 AM ET, in words and numbers only. No test code exists yet. Antigravity turns each case into a test at the event. The expected results are fixed here, so a test cannot simply agree with the program it tests.

Claude Code checked the expected results of sections C and D on 2026-11-21 with a separate calculation.

Rows are numbered from 1. "No value" means a dash or an empty cell.

## A. Company search (unit 1)

The fixture list holds ten companies. It must include Apple Inc. (AAPL), Apple Hospitality REIT, Inc. (APLE), Applied Materials, Inc. (AMAT) and Microsoft Corp (MSFT). It lists Apple Inc. before Apple Hospitality REIT, Inc. The owner approved the second Apple company and case A8 on 2026-11-21, before 10:30 AM ET, with the reply "Apply all".

| Case | The judge types | Expected |
|---|---|---|
| A1 | `apple` | Apple Inc. is the first match. |
| A2 | `app` | Apple Inc. and Applied Materials, Inc. both match. |
| A3 | `AAPL` | Apple Inc. matches by its ticker. |
| A4 | `  Apple  ` | The same result as A1. |
| A5 | `MICROSOFT` | Microsoft Corp matches. Capital letters make no difference. |
| A6 | `zzzz` | No match. The page shows the not-listed message. |
| A7 | nothing | No search runs, and no message shows. |
| A8 | `apple` | Two names start with the typed text. Apple Inc. comes before Apple Hospitality REIT, Inc. |

## B. Reading the SEC's report table (unit 2)

The fixture is one small page that Antigravity writes. It holds a `table` with the class `report`, and after it a second `table` with the class `authRefData` that holds three rows of definitions.

The `report` table holds these rows, in this order:

| Row | Row class | Label cell | Left cell | Right cell |
|---|---|---|---|---|
| 1 | none | Title: `CONSOLIDATED BALANCE SHEETS - USD ($) $ in Millions` | Heading `Sep. 26, 2026` | Heading `Sep. 27, 2025` |
| 2 | `re` | `Current assets:` | empty | empty |
| 3 | `ro` | `Cash and cash equivalents` | `$ 36,305` | `$ 35,934` |
| 4 | `re` | `Marketable securities` | `20,417` | `18,763` |
| 5 | `rou` | `Total current assets` | `56,722` | `54,697` |
| 6 | `re` | `Accumulated deficit` | `(1,234)` | `(987)` |
| 7 | `ro` | `Commercial paper` | a dash | `1,000` |
| 8 | `re` | `Term debt [1]` | `5,000` | a cell that holds only a non-breaking space |

| Case | Expected |
|---|---|
| B1 | The statement has 1 heading row and 6 number rows. No row comes from the `authRefData` table. |
| B2 | The column headings are `Sep. 26, 2026` and `Sep. 27, 2025`. The unit line is `USD ($) $ in Millions`. |
| B3 | Row 3 gives 36305 and 35934. The dollar sign and the commas are gone. |
| B4 | Row 5 has the total flag. Rows 3, 4, 6, 7 and 8 do not. |
| B5 | Row 6 gives -1234 and -987. |
| B6 | Row 7 gives no value on the left and 1000 on the right. |
| B7 | Row 8 has the label `Term debt`, without the footnote mark, and no value on the right. |
| B8 | A page with no `report` table gives a clear error, and the page shows the saved copy. |

## C. The adding rule (unit 4)

Each case is one column of values, top to bottom. "None" is an unreadable cell.

| Case | Values | Expected groups |
|---|---|---|
| C1 | 10, 25, 40, 75 | Row 4 is the total of rows 1 to 3. |
| C2 | 10, 20, 30, 5, 6, 11, 41 | Row 3 totals rows 1 and 2. Row 6 totals rows 4 and 5. Row 7 totals rows 3 and 6. |
| C3 | 10, 0, 20, 30 | Row 4 totals rows 1 to 3. A zero row can sit inside a group. |
| C4 | 0, 0, 0 | No group. A zero is never a total. |
| C5 | 10, None, 20, 30 | No group. An unreadable row stops the search. |
| C6 | 10, 20, 31, 5 | No group. |
| C7 | 20, 10, 10, 20 | Row 4 totals rows 2 and 3. The nearest rows win, and row 1 stays open. |
| C8 | 100, -30, 70 | Row 3 totals rows 1 and 2. |
| C9 | 5, 5, 10, 10 | Row 3 totals rows 1 and 2. Row 4 is no total, because one open row is not a group. |
| C10 | 10, 20, 30, 60 | Row 3 totals rows 1 and 2. Row 4 is no total. This case fixes a known weakness: a row that happens to equal the rows above it is taken as a total. |
| C11 | 36305, 20417, 43817, 39896, 14541, 18881, 173857 | Row 7 totals rows 1 to 6. These are the current assets in Apple's annual report filed in 2026. |
| C12 | 36305, 20417, 43817, 39896, 14541, 18881, 173857, 100, 200, 300, 174157 | Row 7 totals rows 1 to 6. Row 10 totals rows 8 and 9. Row 11 totals rows 7 and 10. |
| C13 | 36305, 20417, 43817, 39896, 15541, 18881, 173857 | No group. Row 5 was changed, so nothing adds up. |

| C14 | Two columns. Left: the values of C11. Right: 35934, 18768, 39777, 33180, 5718, 14585, 147957, where row 2 was misread. | The left column gives the group of rows 1 to 7, and its 7 numbers are "proven". The right column does not add up. The page marks rows 1 to 7 on the right as not adding up: the rows add to 147,962, the total says 147,957, and the gap is 5. |
| C15 | Two columns (Luxfer Holdings, current liabilities). Left: no value, 22, 34.6, 5.8, 0, 14.9, 77.3. Right: 25, 24.6, 27.2, 2.6, 2.8, 16, 98.2. | No group is marked as not adding up. The left column's 6 numbers and the right column's 7 numbers are all "proven". |

Case C15 was added at the event on 2026-11-21 after the 50-filing test found it.

States for the page, from C12: all 11 numbers are "proven". From C6: all 4 numbers are "not proven".

The property test: build a random column from groups of 2 to 6 positive whole numbers, each followed by its sum. The rule must find every one of those totals. Skip a column in which a number equals the sum of the open rows above it by chance, as in C10.

## D. Hide and change (unit 5)

Both cases use two columns. The left column is C11. The right column is 35934, 18763, 39777, 33180, 5718, 14585, 147957, and its row 7 totals rows 1 to 6.

When a cell is covered or changed, its own column no longer adds up. The page then takes the groups from the other column and applies them to the same rows.

| Case | What the judge does | Expected |
|---|---|---|
| D1 | Hides row 5 on the left, 14,541. | The page rebuilds 14,541: the total 173,857 minus the other five rows, which add to 159,316. |
| D2 | Hides row 7 on the left, the total. | The page rebuilds 173,857, the sum of rows 1 to 6. |
| D3 | Uses the column C12 on both sides and hides row 7 on the left. | The page rebuilds 173,857 two ways: rows 1 to 6 add to it, and 174,157 minus 300 gives it. Both agree. |
| D4 | Changes row 5 on the left to 15,541. | The page marks the group of rows 1 to 7 on the left as not adding up. It says the rows add to 174,857, the total says 173,857, and the gap is 1,000. The right column keeps its ticks. |
| D5 | Tries to hide a number that sits outside every total. | The page refuses, with the reason. |
| D6 | Hides a number while the other column has no group for those rows. | The page says it cannot rebuild the number. It never guesses. |

## E. Reading replies (unit 3)

Hydrogen answers with one line per row: label, a bar, the left value, a bar, the right value.

| Case | Reply line or event | Expected |
|---|---|---|
| E1 | `Cash and cash equivalents \| $ 36,305 \| $ 35,934` | Label `Cash and cash equivalents`, values 36305 and 35934. |
| E2 | `Accumulated deficit \| (1,234) \| —` | Values -1234 and no value. |
| E3 | `Inventories \| HIDDEN \| 5,718` | The left cell is marked as covered. |
| E4 | `Here are the rows:` | Ignored. A line without two bars is not a row. |
| E5 | `Notes \| loans \| 500 \| 400` | Label `Notes \| loans`. The last two fields are the values. |
| E6 | Half A returns 3 rows and half B returns 4 rows. | The joined reading has 7 rows, half A first, in the printed order. |
| E7 | The reading lacks one row of the statement. | The numbers of that row count as unread. No other row shifts. |
| E8 | A call has not answered after 12 seconds. | The page starts one repeat and shows the slow screen. The first answer that arrives is used. |
| E9 | The repeat also runs past 12 seconds. | The page shows an error with a "Try again" button. It shows no ticks. |
| E10 | An empty reply, or a reply with no row lines. | It counts as a failed call and gets the one repeat. |
| E11 | The same picture is read twice. | The second reading makes no model call and returns the same rows. |
| E12 | One browser sends a 121st request that needs a model call within one hour. | The page shows the limit message. No model call is made. A request answered from memory is not counted. |
| E13 | Forty browsers behind one network address send 10 reading requests each within one hour. | All 400 requests are served. A venue shares one address. |

## F. The second reader (unit 6)

The cut-offs in these cases are 0.90 and 0.30. The product reads its cut-offs from a settings file that the 50-filing test writes.

| Case | Input | Expected |
|---|---|---|
| F1 | 45 numbers outside every total. | Three requests, with 20, 20 and 5 questions. |
| F2 | No number outside every total. | No request. |
| F3 | The second of three requests fails. | Its 20 numbers show "Needs your eye". The other 25 keep their results. |
| F4 | Probability 0.97. | "Not proven", with no question. |
| F5 | Probability 0.90. | The same as F4. At the cut-off counts as agreeing. |
| F6 | Probability 0.60. | "Needs your eye". |
| F7 | Probability 0.30. | "Needs your eye". At the lower cut-off does not count as disagreeing. |
| F8 | Probability 0.10. | "Needs your eye", marked in red. |
| F9 | Any probability, for a number inside a total that re-adds. | No request is sent for it. Its tick comes from adding alone. |
