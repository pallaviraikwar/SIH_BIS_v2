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

Five separate bugs, found by testing real Hindi questions.

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

### Bug 4 — the route threw away the `'auto'` the frontend had already resolved

Fixing bugs 1 and 2 made the frontend send `lang: 'auto'` and the server detect
the script. That worked in every test and did not work in the browser, because
one line above it all threw the value away:

```js
const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';
```

`'auto'` is deliberately *not* in `SUPPORTED_LANGS` — that list also feeds
`normaliseLang()` and the i18n table checks, both of which require real
languages. So every `'auto'` was silently rewritten to `'en'` before `rag.js`
could act on it, and the `rawLang === 'auto' ? null : rawLang` guard downstream
was dead code over HTTP.

The result was a failure that hid behind a healthy-looking response. A Hindi
question about ready-mixed paints retrieved five real clauses from SP 21 p. 827
— `band: answer`, `topSimilarity: 0.7694` — and translation ran correctly, so
every health signal read as fine. But the prompt was handed a **Hindi question
with the instruction to answer in English**, and sarvam-1 resolved that
contradiction by replying in Hindi anyway:

```json
{ "answerText": "नहीं।", "notFound": false,
  "meta": { "lang": "en", "translationUsed": true, "band": "answer" } }
```

Two things were wrong at once and neither was obvious. The answer language
disagreed with the language the UI had switched to, because `meta.lang` came
from the flag and the prose came from the script. And the answer was four
characters long.

`/api/search` did not have this bug — it passed `lang` through raw — so the two
routes disagreed about the same contract. No test touched `chat.js` at all; the
end-to-end tests called `answerQuestion()` directly and so could never have seen
it. The route now resolves two separate values (`request` for the pipeline,
`ui` for the canned error copy) and `resolveLang()` is exported and unit-tested.

### Bug 5 — a four-character reply was served as a cited answer

`isDegenerate()` catches repetition loops and deliberately ignores anything
under 120 characters, since you cannot loop meaningfully in 119 of them. That
left the opposite failure open, and `"नहीं।"` walked straight through it: a
fully cited reply, `notFound: false`, and nothing anywhere saying the model had
not actually answered.

`isSubstantive()` now asks whether the reply is traceable to the passages it was
handed — a number or content word that also occurs in the evidence. Length alone
is the wrong test, because `"43.0 MPa"` is a complete and correct answer to a
strength question, so a purely length-based gate would have introduced a worse
bug than the one it fixed.

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
| `public/index.html` | The UI markup. Also holds all four language text tables |
| `src/rag.js` | **The pipeline.** Decides which path a question takes |
| `src/store.js` | Retrieval: vector search, full-text search, corpus statistics, the ingest lifecycle |
| `src/rank.js` | Reciprocal-rank fusion of the two retrieval arms. Pure, no database |
| `src/text.js` | Pure text rules: reading an IS number out of a query, tidying a title, rotating suggestions |
| `src/chunker.js` | Splits PDFs into clause-sized pieces at ingest |
| `src/pdf.js` | Reads PDF text, removes running heads |
| `src/prompts.js` | The instructions given to the model, and reply wording in 4 languages |
| `src/render.js` | Builds the HTML for answers, near matches, sources, and the citation links and panels |
| `src/translator.js` | Turns Hindi/Telugu questions into English queries |
| `src/intent.js` | Detects greetings ("hi", "hello") so they don't search |
| `src/probes.js` | Labelled test questions used to measure the threshold |
| `src/config.js` | All settings, read from `.env` |
| `src/db.js` | Sets up the database tables and indexes |
| `src/routes/chat.js` | `POST /api/chat` — the main question endpoint |
| `src/routes/search.js` | `GET /api/search` — passage search for the sidebar |
| `src/routes/documents.js` | `GET /api/documents`, `/api/topics`, `/api/documents/:docId/pdf` |
| `src/routes/health.js` | `GET /api/health` — what is loaded and configured |
| `db/schema.sql` | Database structure and indexes |

