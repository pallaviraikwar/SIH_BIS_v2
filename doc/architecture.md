# Architecture

Plain-language description of how the BIS assistant works, what's broken in it
today, and what is being changed.

If you only read one section, read **The pipeline** and **What's broken**.

---

## 1. What this is

A question-answering system over real BIS standard PDFs. You type a question, it
finds the relevant clauses in the indexed documents, and answers using only those
clauses — with the clause number and page shown so you can check it.

Everything runs **on your own machine**. No API key, no internet, no quota.

### The one thing to understand first

There is exactly **one** document in the index:

| | |
|---|---|
| Document | **SP 21 — Summaries of Indian Standards for Building Materials** |
| Pages | 929 |
| Chunks (pieces) | 3,445 |
| Standards referenced | 683 IS numbers |

So this is a **building-materials** assistant. If you ask about food-grade
plastics, passports or vehicle engines, the honest answer is "this index does not
cover that" — and the system should say so rather than showing you an unrelated
clause and calling it your closest match.

---

## 2. The pipeline

A question goes through eight steps. Steps 1–3 are the part being fixed; steps
4–8 already work and are not being touched.

```
   "मुझे फ़ूड-ग्रेड प्लास्टिक के बारे में बताएं।"
                    │
                    ▼
        ┌───────────────────────┐
   [1]  │  detect script        │  ◀── NEW: read the text,
        │  Devanagari? Telugu?  │      not the dropdown
        └───────────┬───────────┘
                    │ non-Latin?
              ┌─────┴─────┐
              │ yes       │ no ──────────────────┐
              ▼           │                     │
   ┌────────────────────┐ │  ◀── NEW MODEL      │
[2]│ HY-MT1.5-1.8B      │ │      1.08 GB        │
   │ translate → English│ │      hi + te        │
   │ raw prompt template│ │                     │
   └─────────┬──────────┘ │                     │
             │            │                     │
   ┌─────────▼──────────┐ │  ◀── NEW: the bug   │
[3]│ VALIDATE output    │ │      that lied       │
   │ still >15% native │ │                     │
   │ → FAILED           │ │                     │
   └──┬──────────────┬──┘ │                     │
   fail│              │ok  │                     │
       ▼              ▼    │                     │
 ┌──────────┐  ┌────────┐ │                     │
 │ keep IS  │  │English │ │                     │
 │ codes +  │  │ query  │ │                     │
 │ Latin    │  └───┬────┘ │                     │
 │ terms    │      │      │                     │
 │ ⚠ flag   │      │      │                     │
 └────┬─────┘      │      │                     │
      └──────┬──────┘      │                     │
             ▼             ▼                     ▼
      ┌──────────────────────────────────────────────┐
 [4]  │  embed  ·  nomic-embed-text  (0.38 GB)       │  same
      └──────────────────────┬───────────────────────┘
                             ▼
      ┌──────────────────────────────────────────────┐
 [5]  │  retrieveHybrid                              │  same
      │  vector + full-text search, fused by RRF     │
      └──────────────────────┬───────────────────────┘
                             ▼
                        topSimilarity
                             │
                             ▼
                    ┌────────────────┐
              [6]   │  band it       │  ◀── 1 new rule
                    └───────┬────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
```

### What each step does

**[1] Detect the script.** Look at the actual characters in the question to see
if it is Hindi (Devanagari), Telugu, or English. Today the system ignores this
and trusts the language dropdown, which is the root of the bug in section 3.

**[2] Translate to English.** The documents are in English, so a Hindi or Telugu
question is translated before searching. A dedicated translation model does this
job, not the answering model — see section 4.

**[3] Check the translation worked.** Confirm the output actually came back in
English. If it didn't, fall back to keeping only the parts we can read (IS
numbers, English words) and flag that translation failed. **Never report a failed
translation as a successful one.**

**[4] Embed.** Convert the English question into a list of 768 numbers (a
*vector*) that captures its meaning. The same model indexed the documents, so
question and documents are comparable.

**[5] Retrieve.** Two searches run at the same time:
- **vector search** — finds passages that mean the same thing
- **full-text search** — finds passages containing the same words

