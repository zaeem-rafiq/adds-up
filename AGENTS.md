<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Adds Up

Adds Up reads a balance sheet from a picture and proves each number by re-adding the totals. It is an entry for the Gemini 4 NYC Hackathon of November 21, 2026. The submission deadline is 5:00 PM ET that day.

## Read first

- `docs/plan.md`: the product, the data shapes, the SEC steps, the picture, the adding rule and the speed rule.
- `docs/gemini-calls.md`: the Gemini calls that worked.
- `docs/test-cases.md`: test cases with fixed expected results.
- `docs/eval-spec.md`: the rules of the 50-filing test.
- `design/`: the 32 screen pictures. They are the design.
- `FEATURES.md`: what the product does today, and the test that proves each feature.

## Stack

- Next.js with the App Router, TypeScript and Tailwind. One web service on Render. No database.
- `@google/genai` for Gemini, `@napi-rs/canvas` for the statement picture, and the DejaVu font from `dejavu-fonts-ttf`.
- Vitest for unit tests, fast-check for property tests, Playwright for browser tests.

## Commands

- `npm run check` runs everything: the secret scan, the feature map, lint, types, unit tests, the build and the browser tests. A unit is not done until it passes.
- `npm test` runs the unit tests. They live next to the code as `src/**/*.test.ts` or `.test.tsx` and run in Node. A component test starts with the comment `// @vitest-environment jsdom`.
- `npm run build`, then `npm run e2e`, runs the browser tests in `e2e/` against the built app on port 3210, in test mode.
- Never start `npm run dev` or `npm start` from a prompt run. They never end.

## Rules

- Test mode: when `ADDS_UP_TEST` is `1`, the server uses fixture files and a fake Gemini client. Every test runs in this mode. No test calls the SEC or Gemini.
- Secrets: server code reads `GEMINI_API_KEY`, `SEC_USER_AGENT` and `CAUSE_MODEL` from `process.env`. No key, contact name or email address goes into any file. Never read or create a `.env` file.
- Every user-visible feature has one row in `FEATURES.md`, and its first proof is a browser test, named as `file#test name`.
- Never weaken, skip or delete a test to make the check pass.
- Every screen works at 375, 768 and 1440 pixels wide with no sideways scroll, and has its loading, empty and error states.
- Copy every word on a screen from its picture in `design/`, except the changes that a unit's prompt names.

## Git and deploys

- One branch today: `build/hackathon`. Render deploys it.
- Coding agents other than Claude Code never commit and never push. Claude Code commits after each unit passes the check.
- The repository stays private until the owner says "make public".