---

## 7a. Citations

A citation used to be a number in a list. It is now checkable in two
directions, and the two halves come from different places on purpose.

**The panel** is the passage itself. `publicSource()` in `src/rag.js` puts the
chunk text in `sources[].content`, and `citationPanel()` in `src/render.js`
renders it inside a collapsed `<details>` with the cited clause wrapped in
`<mark>`. It is the *same string* that was put in the model prompt — not a
second read of the PDF, not a paraphrase. If the panel disagrees with the
answer, the answer is wrong, and you can see it without trusting anything.

Only the first literal occurrence of the clause label is marked. That is
deliberately conservative and it is also the feature's main weakness: a label
like `15` among other numbers can highlight a coincidence. Across the corpus
the label appears verbatim in ~91.5% of chunks, so the surrounding text in the
panel usually makes the intent clear even when the highlight does not.

Panels appear in the Sources block only for passages that were actually sent to
the model (`passedToModel`). The near-miss and located paths already show their
own excerpt in full, so a panel there would be a duplicate.

**The page link** goes through a route rather than straight to the file. This is
the important part: the link contains a `docId`, never a filename.

```
/api/documents/is.sp.21.2005/pdf#page=827
        └─ docId ─┘        └─ 1-based PDF page index
```

The link is a plain anchor that opens the document in a new tab. Clicking it
without a modifier key is intercepted by the frontend and opens the in-page
viewer instead (below); middle-click, ctrl-click and shift-click are left alone
so the browser's own behaviour still works, and with JavaScript disabled the
href is the only thing left and still resolves. Both properties are asserted in
`test/citations.test.js`, because a viewer that quietly becomes the only way to
read a citation is a regression nobody would notice until the script broke.

`GET /api/documents/:docId/pdf` looks the row up with
`getDocumentSource()`, which only returns documents whose status is `ready`, and
reads `source_file` from the database. `resolvePdfPath()` then resolves that
filename against `config.corpus.pdfDir` and refuses the request if the result is
not strictly inside it. Absolute paths and NUL bytes are rejected before any
filesystem call.

Because the path is never attacker-supplied, the classic `?file=../../../etc/passwd`
attack does not exist here — that parameter is simply ignored, and the request
returns the legitimate document. The prefix check is a second line of defence
against a bad `source_file` in the database, not the primary control.

`#page=` is a PDF viewer fragment. The browser never sends it, which is fine: the
route serves the whole document with `Accept-Ranges: bytes`, so a native viewer
seeks to the page itself. Verified: `Range: bytes=0-1023` returns `206` with a
correct `Content-Range` against a 7,537,270-byte file.

`page_from` is a 1-based index into the PDF, not the page number in the printed
footer. On `is.sp.21.2005.pdf` the two diverge noticeably, so the printed folio
and the link will not always agree.

Scanned documents are refused with a 404 even though they are indexed for
search, because their pages render as images and `#page=` would land on a blank
screen.

The route is unauthenticated. That is the right default for a local corpus demo
and the wrong one for a public deployment, where it makes every indexed standard
downloadable.

### The in-page viewer

Clicking a citation opens a fixed slide-over rather than a new tab, so the
answer stays on screen next to the page that supports it. It is
`position: fixed`, not a column in `.wrap`, because the transcript is long
enough that reflowing it on every open would be worse than covering part of it.

The document renders in an `<iframe>` using the browser's own PDF viewer. That
is a deliberate choice against PDF.js: this project has five runtime
dependencies and no devDependencies, and a bundled renderer is a large addition
for a local demo. It costs three things, each handled rather than hidden:

- **The route must keep `Content-Disposition: inline`.** A frame will not render
  a file offered as a download, and switching to `attachment` — a plausible
  hardening — turns the viewer into a download prompt. This coupling is stated
  in the markup and the README so the next person does not undo it.
