# HoloHunter Card Recognition Prompt Benchmark & Pipeline Optimization Plan

This document outlines the benchmark plan, suggested prompt optimizations, and technical transition steps intended to improve card-scanning recognition accuracy using direct Google Gemini Vision API integration.

> **Verification status — READ FIRST.** Every accuracy / latency figure in this
> document (including the "70% → 95%+" goal, and the 85% / 99% / "< 1.5s" numbers
> in §6) is an **unverified target**, not a measured result. The repo intentionally
> ships **no** benchmark images (`data/benchmark/images/` is gitignored so no private
> card photos are committed), so the benchmark's current evidence is **Total Run 0**.
> To turn these targets into measured numbers, drop your own non-private card images
> into `data/benchmark/images/`, extend `data/benchmark/metadata.json` ground truth,
> set the env below, and run `node scripts/benchmark-recognition.js`. The generated
> `data/benchmark/report.md` (gitignored) is the only source of truth for real
> accuracy — do not cite the targets below as achieved results.

---

## 1. Structured Response Schema Design

To guarantee output consistency, we leverage the Gemini API's native **Structured Outputs (`responseSchema`)** feature. The suggested schema defines key card identification properties, supports alternative candidate listings, and outputs an LLM confidence rating.

```json
{
  "type": "OBJECT",
  "properties": {
    "cardNumber": {
      "type": "STRING",
      "description": "The exact card number printed in small text on the card (usually bottom edge/corner), e.g., 'hBP01-001' or 'hSD02-005'. Normalized to lowercase, formatted with dash."
    },
    "character": {
      "type": "STRING",
      "description": "The Japanese name of the character on the card, or 'NONE' if not applicable (e.g. support or item cards)."
    },
    "rarity": {
      "type": "STRING",
      "description": "The rarity letter (C, U, R, SR, SEC, OUR, P), or 'NONE' if not applicable."
    },
    "hp": {
      "type": "STRING",
      "description": "The HP value of the card as a string (number only), or 'NONE' if not applicable."
    },
    "title": {
      "type": "STRING",
      "description": "The Japanese card title/flavor text on the card, or 'NONE' if not applicable."
    },
    "confidence": {
      "type": "NUMBER",
      "description": "Confidence rating of the identification between 0.0 (low/uncertain) and 1.0 (high/certain)."
    },
    "candidates": {
      "type": "ARRAY",
      "items": {
        "type": "OBJECT",
        "properties": {
          "cardNumber": {
            "type": "STRING",
            "description": "Alternative candidate card number."
          },
          "name": {
            "type": "STRING",
            "description": "Candidate card name."
          },
          "reason": {
            "type": "STRING",
            "description": "Reason why this candidate is a close match."
          }
        }
      },
      "description": "Alternative matching card candidates if the main identification is ambiguous."
    }
  },
  "required": [
    "cardNumber",
    "character",
    "rarity",
    "hp",
    "title",
    "confidence",
    "candidates"
  ]
}
```

---

## 2. Optimized Prompt for Gemini Vision

We recommend replacing the simple line-by-line prompt in `/api/recognize-card.ts` with a **Role-Based system prompt** combined with few-shot examples and strict negative constraints.