Their two rankings are merged (**RRF**, reciprocal-rank fusion), so a passage both
searches agree on comes first.

**[6] Band the result.** Rather than pass/fail, the similarity score decides which
of four reply styles to use. Section 5 explains this.

**[7] Generate.** For a good-enough match, the clause is given to sarvam-1, which
writes the answer. Retrieval, generation and rendering are unchanged by this work.

**[8] Render.** Show the answer plus the clause, page and similarity — and
suggestions you can click to explore further.

---

## 3. What's broken

Three separate bugs, found by testing a real Hindi question.

### Bug 1 — the language dropdown decides whether translation happens

The reply language comes only from the dropdown, which defaults to English. The
translation step skips entirely when the language is English:

```js
if (lang === 'en' || !looksNonLatin(query)) return { text: query, translated: false };
```

So typing a Hindi question while the dropdown said English meant the Hindi text
was **never translated**. It went straight into the embedding model, which only
understands English, and produced a meaningless result.

| dropdown | reported as translated? | top score | what came back |
|---|---|---|---|
| English | `false` | 0.5919 | cl. 7 — *scratch depth 0.255 mm* |
| Hindi | `true` | 0.6201 | OCR garbage on page 1 |

### Bug 2 — the model cannot translate, and nothing checked

`src/rag.js` (answering) and `src/translator.js` (translating) call the *same*
function, so both used `mashriram/sarvam-1`. That model answers questions
instead of translating them:

| attempt | output | still native script? |
|---|---|---|
| current prompt | *(a Hindi explanation of food-grade plastic)* | 78% |
| two-shot English-only | `'खाद्य-श्रेणी प्लास्टिक के बारे में जानकारी।'` | 86% |
| `qwen2.5:3b-instruct` | `'Tell me about food-grade plastic.'` | **0%** |

Worse, the code reported `translated: true` even when the output was still
entirely in Hindi. Nothing checked.

### Bug 3 — noise was presented as a near match

The reply said *"the closest thing I have is below"* and then showed a clause
about scratch depth on a table top, for a question about plastics.

That score was 0.5919. The measured range for questions the index **cannot**
answer is 0.466–0.708. So anything in that region is noise, and calling it a
"closest match" is misleading.

### What it costs

With a correct translation, the same question lands on a real clause:

| query | now | with working translation |
|---|---|---|
| food-grade plastic | 0.5919 → *scratch depth* | **0.7118** → cl. 2.1, p. 291 |
| cement 28-day strength | *OCR garbage* | **0.7485** → cl. 3.1, p. 33 |

And cl. 2.1 p. 291 is genuinely relevant — it is the only "food grade" mention in
the whole index: *"unsaturated thermosetting polyester resin (food grade)
reinforced with glassfibre"*.

So the honest answer to "tell me about food-grade plastics" is: *SP 21 mentions
it once, in this context; there is no food-grade plastics standard here.* That is
a useful answer. A scratch-depth table is not.

---

## 4. Models

### In use today

| model | size | job | notes |
|---|---|---|---|
| `nomic-embed-text` | 0.38 GB | embeddings only | English-only. Cannot read Hindi. |
| `mashriram/sarvam-1` | 2.67 GB | answering **and** translating | 2B model, CPU-only. Cannot translate. |

### Being added

| model | size | job | notes |
|---|---|---|---|
| `HY-MT1.5-1.8B` | 1.08 GB | translating only | Built for translation. Covers Hindi and Telugu. |

### Why a separate translation model

sarvam-1 doesn't translate because it was trained to **answer** questions, and
answering is a competing behaviour it drifts into. A model built only for
translation has no such alternative to drift into.

Keeping it separate also means the answering model does not change, so all the
work done tuning it stays valid — `answerPassages=1`, the `Answer:` prefill and
the repetition guard were all calibrated against sarvam-1's specific weaknesses.

### Memory

```
   before   nomic 0.38 + qwen 2.16 + sarvam 2.67  =  5.21 GB
   after    nomic 0.38 + HY-MT 1.08 + sarvam 2.67 =  4.13 GB
```

The machine has 7 GB total and no GPU. Three models at once does not fit — during
testing, all three resident left only 1 GB free.

