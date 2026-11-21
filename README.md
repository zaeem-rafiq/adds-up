# Adds Up

Adds Up reads a company's balance sheet from a picture and proves each number by re-adding the totals. Hide a number and it works out what the number was. Change a number and it finds the group that stopped adding up.

Built at the Gemini 4 NYC Hackathon on Saturday, November 21, 2026, for Problem Statement One, "5 Sigma".

## What was made when

- **At the event, after 10:30 AM ET:** every line of product code, markup, style and test in this repository. The Git history starts after 10:30 AM ET.
- **Before the event, as planning:** the screen pictures in `design/`, the plan in `docs/plan.md`, the test rules in `docs/eval-spec.md` and the test cases in `docs/test-cases.md`. They are words and pictures. Each file carries its date.
- **Standard tooling, not product code:** `check`, `scripts/check-features`, the GitHub workflow and the Dependabot settings come from the author's own project template.

## How it was built

Google's Antigravity wrote the product code, one small unit per prompt. Claude Code set up the repository, wrote each prompt, and tested each unit.

## Models and their jobs

| Model | Job |
|---|---|
| Gemini 4 Hydrogen | Reads every number from the picture. |
| Gemini 4 Neon | Reads the rows of a group that does not add up, and writes the cause in one sentence. |
| Gemini Decision 1 | Reads numbers a second time, in batches of 20, and gives a probability. |

Plain code re-adds the totals. A tick comes from adding alone. No model's opinion earns a tick.

## Run it

```bash
npm install
npm run dev
```

The server needs two settings: `GEMINI_API_KEY` and `SEC_USER_AGENT`, a contact line that the SEC requires. See `.env.example`.

## Check it

```bash
./check
```

The check runs the secret scan, the feature map, lint, types, unit tests, the build and the browser tests. `FEATURES.md` lists each feature with the test that proves it.