- **The frame is only populated on open.** `src` is assigned when a citation is
  clicked and removed on close, so the 7.5 MB file is never fetched during page
  load and is not held for the rest of the session.
- **Seeking with `#page=` inside a frame is unverified in Safari.** Chrome, Edge
  and Firefox honour it. The passage sits *above* the frame and the footer
  keeps an "Open in new tab" link, so a browser that ignores the fragment still
  shows the evidence and still offers a way to the page.

The clause is highlighted twice, by two different mechanisms, and the second one
is the only duplicated rule in the feature. The server marks it in the
`<details>` panel; the frontend re-marks it in the viewer. The viewer's search
runs over already-escaped text on both sides, which is only sound because
`escapeHtml()` in `src/render.js` and `esc()` in the frontend replace the same
five characters the same way. The two implementations are checked against each
other in `test/citations.test.js` rather than left to a comment. Sending a third
rendered copy inside a `data-` attribute was rejected as worse than one duplicated
line of first-occurrence logic.

**The escaping round trip is a security boundary, and it used to leak.** The
server escapes the passage so that `data-excerpt` is safe as an attribute, but the
frontend reads it back through `dataset`, which resolves the entities again, and
then assigns the result to `innerHTML`. So the escaping has to be done *again* on
the client, immediately before insertion, or a tag in the PDF text becomes a live
element in the drawer. The frontend was not doing that: a passage containing
`<img src=x onerror=...>` fired that handler for any reader who opened the
citation. PDF text is untrusted input, the same way an answer is, and the panel was
never affected because its markup is escaped and built in one place. The fix is
that `markClause()` now escapes both the passage and the clause itself, which is
also what makes it agree with `citationPanel()` for a clause containing `&`.

The viewer ships closed, `aria-hidden` and `inert`, so its links are not in the
tab order while it is off screen. `visibility` rather than `display` is used for
the closed state, because `display` cannot be transitioned. Focus moves to the
close button on open and returns to the citation link on close, and there are
three ways out — the × button, the scrim, and `Escape` — because a panel that can
only be closed by reloading is a trap on a touch device.

Its strings are in the four language tables like everything else, which the
existing parity test in `test/i18n.test.js` enforces. `data-i18n` only sets
`textContent`, so the close button's accessible name needed a second
`data-i18n-aria` pass.

**What is not tested.** There is no headless browser in this environment, so the
viewer's behaviour is verified by hand. `test/citations.test.js` covers what can
be checked without rendering: the `data-` attributes the viewer reads, that the
`href` survives independently of them, that the frame carries no `src` in the
markup, that the container is `inert` and `aria-hidden` when closed, that every
`getElementById` in the viewer script resolves to a real element, and that the
three close paths exist. The viewer's `markClause()` is lifted out of the HTML and
run against the server's `citationPanel()` over clauses containing `&`, `<`, `>`,
`"` and `'`, plus one that is absent, so the two views of a citation cannot drift
apart; the same test asserts a passage carrying a tag produces no live element. Two
mutations were tried to confirm those tests are not vacuous: reverting
`markClause()` to the unescaped version, and escaping only the clause. Both fail
the suite.


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

A document row also carries a `status`, which is `pending` until every one of its
chunks has an embedding and `ready` after that. An ingest run that is interrupted
— killed, a PDF removed from the folder mid-run, the container restarted — leaves
the row at `pending` with a partial set of chunks. Those chunks are not searchable
and are never returned to a reader, so nothing is served wrong; the row is only
incomplete, and `npm run ingest` reports it as such.

There is no cleanup command because none is needed. The next `npm run ingest`
resumes the partial work in place, and a pending document whose PDF has left the
folder is discarded automatically (`pruneStaleDocuments` in `scripts/ingest.js`),
which is safe even when the run that created it failed. A `pending` row that
survives repeated runs means the same PDF is still there and still failing, so the
ingest log is where to look, not the database.

