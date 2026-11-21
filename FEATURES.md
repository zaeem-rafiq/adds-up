# Features

What Adds Up does today, in plain words, and the test that proves each feature. This is the product's contract: change a row in the same change as the feature, and `./check` fails when a proof is missing.

Proof names a test file and, after `#`, the name of the test inside it, as the test runner lists it. Every proof names its test; a file alone is not a proof. The first proof is the feature's end-to-end test.

| Feature | What it does | How to reach it | Proof | Broken looks like |
|---|---|---|---|---|
| Start page | The start page shows the product name "Adds Up" | Open the site | `e2e/home.spec.ts#shows the product name on the start page` | The page is blank or shows an error |