### System Instructions & Prompt
```markdown
You are a professional Hololive TCG Card Analyzer. Your task is to identify the card in the image.

Analyze the image carefully:
1. Locate the card number. It is printed in VERY SMALL text at the bottom edge, bottom-left, or bottom-right corner. It always follows formats like: "hBP01-001", "hSD02-005", "hPR-002", etc.
2. Locate the character name (usually Japanese text at the top of the card).
3. Find the HP value in the top-right corner (e.g. 130, 140, 160).
4. Find the Rarity letter (e.g. C, U, R, SR, SEC, OUR, P) near the bottom edge.
5. Identify the Card Title (flavor text or special name, e.g. "ときのそら", "風の赴くままに").
6. If any field is blurred or you are not 100% sure, fill in "NONE" or make a best guess and document in 'candidates'.

Negative Constraints:
- Ignore phone camera UI, hands, tables, or background artifacts.
- Do not make up (hallucinate) numbers if the bottom corner is cut off or unreadable. Mark it as "NONE" in 'cardNumber' and search for alternative matching names.

Few-Shot Examples:

User: Identify this card.
Assistant:
{
  "cardNumber": "hbp01-001",
  "character": "ときのそら",
  "rarity": "OUR",
  "hp": "130",
  "title": "ときのそら",
  "confidence": 1.0,
  "candidates": []
}

User: Identify this card.
Assistant:
{
  "cardNumber": "hsd02-005",
  "character": "雪花ラミィ",
  "rarity": "C",
  "hp": "140",
  "title": "NONE",
  "confidence": 0.95,
  "candidates": [
    {
      "cardNumber": "hbp04-005",
      "name": "雪花ラミィ",
      "reason": "Different rarity/set variant of the same character card"
    }
  ]
}
```

---

## 3. Benchmark Dataset & Flow Setup

Run the benchmark locally with `scripts/benchmark-recognition.js`. It performs a
**single pass over the same image batch** and, for **each** image, runs every
enabled A/B variant so results are directly comparable:

| Variant | What it exercises | Enabled when |
| :--- | :--- | :--- |
| `CURRENT_API` | The live app pipeline — POSTs `/api/recognize-card` (current line prompt + OpenRouter model + DB matching). This is the baseline we want to beat; it is the *only* place OpenRouter is used. | `BENCHMARK_API_URL` set (defaults to prod; set `BENCHMARK_API_URL=""` to skip) |
| `DIRECT_GEMINI_BASELINE` | Direct Google Gemini Vision with the app's **current** line-based prompt (isolates model/provider from prompt). | `GEMINI_API_KEY` set |
| `DIRECT_GEMINI_NEW_PROMPT` | Direct Google Gemini Vision with the **new** role-based JSON-schema prompt (§1–2). | `GEMINI_API_KEY` set |