Worth knowing if you ever clean up by hand: `bis_chunks.doc_id` is a plain column
with no foreign key to `bis_documents` (`db/schema.sql`), so nothing cascades in
either direction and chunk rows have to be removed explicitly.

---

## 9. Settings cheat sheet

All in `.env`. The numbers that matter most:

| setting | value | meaning |
|---|---|---|
| `SIMILARITY_THRESHOLD` | 0.67 | top of the answer band |
| `SOFT_THRESHOLD` | 0.60 | where a genuine attempt starts |
| `BRIDGE_FLOOR` | 0.45 | below this, don't name any clause |
| `SHOW_NEAREST_FROM` | 0.60 | in the bridge band, don't even show the clause |
| `GEN_MIN_SUBSTANTIVE_CHARS` | 40 | shorter answers must quote the evidence |
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
# Everything, in containers (see section 12)
npm run docker:up         # pgvector + ollama + models + app
npm run docker:ingest     # (re)read the PDFs into the database
npm run docker:logs       # follow app and ollama
npm run docker:down       # stop
npm run docker:reset      # stop and DELETE the database and the model weights

# The same jobs against the stack you are already running
npm start              # run the server on port 3000
npm run dev            # same, restarting on each change
npm test               # unit tests, no network
npm run test:e2e       # full pipeline against the real local models
npm run ingest         # (re)read the PDFs into the database
npm run calibrate      # re-measure the similarity thresholds
npm run db:up          # start the database alone
```

`npm test` needs `--experimental-test-module-mocks`, which is why the test files
are listed explicitly in the script rather than globbed: the flag has to reach
the runner, and a bare `node --test` would drop it.

One trap with `mock.module()`. It only intercepts modules loaded *after* it is
registered. A static `import` at the top of the test file — even of a sibling
symbol like `resolvePdfPath` from the router under test — evaluates the whole
module graph, including the real `store.js`, before the mock is installed. The
route tests then quietly hit the real database and pass for the wrong reason: a
404 test "proves" traversal is blocked only because that `docId` genuinely is
not in `bis_documents`. Import the module under test dynamically, after
`mock.module()`, and assert that the mock was consulted (the filename-ignoring
test does this) so a silent fallback cannot pass again.

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
- **A good citation does not make a good retrieval.** A confident citation panel
  shows exactly which wrong passage was used. The English query "TDS limit" has
  surfaced a brick water-absorption clause at 0.73 similarity — inside the answer
  band. The panel makes that visible, and does nothing to prevent it. Re-ranking
  or a second retrieval pass is the fix.
- **The highlight is a first-match, not an anchor.** See section 7a.

---

## 12. Running it in Docker

The whole stack is four services in `docker-compose.yml`: `pgvector`, `ollama`, a
one-shot `models` pull, and `app`. `README.md` has the commands; this section is
the reasoning, which is mostly about things that fail silently.

**The app image is `node:22-slim`, not Alpine.** `unpdf` wraps pdf.js, which is
the one dependency here that is fussy about its JavaScript environment, and the
host is glibc. Matching it costs ~50 MB of image and removes a class of "works on
the host, not in the container" failure that would be diagnosed as a PDF bug.
`npm ci --omit=dev` is safe because the project has **zero** devDependencies and
the whole suite runs on `node:test`, so dropping dev deps costs nothing and
`npm test` still works inside the image. That is also why `test/` is not in
`.dockerignore`.

**Four environment values are overridden in `environment:`, and each is a
footgun.** `Compose`'s `environment:` outranks `env_file: .env`, and `.env`
ships pointing at `127.0.0.1` — which inside a container is the container
itself:

| value | override | why it cannot be left alone |
|---|---|---|
| `DATABASE_URL` | `@pgvector:5432` | `127.0.0.1` is the app container, not the database |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | same |
| `PDF_DIR` | `/data/pdfs` | `config.js` resolves it against `process.cwd()`, and the mount is not under `/app` |
| `OLLAMA_CONTEXT_LENGTH` | `8192` | see below |

That last one is not a tuning knob, it is correctness, and it is the failure mode
most likely to reach a demo. Ollama defaults to 4,096 and a grounded prompt here
is ~5,400-6,600 tokens. The daemon does not reject an oversized prompt for
registry models — it **silently trims the evidence and still returns HTTP 200**.
`providers/ollama.js` therefore sends `num_ctx` on every request regardless, but
the server-wide default is set to match so a hand-run client behaves the same.

**The models live in a named volume, not a bind mount of the host's store.** The
host's `/usr/share/ollama/.ollama/models` is root-owned and the app user cannot
read it, while the container runs as root — so a pull in the container writes
root-owned blobs into a store the host's systemd Ollama reads as the user
`ollama`. The result is ugly and intermittent: it works until the first new
model, then the host service cannot write its own manifest. A named volume costs
a one-time ~3 GB pull and cannot touch the host.

**The `models` service exists so first run is one command.** Without it,
`docker compose up` yields a healthy app that answers every question with a model
error, and the README has to say "now run this". `app` waits on
`service_completed_successfully` rather than merely on ordering, so a failed pull
leaves the app down with a visible reason instead of starting without a model.
Pulling a model that is already present is a no-op, so this is safe on every
`up`.

**The app's liveness probe is `/`, not `/api/health`.** `/api/health` deliberately
answers 503 when the store is unreachable or nothing is ingested — correct
behaviour, and precisely the state a fresh container is in. Probing it would mark
a healthy container unhealthy for the whole of first run.

**The corpus is mounted read-only.** The app only ever reads PDFs: ingest reads
them, the citation route streams them. No script in `scripts/` writes to disk at
all, so `USER node` in the image is free.

---

## 13. Quota, if you switch back to a hosted provider

The local default has no quota at all. This is kept because the quota shapes are
the reason the project is local, and because the failure mode returns the moment
a hosted provider is configured. Two different quotas share one key and are not
interchangeable:

| operation | free-tier limit | symptom when exceeded |
|---|---|---|
| `embedContent` / `batchEmbedContents` | ~100 **per minute**, per *item* in a batch | `429` during ingest; retried with backoff |
| `generateContent` | ~20 **per day** per model | `429` on every answer; cannot be retried away |

The daily generation cap is the one to watch. Gemini returns it as a `429` with a
`retryDelay` of ~51s, which is misleading — the quota resets the next day, not in
a minute. `src/gemini.js` detects the per-day quota id and fails immediately with
an actionable message instead of hanging. **If answers start failing with "Daily
Gemini generation quota exhausted", enable billing on the Google AI project**;
retrieval keeps working meanwhile, because embedding has its own quota and
`/api/search` still returns passages.

---

## 14. Frontend details

Kept here rather than in the README because each is a consequence of a decision
somebody had to make, and the reasoning is the useful part.

### The layout

- **The reading column is 68ch and centred.** Uncapped, the transcript ran the
  full width of a wide monitor — around 1600px of line, well past the 60-80ch
  that is comfortable to read. The composer is capped to the same measure and
  centred on the same axis, so the Ask button sits beside the answer rather than
  out in empty space. `test/ui-ux.test.js` reads the turn's copy and asserts the
  composer matches it, so the two cannot drift.
- **The composer is fixed and the document scrolls.** That is why the transcript
  cannot be scrolled with `scrollTop`, why an arriving answer is only scrolled
  into view if you were already at the bottom, and why the main column carries
  `padding-bottom` to clear the composer.
- **The header line carries counts, not titles.** It used to list every document
  title in the corpus, so the header grew with what had been ingested — four rows
  on a desktop, eight on a phone, from five PDFs. The titles are in the tooltip
  and the sidebar lists the same set.
- **Below 860px the sidebar is a drawer**, not `display: none`. It is the only
  route to passage search and to the topic list, and hiding it removed both from
  the device a standards answer is most likely read on. It opens from an "Index"
  button, closes with the × / the scrim / `Escape`, marks the rest of the page
  `inert` while open, and closes itself if the viewport widens, so a rotation
  cannot leave `inert` stuck on the app. Each long region caps itself in `vh` and
  scrolls, so search and Clear transcript stay reachable on a short window.
- **Touch targets are at least 44px at that width.** The send button was 36px and
  a sidebar row 30px.

### Colour

Every colour is a custom property, declared in four blocks: the base `:root`, a
`prefers-color-scheme: dark` override, and one `:root[data-theme='…']` per scheme
for an explicit choice. The header button cycles **system → light → dark** and
stores the choice in `localStorage`.

Two things to know before editing a colour:

- **"System" is the absence of `data-theme`, not a value.** The attribute is only
  set for a deliberate choice, so `prefers-color-scheme` keeps answering on its
  own for everyone who has not pressed the button — including on first paint,
  before any script runs, so there is no flash of the wrong theme.
- **The forced blocks restate both palettes, and that duplication is the point.**
  CSS cannot say "use the dark values" other than through a media query or a
  selector, and a media query cannot see an attribute. `:root` is specificity
  (0,1,0) and `:root[data-theme]` is (0,2,0), so a choice wins without
  `!important` and regardless of block order. `color-scheme` is pinned per block
  because no token can carry it — scrollbars, the search field and the PDF viewer
  have to follow the chosen scheme. The cost is that a colour edited in one place
  can be forgotten in another, so `test/ui-ux.test.js` diffs the forced blocks
  against the originals and measures all four with the same contrast list. **Edit
  all of them or expect the suite to fail.**

### The Quick Directory

The sidebar originally listed four hardcoded Indian Standard codes (IS 302, IS
1011, IS 14543, IS 1293) that were **not in the corpus**. That is worse than no
directory: the codes looked authoritative and clicking one produced a refusal.
The panel now queries `/api/search`, so it can only show what the vector store
actually holds, and an empty panel honestly means "not in this corpus".

Two consequences:

- **Search is debounced (350ms) and needs 3+ characters.** Every search costs one
  embedding call and `oninput` fires per keystroke — without the debounce, typing
  "hallmarking" would spend 11 calls against the ~100/min cap.
- **Directory search is English-only**, because `/api/search` embeds the query as
  typed while the indexed documents are English. The chat endpoint does
  translate, so non-English questions work there.

If the model call fails but retrieval succeeded, the response **degrades** rather
than erroring: `answer` explains that passages were found but generation failed,
the passages are still shown, and `meta.degraded` is `true`. That case is kept
distinct from `notFound` on purpose — telling a user their question is
unanswerable when the real problem is a model outage sends them off to rephrase a
question that was fine.

---

## 15. Security

`.env` is gitignored and a real key must never be committed. This repository is a
**public fork** — if a key was ever pasted into chat, logs, or a commit, rotate it
in the Google AI console before shipping.

`GET /api/documents/:docId/pdf` takes no filename from the URL. It looks the
document up by `docId`, reads `source_file` from the database, and refuses any
resolved path that escapes `config.corpus.pdfDir` (absolute paths and NUL bytes
included). The filename is never attacker-controlled, so ordinary path traversal
does not apply — the guard is a second line of defence.

The route is unauthenticated, which means it exposes the full text of every
indexed document to anyone who can reach the server. That is open by design here,
because the corpus is the product, but two consequences are worth stating:

- The full PDF is downloadable by anyone who can reach the port.
- `data/pdfs` is **not** in version control — the BIS standards are not ours to
  redistribute — and `.dockerignore` keeps them out of the image, so the corpus
  is only on disk and on the mounted volume.

Keep the port bound to localhost, or put authentication in front of it, before
exposing the app.

**Everything else is escaped.** The frontend's `innerHTML` sink makes unescaped
model output a script-injection vector, and document titles come from
user-supplied filenames. Both are escaped server-side, and `test/chunker.test.js`
asserts `<script>` and `<b>` survive only as entities.