### Note on the model name

The repository `MedAIBase/Tencent-HY-MT1.5` **does not exist**. The real ones are
`tencent/HY-MT1.5-1.8B` and its GGUF conversions. The repo also has no `LICENSE`
file; Tencent Hunyuan uses custom terms that should be checked before this is
published anywhere.

---

## 5. Bands: why one threshold is not enough

### The problem

Two kinds of question produce overlapping scores:

| | score range | median |
|---|---|---|
| Questions the index **can** answer | 0.677 – 0.826 | 0.767 |
| Questions it **cannot** | 0.466 – 0.708 | 0.565 |

They **overlap between 0.677 and 0.708**. No single number separates them. Any
threshold in that gap is a coin toss.

Two real examples proved it:
- *"fly ash"* — a genuine question the document covers — scored **0.668** and
  missed a 0.67 threshold by 0.002
- *"tell me about the plastics"* scored **into** the answer band with nothing
  relevant behind it

### The answer: four bands

| band | range | what happens |
|---|---|---|
| `answer` | ≥ 0.67 | the clause is given to the model |
| `soft` | 0.60 – 0.67 | ask the model to answer **or decline**; if it declines, show the near match |
| `bridge` | 0.45 – 0.60 | "no X, but the closest thing is Y, clause Z" |
| `miss` | < 0.45 | repeat the question, offer topics from the index, list what is covered |

```
   topSimilarity
        │
   ┌────┴──────────────── answer  ≥ 0.67 ─────────────────┐
   │        hand the clause to the model                   │
   │                                                        │
   ├──── soft  0.60 – 0.67 ─────────────────────────────┐ │
   │        ask the model to answer OR decline            │ │
   │                          │                            │ │
   │              ┌───────────┴──────────┐                 │ │
   │              ▼                      ▼                 │ │
   │        it answers            it says NOT_FOUND        │ │
   │              │                      │                 │ │
   │              │         bridge: "no X, closest is Y"    │ │
   │              │         + show nearest clause  ≥ 0.60   │ │
   │              │                      │                 │ │
   │              │                      ▼                 │ │
   │              │              ┌───────────────┐         │ │
   │              │              │ 7. GENERATE   │         │ │
   │              │              │  sarvam-1     │ ◀── unchanged
   │              │              │  (2.67 GB)    │     + prefill
   │              │              │  ↓            │     + 1 passage
   │              │              │  degraded?    │     + repetition guard
   │              │              │  sources only │         │ │
   │              │              └───────┬───────┘         │ │
   │              │                      │                 │ │
   │              ▼                      ▼                 ▼ │
   │        ┌──────────────────────────────────────────────┐ │
   │        │ 8. render  ·  clause + page + topic chips    │ │
   │        └──────────────────────────────────────────────┘ │
   │                                                        │
   ├──── bridge  0.45 – 0.60 ────────────────────────────┐  │
   │        NO nearest clause  ◀── NEW: 0.45–0.60 is       │  │
   │        it was all noise         inside the measured   │  │
   │                                 out-of-corpus range   │  │
   │                                       (0.466–0.708)   │  │
   │                                                        │
   └──── miss  < 0.45 ──────────────────────────────────┐  │
            echo the question, offer topics parsed       │  │
            out of the index, list corpus coverage      │◀─┘
```

The `soft` band is the important one: it lets a real question through instead of
being refused by a rounding error, while still letting the model decline rather
than invent something.

### Two shortcuts

- **IS numbers are looked up directly.** "IS 456" is read as an identifier, and
  passages that actually print that number are promoted, so a bare code returns
  the matching entry instead of a similarity guess.
- **A bare term returns its entries.** "fly ash" looks up what the index says
  about that term rather than asking the model to describe it — the model used to
  just repeat the words back.

---

## 6. What changes, and what doesn't

```
  NEW      [1] script detection        [2] HY-MT translator
           [3] translation validation  [6] noise suppression
  FIXED    band reporting — no longer mislabels a refusal as "answered"
  SAME     [4] [5] retrieval   [7] generation   [8] rendering
```