The report (`data/benchmark/report.md`) breaks **success rate, per-field accuracy
(card #, character, rarity, HP, title), latency and errors out per variant**, plus
a per-image card-number comparison — that is the A/B contrast and pipeline-difference
quantification DIC-702 asks for. `CURRENT_API` scores only the fields the endpoint
returns (card #, character, rarity); HP/title are marked `n/a` for that variant.

There is **no** direct-OpenRouter variant: per the issue, OpenRouter must not be an
agent fallback. It appears solely inside `CURRENT_API`, measured as the incumbent
pipeline.

### Env

```bash
GEMINI_API_KEY="AIzaSy..."                          # enables the two DIRECT_GEMINI_* variants
BENCHMARK_MODEL="gemini-2.5-flash"                   # direct-Gemini model (optional)
BENCHMARK_API_URL="https://holocard-hunter.vercel.app" # CURRENT_API target; set "" to disable
```

### Data Folder Structure
```
data/
└── benchmark/
    ├── images/
    │   ├── test-card-001.jpg
    │   ├── test-card-002.jpg
    │   └── ...
    └── metadata.json
```

### `data/benchmark/metadata.json` Format
```json
{
  "description": "HoloHunter TCG Vision Test Dataset",
  "images": [
    {
      "filename": "test-card-001.jpg",
      "expected": {
        "cardNumber": "hBP01-001",
        "character": "ときのそら",
        "rarity": "OUR",
        "hp": "130",
        "title": "ときのそら"
      }
    },
    {
      "filename": "test-card-002.jpg",
      "expected": {
        "cardNumber": "hSD02-005",
        "character": "雪花ラミィ",
        "rarity": "C",
        "hp": "140",
        "title": "NONE"
      }
    }
  ]
}
```

---

## 4. Pipeline Difference Analysis

To close the gap between Gemini Chat (100% success) and HoloHunter App (70% success), we analyzed several pipeline stages:

| Stage | Current Pipeline | Optimized Pipeline Recommendation | Why it matters |
| :--- | :--- | :--- | :--- |
| **Image Resolution** | Resized to 1024px | Dynamic Resize (min 1600px if card number is blurred) | TCG card numbers are printed in micro-fonts (<6pt). High compression deletes this fine text. |
| **Image Cropping** | Uses raw camera view (no cropping / sending full photo) | Crop scan area precisely + OpenCV preprocessing | Reduces noise from phone UI overlay and background colors. |
| **Model Version** | `google/gemini-3.1-flash-image` (OpenRouter) | `gemini-2.5-flash` or `gemini-3.5-flash` (Direct Google API) | Gemini 3.5 Flash features vastly improved OCR and micro-text recognition. |
| **Response Format** | Raw lines text parsing | Native JSON schema validation (`responseSchema`) | Removes parsing failures and ensures fields are in correct datatypes. |
| **Temperature** | `0.0` | `0.1` | A tiny temperature introduces reasoning path search for blurry Japanese kanji. |

---

## 5. Direct Google Gemini API Routing & Env Setup

Transitioning from OpenRouter to Google Gemini API directly eliminates latency overhead, reduces rate limits, and unlocks native JSON Schema validation.

### Required Environment Variables
Set these variables in your deployment dashboard or local `.env`:
```bash
# Direct Google Gemini API Key (generated via Google AI Studio)
GEMINI_API_KEY="AIzaSy..."

# Config model routing (default is gemini-2.5-flash)
BENCHMARK_MODEL="gemini-2.5-flash"
```

### Transition Code for `/api/recognize-card.ts`

Replace the OpenRouter HTTP fetch with a direct call to the Google API endpoint:

```typescript
// Replace:
// const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
// const MODEL = 'google/gemini-3.1-flash-image';

// To Direct Gemini:
const apiKey = process.env.GEMINI_API_KEY;
const MODEL = process.env.BENCHMARK_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`;

// Payload structure update:
const response = await fetch(GEMINI_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: 'image/jpeg',
              data: base64ImageString // Exclude "data:image/jpeg;base64," prefix
            }
          },
          { text: systemPrompt }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: cardResponseSchema, // Pass the schema JSON
      temperature: 0.1
    }
  })
});
```

---

## 6. Model Routing & Cost-Quality Strategy

To balance speed, cost, and accuracy, we propose a **hybrid routing strategy**.

> **All numbers in this section are unverified design targets** (see the Verification
> status note at the top). The percentages and latencies below are hypotheses to
> validate with the A/B benchmark — not measured outcomes. Confirm or replace them
> from a real `data/benchmark/report.md` before treating any of them as an SLA or
> routing-cost commitment.

1.  **Stage 1 (Primary):** Route all scans to `gemini-2.5-flash`.
    -   *Cost (target):* Extremely cheap, near zero.
    -   *Speed (target):* Fast response time (< 1.5s — validate against the report's per-variant latency).
    -   *Outcome (target):* Handle the majority (~85%, unverified) of well-lit, standard card scans.
2.  **Stage 2 (Fallback):** If `confidence` from Stage 1 is `< 0.7` or `cardNumber` is returned as `"NONE"`, route the same preprocessed image to `gemini-3.1-pro` (or the Pro family).
    -   *Cost (target):* Higher, but expected to apply to only a minority (~15%, unverified) of cases.
    -   *Speed (target):* Moderate (~2.5s).
    -   *Outcome (target):* Leverage the larger Pro model's reasoning for blurry, low-light, or angled cards.

The intent is high speed for the majority of scans while the fallback lifts the
hard cases. The **99% "accuracy floor" is an aspiration, not a guarantee** — it can
only be claimed once the benchmark report on a real image batch shows it.
