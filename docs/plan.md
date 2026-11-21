# Adds Up: the shared plan

Written as planning before the event, and copied here at its start. Every unit follows it.

**Changed at the event, on 2026-11-21 (times in ET).** The text below was edited at the event to match what was built. The first commit holds the wording from before the event. The changes:

- Gemini 4 Carbon writes the cause sentence, not Neon. It gets the rows of the group as text and does not see the picture. Ten test calls each, timed at 11:43 AM: Neon took 6.4 to 15.8 seconds, median 7.4. Carbon took 2.6 to 14.9 seconds, median 4.7. The rule set before the build gave the job to Carbon when Neon's slowest call was over 12 seconds. The change is in commit 2b79936 (11:53 AM).
- A statement is read in pictures of at most 12 number rows, not in two halves. A hide or a change reads only the picture that holds the cell.
- An upload is read as one picture. The cut at a blank band was dropped.
- A group is marked "not adding up" in the other column only when its total row has no group of its own in that column (the first fix, commit 9a4a599).
- When the picture of a hide shows no covered cell, the hide reads the whole statement as one picture, once.
- A hide or a change is allowed only when the number's group exists in both columns (fix H1, commit 776f63a, 2:08 PM).
- A third mark, "within rounding", was added (fix H3, commit 1f84e68, 2:28 PM).

**The product.** A judge picks a US public company. The page shows its latest balance sheet as a picture. Gemini 4 Hydrogen reads every number from the picture. Plain code re-adds each total and ticks the numbers it proves. The judge hides a number, and the page rebuilds it. The judge changes a number, and the page marks the group that stopped adding up. Gemini 4 Carbon gets the rows of that group as text and writes the cause in one sentence. Gemini Decision 1 re-checks the numbers outside every total, in batches of at most 20, and never gives a tick. A second page shows a test on 50 filings.

**One statement, in words.** A statement has a company name, the form (10-K or 10-Q), the filing date, a title, two column headings, the unit line, and a list of rows. A row is a heading, or a number row. A number row has a label, an indent level, a total flag, and two values kept as the text the filing shows. A value in brackets is negative. A dash or an empty cell is no value.

**Where a statement comes from.** Steps 1 to 4 were checked on 2026-11-21 from the author's computer for Apple's latest annual report, with the declared contact. Each returned status 200. Not checked from Render.

1. `https://www.sec.gov/files/company_tickers.json` lists companies with their SEC number.
2. `https://data.sec.gov/submissions/CIK<ten digits>.json` lists a company's filings. Take the newest 10-K or 10-Q.
3. `https://www.sec.gov/Archives/edgar/data/<SEC number>/<filing number without dashes>/FilingSummary.xml` lists the filing's reports. Take the first report in the "Statements" group whose short name holds "BALANCE SHEET", "FINANCIAL POSITION", "FINANCIAL CONDITION" or "STATEMENTS OF CONDITION" and does not hold "Parenthetical". Banks use the last name. It was added at the event, after Bank of Hawaii's filing showed it.
4. That report's page, for example `R5.htm` in the same folder, holds one `table` with the class `report`. The first row holds the title and the two dates. Rows with the class `re` or `ro` are plain rows. Rows with `reu` or `rou` are totals. The label is in the cell with the class `pl`. Numbers are in cells with the class `nump` or `num`. A row whose number cells are empty is a heading.

Every request to the SEC sends the `SEC_USER_AGENT` value as its User-Agent. The SEC refuses requests without a declared contact. Send at most 5 requests a second.

**Test mode.** When `ADDS_UP_TEST` is `1`, the server uses a small company list, one statement and a fake Gemini client, all from fixture files in the repository. Every test runs in this mode. Nothing in test mode calls the SEC or Gemini.

**The picture.** Server code draws the statement as a PNG with `@napi-rs/canvas`: white page, black text, labels on the left with their indent, two right-aligned number columns, bold totals with a rule above. The server on Render may have no fonts. So the repository carries one open-licence font as a TTF file from an npm package, and the drawing code registers it before it draws. One drawing function takes a statement and two options: a cell to cover with a black box, as in Friday's test, and a cell to show with a different number. (Friday's test was a one-hour trial on November 20. Its scripts are not in this repository.) Hydrogen and Decision 1 see only this picture and their question. Carbon sees no picture. The page shows the same picture.

**The adding rule.** Go down one column. Keep a list of open rows. A row is a total when its value is not zero and equals the sum of the last two or more open rows. Those rows then leave the list, and the total joins it. A number inside a group whose total re-adds is "proven". A hidden number equals its group's total minus the other rows. A number outside every total is marked "not proven". A tick comes from adding alone. No model's opinion earns a tick. The two columns share their row groups. When a group re-adds in one column and the same rows do not re-add in the other, the page marks that group in the other column as not adding up, and shows the gap.

**Within rounding (fix H3, 2026-11-21).** Large companies print each line rounded to millions, so the lines miss a printed total by 1 or 2. The exact rule above runs first and does not change. Then, only when the unit line holds "thousand", "million" or "billion", a total that misses its lines by no more than the allowed gap is a rounding group, not a mark. The allowed gap is half the lines, rounded up, at most 3, counted in steps of the smallest unit printed in the column (1 for whole numbers, 0.1 for one decimal place). The row must be flagged as a total by the statement, or be the total of an exact group in the other column. Its numbers are "within rounding": no tick, nothing red, and they cannot be hidden or changed. A bigger gap is marked as before. An upload has no unit line, so it gets no rounding rule.

**Speed rule.** Read the statement in pictures of at most 12 number rows each, all sent at the same time. For an SEC statement, split between rows, never through a row, and draw each picture with the title line and the two column headings. A statement with 12 number rows or fewer is one picture. An upload is read as one picture. Give each reading call 12 seconds, then repeat it once. Show the loading screen at once, and the "slow" screen when the repeat starts.

An upload is read by two models, and a number gets a tick only when both read the same value and its total re-adds.

**The reading question.** Friday's test asked Hydrogen for one line per printed row that has a number or a dash: the label, a bar, the left value, a bar, the right value. It asked for each number exactly as printed, with commas and brackets, an empty cell where the page shows nothing, and the printed order. A covered cell is written as HIDDEN. Friday's test of two half pictures used this line format, on pictures with no covered cell. Friday's hide test read one whole picture with a JSON reply and a black box, and rebuilt 10 of 10. At the event, a hide covers the cell in the picture of at most 12 number rows that holds it, and reads that picture. If the picture shows no covered cell, the hide flow reads the whole statement as one picture, once.