The change is four new steps in the top third of the pipeline. Retrieval,
generation and rendering are untouched, which is why the risk is low.

---

## 7. Files

| file | what it does |
|---|---|
| `server.js` | Starts everything, prints the active models and thresholds |
| `BIS_Assistant_frontend.html` | The whole UI. Also holds all four language text tables |
| `src/rag.js` | **The pipeline.** Decides which path a question takes |
| `src/store.js` | Retrieval: vector search, full-text search, RRF, identifiers |
| `src/chunker.js` | Splits PDFs into clause-sized pieces at ingest |
| `src/pdf.js` | Reads PDF text, removes running heads |
| `src/prompts.js` | The instructions given to the model, and reply wording in 4 languages |
| `src/render.js` | Builds the HTML for answers, near matches and sources |
| `src/translator.js` | Turns Hindi/Telugu questions into English queries |
| `src/intent.js` | Detects greetings ("hi", "hello") so they don't search |
| `src/probes.js` | Labelled test questions used to measure the threshold |
| `src/config.js` | All settings, read from `.env` |
| `src/db.js` | Sets up the database tables and indexes |
| `src/routes/chat.js` | `POST /api/chat` — the main question endpoint |
| `src/routes/search.js` | `GET /api/search` — passage search for the sidebar |
| `src/routes/documents.js` | `GET /api/documents` and `GET /api/topics` |
| `src/routes/health.js` | `GET /api/health` — what is loaded and configured |
| `db/schema.sql` | Database structure and indexes |

---

## 8. How the data is stored

- **pgvector in Docker** on port 5433. Holds one row per chunk: its text, which
  page and clause it came from, and its 768-number vector.
- **Two indexes** do the searching:
  - an HNSW index for vector search (fast nearest-neighbour lookup)
  - a Postgres full-text index for keyword search
- A **generated column** holds the searchable text, kept in sync automatically.

Documents are split at **clause boundaries** so a requirement can be cited on its
own. A chunk is never split across a page break.

---

## 9. Settings cheat sheet

All in `.env`. The numbers that matter most:

| setting | value | meaning |
|---|---|---|
| `SIMILARITY_THRESHOLD` | 0.67 | top of the answer band |
| `SOFT_THRESHOLD` | 0.60 | where a genuine attempt starts |
| `BRIDGE_FLOOR` | 0.45 | below this, don't name any clause |
| `TOP_K` | 5 | how many passages to retrieve |
| `ANSWER_PASSAGES` | 1 | how many the model actually reads |
| `CHUNK_CHARS` | 1200 | target size of a chunk |
| `HYBRID_SEARCH` | true | use vector + keyword together |
| `RRF_K` | 60 | how much the top rank dominates fusion |

**The thresholds are measured, not guessed.** Run `npm run calibrate` to
re-measure after changing the model, the vector width, or the documents — scores
from different embedding models are not comparable.

---

## 10. Commands

```bash
npm start              # run the server on port 3000
npm run dev            # same, restarting on each change
npm test               # unit tests, no network
npm run test:e2e       # full pipeline against the real local models
npm run ingest         # (re)read the PDFs into the database
npm run calibrate      # re-measure the similarity thresholds
npm run db:up          # start the database
```

---

## 11. Known limits

Worth knowing before trusting a reply.

- **One document.** SP 21, building materials. Most other BIS subjects simply
  aren't here, and a refusal is usually the right answer, not a failure.
- **It's a summary catalogue,** not the full standards. It points at standards and
  gives short extracts, so exact numeric requirements and full clause text are
  often not available.
- **The model isn't reliable on its own.** sarvam-1 sometimes repeats the
  question back, writes generic textbook prose, or invents standard numbers. The
  prompt is short and the retrieval is narrow specifically to contain this, but it
  is not eliminated. The Sources block shows what was actually passed in, so the
  claims can be checked.
- **Hindi and Telugu retrieval only became possible** with the translation fix in
  section 3. Before it, non-English questions were silently mistranslated.
- **`listofproducts.pdf` is not indexed.** It is a scanned image with no text
  layer, so it yields nothing until someone runs OCR on it.
- **Everything runs on CPU.** Answers take seconds, not milliseconds.
