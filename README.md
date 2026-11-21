# Adds Up

Adds Up reads a company's balance sheet from a picture. It proves each number that sits inside a total that re-adds. Hide such a number and Adds Up works out what it was. Change one and it finds the group that stopped adding up. A number outside every total cannot be proven this way, and Adds Up says so.

Built at the Gemini 4 NYC Hackathon on Saturday, November 21, 2026, for Problem Statement One, "5 Sigma".

## The marks

- **Tick:** the number sits inside a total that plain code re-added exactly. Only adding earns a tick. No model's opinion does.
- **Within rounding:** a total that adds up once the rounding of its lines is allowed for. No tick and no alarm.
- **Not proven:** the number sits outside every total. Gemini Decision 1 reads it a second time and gives a probability. It never gives a tick.
- **Does not add up:** a group whose lines do not re-add to its total is marked, with the gap.

## Results

The full results are in `data/scores.json` and on the "Test results" page. The rules were fixed before the run in `docs/eval-spec.md`.

- 50 filings, picked by a fixed hash rule, 3,030 numbers. Adds Up and one plain model call both read all 3,030 right. This test shows no difference in reading.
- Hidden numbers rebuilt: 49 of 49. Changed numbers caught: 49 of 49, against 47 of 49 for one plain call. One filing had no group in both columns, so these two steps did not run on it.
- Clean pages marked by mistake: 3 of 50. The pass mark was at most 2, so it was missed. `docs/misses.md` says what was fixed.
- 441 of 3,030 numbers (14.6%) sit outside every total and are "not proven". Adds Up proves the numbers inside a total that re-adds, not every number.
- Harder pictures, on 15 other filings (936 numbers): with a slight turn and blur, every number was read right. On copies like a phone photo, one plain call showed 47 wrong numbers as right. Adds Up gave 18 wrong numbers a tick out of 639 ticks and left 44 wrong numbers without a tick. On the worst copies neither read anything. On a bad picture a tick proves that the numbers agree with each other, not each digit.

## What was made when

- **At the event, after 10:30 AM ET:** the product code in `src/`, the browser tests in `e2e/`, the test scripts in `scripts/` (not `check-features`) and the results in `data/`. The first commit is at 10:34 AM ET. It shows as 09:34 in `git log`, which uses U.S. Central time.
- **Before the event, as words and pictures:** the screen pictures in `design/` (drawn on November 20), and `docs/plan.md`, `docs/eval-spec.md`, `docs/test-cases.md` and `docs/gemini-calls.md` (call shapes tested on November 20 and 21). Edits made at the event are in the git history, and the plan and the test rules list them in dated notes.
- **Scaffold and template:** the files that `create-next-app` made (layout, global styles, config files, package files, one smoke test), and the author's own template: `check`, `scripts/check-features`, the GitHub workflow, the Dependabot settings, the pre-push hook and the pull request template. All are in the first commit.

## Who built what

- Google's Antigravity wrote the product code for units 1 to 7 and the first fix, from one prompt per unit.
- Antigravity ran out of quota at 1:54 PM ET. Claude helper agents then built the later fixes: the strict hide rule, the search names, the rounding mark and the security limits. Antigravity had started two of them, and the commit messages say which.
- Claude Code set up the repository, wrote every prompt, tested every unit and made small corrections that the commit messages name. It also wrote the test scripts in `scripts/`, including the 50-filing test and the harder-pictures test.
- Claude Code made the commits, so each one carries a Claude co-author line.

## Models and their jobs

| Model | Job |
|---|---|
| Gemini 4 Hydrogen | Reads every number from the picture. For an upload, it also finds the cell to hide or change. |
| Gemini 4 Carbon | Gets the rows of a group that does not add up as text, and writes one sentence on the cause. It does not read the picture. |
| Gemini Decision 1 | Reads the numbers outside every total a second time, at most 20 per request, and gives a probability. |

Neon had Carbon's job in the plan. On the day, ten test calls each, timed at 11:43 AM ET: Neon took 6.4 to 15.8 seconds, median 7.4. Carbon took 2.6 to 14.9 seconds, median 4.7. The rule set before the build gave the job to Carbon when Neon's slowest call was over 12 seconds. The timing lines are in `docs/gemini-calls.md`.

An SEC statement is read as pictures of at most 12 number rows each, all sent at the same time. An upload is read as one picture. Only PNG and JPEG pictures are read. A PDF is refused.

## Run it

You need Node 26 (see `.node-version`). To run with no keys, use test mode. It uses fixture files and a fake Gemini client, and it calls nothing:

```bash
npm install
ADDS_UP_TEST=1 npm run build
ADDS_UP_TEST=1 npm run start
```

A real run needs `GEMINI_API_KEY` and `SEC_USER_AGENT` in the environment. `SEC_USER_AGENT` is the contact line that the SEC requires on every request. `CAUSE_MODEL` is optional and defaults to `gemini-4-carbon`. `.env.example` lists the names.

## Check it

Before the first run, install gitleaks and Python 3, then run `npx playwright install chromium`. Then:

```bash
./check
```

The check runs the secret scan, the feature map, lint, types, unit tests, the build and the browser tests. `FEATURES.md` lists each feature with the test that proves it.
