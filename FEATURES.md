# Features

What Adds Up does today, in plain words, and the test that proves each feature. This is the product's contract: change a row in the same change as the feature, and `./check` fails when a proof is missing.

Proof names a test file and, after `#`, the name of the test inside it, as the test runner lists it. Every proof names its test; a file alone is not a proof. The first proof is the feature's end-to-end test.

| Feature | What it does | How to reach it | Proof | Broken looks like |
|---|---|---|---|---|
| Start screen layout and top bar | Shows the "Adds Up" top bar ("Check a statement" and "Test results") and the start screen headline and info cards at 375, 768 and 1440 px wide with no sideways scroll | Open the site | `e2e/home.spec.ts#renders the start screen at 375, 768 and 1440 pixels wide with no sideways scroll` | The top bar or headline is missing, links fail, or the page scrolls sideways |
| Company search and statement page | Searches the SEC company list, ranks matches, and opens the chosen company's statement page | Type a company name or ticker in the search box and pick a match | `e2e/home.spec.ts#searches for Apple, picks the first match, and shows the company name`, `src/lib/companies.test.ts#A1: typing 'apple' returns Apple Inc. as the first match` | Typing returns no matches, wrong order, or clicking a match does not show the company name |
| Keyboard search selection | Moves through matching company rows with the arrow keys and opens the marked company with Enter | Type in the search box, press ArrowDown or ArrowUp, then Enter | `e2e/home.spec.ts#navigates search matches with arrow keys and Enter`, `src/components/CompanySearch.test.tsx#arrow keys move through rows and Enter picks the marked row` | Arrow keys do not move the highlight or Enter opens the wrong company |
| Try an example | Opens Apple Inc.'s statement page with one click from the start screen | Click "Apple" beside "Try an example" | `e2e/home.spec.ts#picks Apple Inc. from Try an example` | Clicking Apple does nothing or opens the wrong company |
| Not-listed company message | Tells the judge when a typed company is not in the SEC's list | Type an unlisted company such as "zzzz" in the search box | `e2e/home.spec.ts#shows the not-listed message for an unknown company (A6)`, `src/components/CompanySearch.test.tsx#A6: typing 'zzzz' shows the not-listed message` | Nothing appears or an error crashes the page when no company matches |
