# Gemini calls that worked

These call shapes were tested with `@google/genai` 3.6.1 on November 20 and 21, 2026. Use them as written. Server code only: the browser never sees the key.

## The client

```js
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiVersion: "v1beta" }); // reads GEMINI_API_KEY from process.env
```

## Reading a picture (Gemini 4 Hydrogen)

```js
const r = await ai.interactions.create({
  model: "gemini-4-hydrogen",
  input: [
    { type: "image", data: pngBase64, mime_type: "image/png", resolution: "high" },
    { type: "text", text: prompt },
  ],
  generation_config: { thinking_level: "low" },
});
const text = r.output_text;
```

## One sentence on the cause (Gemini 4 Carbon, or the model named in CAUSE_MODEL)

The same call as above, with the model's name from `process.env.CAUSE_MODEL` and the default `"gemini-4-carbon"`. The product sends one text item: the rows of the group, as text. It sends no picture.

- Neon accepts `thinking_level` "low". It refuses "minimal" with error 400.
- Neon is sometimes very slow: four first test calls took 6, 8, 49 and 120 seconds. Never make the page wait for it.
- In the first test, `gemini-4-carbon` answered the same question in 3 to 7 seconds.
- Timed again at 11:43 AM ET on 2026-11-21, ten calls each, five at a time. Neon took 6.4 to 15.8 seconds, median 7.4. Carbon took 2.6 to 14.9 seconds, median 4.7. All 20 answered. A rule set before the build said Carbon takes the job if Neon's slowest call is over 12 seconds. It was, so the product uses Carbon.

## The second reader (Gemini Decision 1)

```js
const d = await ai.decisions.create({
  model: "gemini-decision-1",
  input: [{ type: "image", data: pngBase64, mime_type: "image/png", resolution: "ultra_high" }],
  questions: {
    q01: { type: "noul", instructions: "Is the value 36,305 printed for the row 'Cash and cash equivalents' in the left column?" },
  },
});
const pYes = d.answers?.q01?.noul; // a probability from 0 to 1
```

- A `noul` question is a yes-or-no question. Its answer is the probability of yes.
- Send at most 20 questions in one request. In the test, larger requests gave false alarms.
- Use `resolution: "ultra_high"`. At "high" it missed more changed numbers.
- One request took 0.7 to 1.4 seconds in the test.

## Rules for every call

- Wrap each call in a time limit. The reading call gets 12 seconds and one repeat.
- In test mode (`ADDS_UP_TEST=1`) no call leaves the machine. A fake client answers from fixture files.
- Never log the key, and never send it to the browser.
