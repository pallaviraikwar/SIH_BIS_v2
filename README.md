# BIS RAG Assistant

Grounded question-answering over real BIS standard PDFs. Answers are written only
from retrieved clauses, cite them by document/clause/page, and **refuse** when the
corpus has nothing relevant — no invented product data, no fall-back to general
knowledge.

The frontend (`BIS_Assistant_frontend.html`) is served by this repo and is the
same document in both.

Everything runs **locally**. Generation and embedding are both Ollama models, so
there is no API key, no network dependency, and no per-request quota to run out
of mid-demo. The `GEMINI_API_KEY` and `OPEN_ROUTER_API_KEY` variables in
`.env.example` are vestigial and are not read unless a provider is switched back
on explicitly.

```
PDF ──▶ text + running-head removal ──▶ clause-aware chunking
                                             │
                                nomic-embed-text (768d, local)
                                             │
                                        pgvector (Docker)
                                             │
query ──▶ translate to English ──▶ vector + full-text search, fused by rank
                                             │
                              sarvam-1 (local) ──▶ answer + citations
```

Retrieval no longer stops at a single similarity cutoff. Scores are banded after
the search — answer / soft / bridge / miss — because the in-corpus and
out-of-corpus score distributions overlap on this corpus and no single threshold
can separate them. See [Three retrieval bands](#three-retrieval-bands).

For a plain-language walkthrough of the whole pipeline, the bugs found in it, and
the changes being made, see **[doc/architecture.md](doc/architecture.md)**.

## Setup

```bash
npm install
cp .env.example .env        # no API key needed for the local default
docker compose up -d        # pgvector on 127.0.0.1:5433
```

If Docker refuses the connection, add yourself to the group and re-login:

```bash
sudo usermod -aG docker $USER && newgrp docker
```

If your shell was already running when you joined the group, prefix Docker
commands with `sg` so they pick up the new membership without a re-login:

```bash
sg docker -c "docker compose up -d"
```

Drop BIS PDFs into `data/pdfs/`, then:

```bash
npm run ingest              # extract, chunk, embed, store
npm start                   # serves both the API and the UI on http://localhost:3000
```

One process runs everything. The server serves `BIS_Assistant_frontend.html` at
`/`, so there is no separate frontend build and no second port. Opening the file
directly from disk still works too — the page detects a `file://` origin and
falls back to an absolute API URL, so both ways of running it are supported.

Ingestion is idempotent and resumable. A document whose page and chunk counts
match what is already stored is skipped, so re-running after an interruption
only pays for the work that is actually missing. Use `npm run ingest:force` to
re-embed everything (after changing the chunker, the embedding model, or the
embedding width — stored vectors are only comparable within one of those).

`PDF_EXCLUDE` parks documents without moving them. It is a comma-separated list
of filename substrings; anything matching is left out of ingestion, and the
files stay in the folder so you can switch a document back on by editing one
line.

## Quota limits (only relevant if you switch back to a hosted provider)

The local default has no quota at all. This section is kept because the quota
shapes are the reason the project is local, and because the failure mode returns
if a hosted provider is configured. Two different quotas share one key, and they
are not interchangeable:

| Operation | Free-tier limit | Symptom when exceeded |
| --- | --- | --- |
| `embedContent` / `batchEmbedContents` | ~100 **per minute**, counted per *item* in a batch | `429` during ingest; retried with backoff |
| `generateContent` | ~20 **per day** per model | `429` on every answer; cannot be retried away |

The daily generation cap is the one to watch. Gemini returns it as a `429` with
a `retryDelay` of ~51s, which is misleading — the quota resets the next day, not
in a minute. `src/gemini.js` detects the per-day quota id and fails immediately
with an actionable message instead of hanging for minutes. **If answers start
failing with "Daily Gemini generation quota exhausted", enable billing on the
Google AI project**; retrieval keeps working meanwhile, because embedding has its
own quota and `/api/search` still returns passages.

Ingest paces itself to stay under the per-minute embedding cap, so a large
corpus takes several minutes rather than dying partway through.

## Querying

```bash
npm run ask -- "maximum moisture permitted in biscuits"
npm run ask -- "TDS limit" --lang hi        # en | hi | pa | te
```

Or over HTTP:

```bash
curl -s localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"query":"maximum moisture permitted in biscuits","lang":"en"}'
```

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | `{query, lang}` → `{answer, sources, meta}`. `answer` is HTML. |
| `GET /api/search?q=…&k=…&threshold=…` | retrieval only, no model call. Use to re-tune. |
| `GET /api/documents` | what is actually in the vector store. Backs the UI's Quick Directory. |
| `GET /api/documents/:docId/pdf` | serves the source PDF inline, so a citation link can open it. See [Citations](#citations). |
| `GET /api/documents/citable` | which documents the citation route will serve, with page counts. |
| `GET /api/health` | DB reachability, corpus size, model config. |

`answer` is HTML because the existing frontend injects it with `innerHTML`.
Model output, document titles, and clause labels are all escaped server-side
(`src/render.js`); `[[1]]` markers become citation chips and a Sources block is
appended.

### The layout

One HTML file, no build step: `BIS_Assistant_frontend.html`, served at `/`.

- **The reading column is 68ch and centred.** Uncapped, the transcript ran the
  full width of the window — around 1600px of line on a wide monitor, well past
  the 60-80ch that is comfortable to read. The composer is capped to the same
  measure and centred on the same axis, so the Ask button sits beside the answer
  rather than out in the empty space to the right of it. Both 68ch values are
  literals in the stylesheet, and `test/ui-ux.test.js` reads the turn's copy and
  asserts the composer matches it.
- **The composer is fixed and the document scrolls.** That is why the transcript
  cannot be scrolled programmatically with `scrollTop`, why an arriving answer is
  only scrolled into view if you were already at the bottom, and why the main
  column carries a `padding-bottom` to clear the composer.
- **The header line carries counts, not titles.** It used to list every document
  title in the corpus, so the height of the header grew with what had been
  ingested — four rows on a desktop and eight on a phone, from five PDFs. The
  titles are in the tooltip; the sidebar lists the same set anyway.
- **Below 860px the sidebar is a drawer**, not `display: none`. It is the only
  route to passage search and to the topic list, and hiding it removed both from
  the device a standards answer is most likely read on. It opens from an "Index"
  button in the header and closes with the × inside it, the scrim, or `Escape`;
  it marks the rest of the page `inert` while open, and it closes itself if the
  viewport widens, so a rotation cannot leave `inert` stuck on the app. The
  sidebar's two long regions each cap themselves in `vh` and scroll, so the
  search box and Clear transcript stay reachable on a short window.
- **Touch targets are at least 44px at that width.** The send button was 36px and
  a sidebar row 30px.

### Colour

Every colour in the page is a custom property, and there are four blocks that
declare them: the base `:root`, a `prefers-color-scheme: dark` override, and one
`:root[data-theme='…']` block per scheme for an explicit choice. The button in the
header cycles **system → light → dark** and stores the answer in `localStorage`.

Two things about that are worth knowing before editing a colour:

- **"System" is the absence of `data-theme`, not a value.** The attribute is only
  ever set for a deliberate choice, so `prefers-color-scheme` keeps answering on
  its own for everyone who has not pressed the button — including on the first
  paint, before any script runs, so there is no flash of the wrong theme.
- **The forced blocks restate both palettes, and that duplication is the point.**
  CSS has no way to say "use the dark values" other than a media query or a
  selector, and a media query cannot see an attribute. `:root` is specificity
  (0,1,0) and `:root[data-theme]` is (0,2,0), so a choice wins without
  `!important` and regardless of block order. `color-scheme` is pinned per block
  because no token can carry it — scrollbars, the search field and the PDF viewer
  have to follow the chosen scheme. The cost is that a colour edited in one place
  can be forgotten in another, so `test/ui-ux.test.js` diffs the forced blocks
  against the originals and measures all four with the same contrast list. Edit
  all of them or expect the suite to fail.

### Citations

Every citation is verifiable. Clicking one opens a panel over the right-hand
side of the conversation, so the answer stays on screen next to the page it
cites. The panel has three parts:

- **The passage**, at the top: the exact chunk that was sent to the model, with
  the cited clause highlighted. This is the same text, not a re-extraction, so
  what you read is genuinely what the answer was based on. It stays readable
  even if the document below fails to load.
- **The document**, in an embedded PDF viewer, opened at the cited page. The
  browser's own viewer is used, so there is no PDF.js and no extra dependency.
- **An "Open in new tab" link**, in case the embedded viewer misbehaves.

The same passage is also available under each citation as a collapsed
`+ show passage` disclosure, so the evidence is readable in the transcript
itself and the answer still makes sense with JavaScript disabled.

Close the panel with the × button, by clicking outside it, or with `Escape`. It
goes full-screen on narrow viewports, where the sidebar is a drawer and is closed
by default. The document is only fetched when you open a citation, and released
when you close it — the 7.5 MB file is never pulled in on page load.

`page_from` is a **1-based PDF page index**, not the page number printed in the
document's footer, so the two can disagree. The panel says so too.

`GET /api/documents/:docId/pdf` takes only a `docId`. The filename is read from
`bis_documents.source_file` in the database, never from the URL, and the
resolved path must stay inside `config.corpus.pdfDir`. Requests for anything
that is not an indexed, non-scanned document get a 404. Range requests are
supported, so viewers can seek inside a 7.5 MB document without downloading it
whole.

Three things to know about the embedded viewer:

- **It depends on `Content-Disposition: inline`.** The route already sends that
  because an `<iframe>` will not render a file offered as a download. Changing
  it to `attachment` — a reasonable-looking hardening — silently breaks the
  panel, which will then show a download prompt instead of the document.
- **Seeking with `#page=` inside a frame works in Chrome, Edge and Firefox. It
  is unverified in Safari**, whose in-frame PDF viewer may open at page 1. The
  passage and the "Open in new tab" link are there for exactly that case. This
  is the one thing here that needs a human to check on real hardware.
- **The panel's JavaScript has no automated test.** There is no headless
  browser and no devDependencies in this project, so what is covered is the
  server-rendered markup, the wiring, and the two properties that would
  otherwise cost a large download or trap keyboard focus. The behaviour itself
  is verified by hand.

Two things worth knowing before you deploy this publicly:

- The route is **open by design** — no auth, because the corpus is the product.
  But it also means the full PDF is downloadable by anyone who can reach the
  server.
- `data/pdfs` is **not** in version control. The BIS standards are not ours to
  redistribute, so keep the route bound to localhost or put authentication in
  front of it if you expose the app.

### The Quick Directory

The sidebar originally listed four hardcoded Indian Standard codes (IS 302,
IS 1011, IS 14543, IS 1293) that were **not in the corpus**. That is worse than
no directory: the codes looked authoritative, and clicking one produced a
refusal. The panel now queries `/api/search`, so it can only show what the
vector store actually holds, and an empty panel honestly means "not in this
corpus" rather than "ask anyway".

Two consequences worth knowing:

- **Search is debounced (350ms) and needs 3+ characters.** Every search costs one
  embedding call, and `oninput` fires per keystroke — without the debounce,
  typing "hallmarking" would spend 11 calls against the ~100/min free-tier cap.
- **Directory search is English-only**, because `/api/search` embeds the query
  as typed while the indexed documents are English. The chat endpoint does
  translate, so non-English questions work there. Translating the sidebar too
  would add a generation call per search.

If the model call fails but retrieval succeeded, the response degrades rather
than erroring: `answer` explains that passages were found but generation failed,
the passages are still shown, and `meta.degraded` is `true`. That case is kept
distinct from `notFound` on purpose — telling a user their question is
unanswerable when the real problem is a model outage sends them off to rephrase
a question that was fine.

## Why the pipeline is built this way

**768 dimensions, not 3072.** pgvector's HNSW and IVFFlat indexes cannot exceed
2000 dimensions, and Gemini's default embedding width is 3072. `EMBED_DIMS=768`
stays inside the limit. The local model is normalised explicitly — otherwise
cosine similarity is silently wrong. The width is asserted on every response and
at startup, so a model change fails loudly instead of corrupting the index.

**768 is also the model's native width, so nothing is being truncated.** Ollama's
`dimensions` parameter must be *lower* than native, so it is not sent at all.

### Three retrieval bands

**A single threshold is not enough, and that is a measured result rather than a
preference.** Calibrated against this repo's own corpus (1 document, 3,445 chunks):

| | top-1 similarity |
| --- | --- |
| in-corpus questions | 0.677 – 0.826 (median 0.767) |
| off-topic questions | 0.466 – 0.708 (median 0.565) |

The distributions **overlap** between 0.677 and 0.708. There is no number that
separates them, so any threshold placed in that window is a coin flip decided by
the constant rather than by the evidence — and two real cases showed it.
"fly ash", a genuine question about a material the document covers, scored 0.668
and missed a 0.67 bar by 0.002. Meanwhile "tell me about the plastics" scored
into the answer band with nothing behind it at all.

So nothing is cut off in SQL any more. Retrieval fetches down to `BRIDGE_FLOOR`
and the score is banded afterwards:

| Band | Range | Behaviour |
| --- | --- | --- |
| `answer` | ≥ 0.67 | the clause is handed to the model |
| `soft` | 0.60 – 0.67 | the model is asked to answer **or decline**; a decline falls back to the bridge |
| `bridge` | 0.45 – 0.60 | "no X, but the closest thing is Y, clause Z" |
| `miss` | < 0.45 | echo the query, offer topics parsed out of the corpus |

`softThreshold` sits above the out-of-corpus median (0.565) and below the
in-corpus minimum (0.677), so most real questions reach the model and the flat
refusal band is narrow. A wrong answer is still worse than no answer, so the
residual overlap is handled by letting the model decline rather than by moving
the threshold.

These values are corpus- and model-specific. `npm run calibrate` re-measures them;
they do not transfer between embedding models.

Re-measure with
`curl "localhost:3000/api/search?q=…&k=8&threshold=0"` after changing the model,
the width, or the corpus. A concrete example of why that matters: at 0.55 an
off-topic product question ("maximum moisture in biscuits", scoring 0.563)
cleared the bar and would have been answered from unrelated regulatory text.

**Chunks break on clause boundaries.** With a 1200-char budget a whole page
fits in one chunk, which would drag clauses 1 through 5.2 together and force a
moisture answer to cite "cl. 1". `src/chunker.js` seals a chunk at each clause
or annex heading, so a requirement is citable on its own. A chunk is never
split across a page break, and a chunk shorter than twice the overlap target
carries **no** overlap — otherwise a short paragraph gets recycled in full and
every later chunk opens with the same text, which wastes context and makes
unrelated chunks look alike to the vector search.

**Table rows are not clause headings.** Real BIS documents are full of tables
whose rows start with a number — "6. IS 158:2015 1 litre … Rs 60,000.00 …". The
clause regex cannot tell that from a real "6.2 Packaging" heading, so each row
was flushed into its own ~85-character chunk and cited as "cl. 6". Across the two
fee-schedule PDFs in `data/pdfs` that produced 4,126 near-worthless fragments,
each costing an embedding call. Rows are now detected by figures dominating the
block (currency markers, several numeric tokens, digits taking a large share of
the text) and are treated as ordinary prose. Letter density alone is not enough:
Devanagari glyphs count as letters, so Hindi fee rows sit at ~0.75 density,
indistinguishable from English prose by that measure. Verified: 0 of 536 English
chunks are affected, and the total corpus drops from 6,224 to 3,199 chunks.

**Translate queries, not answers.** Non-English questions are rendered into
English technical phrasing for retrieval, then the answer is generated directly
in the target language. Translating the answer would round-trip the citations
and blur numeric limits; generating natively keeps IS codes, clause numbers,
units, and limits in their original English form.

**The query text decides the language, never a flag.** The frontend sends
`lang: 'auto'` and the server reads the script off the query. Two rules keep that
honest, both learned the hard way:

- `'auto'` is not in `SUPPORTED_LANGS` (it also feeds `normaliseLang()` and the
  i18n table checks, which need real languages), so the route maps it explicitly
  and `resolveLang()` is unit-tested. A route that quietly rewrote `'auto'` to
  `'en'` produced Hindi questions answered in Hindi while the UI was in English.
- An explicit `lang: 'en'` sent alongside Devanagari or Telugu is treated as a
  stale client and ignored. `'en'` plus a clear non-Latin script is never a
  considered choice — a caller wanting English can write the question in English.

**A short reply has to justify itself.** `isSubstantive()` requires an answer
below 40 characters to quote a number or content word from the passages it was
given, or it is retried and then discarded in favour of the retryable notice.
Length alone is deliberately not the test: `"43.0 MPa"` is a complete answer to a
strength question, and rejecting it would be worse than the bug being fixed.

**Everything is escaped.** The frontend's `innerHTML` sink makes unescaped model
output a script-injection vector, and document titles come from user-supplied
filenames. Both are escaped, and `test/chunker.test.js` asserts `<script>` and
`<b>` survive only as entities.

## Tests

```bash
npm test          # unit tests, no network
npm run test:e2e  # real local Ollama, in-memory store, no Docker needed
```

The e2e suite mocks only the store, so embedding, retrieval, translation,
grounding, and HTML rendering all run for real. It asserts a grounded answer, a
correct refusal for an out-of-corpus question, and a Hindi answer with English
citations.

`test/directory.test.js` loads the actual `<script>` out of the HTML and drives
it against a stub DOM, so the frontend is tested as shipped rather than through
a reimplementation. It pins the behaviours that are easy to regress silently:
that a burst of keystrokes costs one embedding call, that a late response cannot
overwrite a newer one, that document text is escaped before `innerHTML`, and
that no hardcoded standard codes creep back in.

`test/retrieval.test.js` covers the banding and fusion logic directly — the band
boundaries, the RRF order, identifier promotion for a bare `IS 456`, and the
clause-title repair. It runs in-process with no model calls.

`test/chat-route.test.js` mocks the model to pin the route's half of the
language contract — that `'auto'` survives, that an absent `lang` is not read as
English, and that the canned error copy is always keyed by a real language. This
exists because a bug lived in that line alone, and every other test called
`answerQuestion()` directly and so could not have caught it.

`test/substance.test.js` covers the short-answer gate against the real clause
wording from the reported failure, including the case a length check would get
wrong.

Neither suite costs API quota. Both talk only to local models, so they can be run
in a loop; the e2e suite is the slow one because it loads and runs real models.

## Known limitations

- **The corpus is SP 21 only**, the summaries of Indian Standards for building
  materials — 929 pages, 3,445 chunks, one document. It contains cement, concrete,
  steel, timber, paint, and packaged-drinking-water limits, but it *summarises*
  standards rather than reproducing them, and it has nothing outside that scope.
  A question about biscuits (IS 1011) is therefore correctly refused; a question
  about packaged drinking water TDS retrieves the real clause. The threshold
  measurements above were taken on this corpus and must be re-run after adding
  documents.
- **The generator will state a limit that the clause contradicts.** The most
  serious remaining defect, and it is a model-quality problem rather than a
  pipeline one. Asked for the TDS limit in packaged drinking water, sarvam-1
  answered *"कोई विशिष्ट सीमा नहीं दी गई है"* — "no specific limit is given" —
  while the clause it had been handed read *"Total dissolved solids shall not
  exceed 2000 mg per litre"*. Retrieval was correct; the model contradicted it.
  A confident wrong answer is worse than a refusal, and the substance gate does
  not catch this one because the reply is long enough and contains no number to
  cross-check. Fixing it properly needs a stronger generator or a
  contradiction check against the retrieved clause, not a length heuristic.
- **Two Hindi PDFs are excluded via `PDF_EXCLUDE`.** `BIS_CA_12032019.pdf` and
  `BIS_CA_Amendment_Regulations_2020.pdf` are Devanagari fee-schedule tables whose
  extracted text has corrupted glyph ordering ("क ाक.र्ग्ा."). They would supply
  the majority of the corpus's chunks while being the least retrievable. Clear
  `PDF_EXCLUDE` to index them anyway.
- **Scanned PDFs are not OCR-ed.** `listofproducts.pdf` is a pure scan (22 blank
  pages) and is skipped rather than silently ingested as one junk chunk. It
  needs OCR before it is useful.
- **A citation highlight can land on a numeric coincidence.** The highlighted
  span is the first literal occurrence of the clause label in the passage. For a
  label like `15` that sits among other numbers, the match can be an unrelated
  figure rather than the requirement itself — one TDS query highlighted
  `15 percent` from a water-absorption clause. The clause label is present
  verbatim in ~91.5% of chunks, so the panel usually disambiguates it by
  surrounding text, but the highlight is a convenience and not proof.
- **English retrieval for "TDS limit" can miss.** That question has surfaced a
  brick water-absorption clause at 0.73 similarity — inside the answer band,
  confidently wrong. It is a retrieval weakness rather than a citation bug, and
  it is the clearest argument for re-ranking or a second retrieval pass.
- **Thresholds are model- and corpus-specific.** See the measurements above.
- **Clause detection is heuristic**, tuned on Indian Standards layout. Documents
  that number requirements unusually may cite a parent clause (e.g. "cl. 5" for
  text under 5.1) rather than the exact subclause.
- **Single corpus, single embedding space.** No re-ranking or hybrid search yet.

## Security

`.env` is gitignored and never commit a real key. This repository is a **public
fork** — if a key was ever pasted into chat, logs, or a commit, rotate it in the
Google AI console before shipping.

`GET /api/documents/:docId/pdf` takes no filename from the URL: it looks the
document up by `docId`, reads `source_file` from the database, and refuses any
resolved path that escapes `config.corpus.pdfDir` (including absolute paths and
NUL bytes). The filename is never attacker-controlled, so the usual path
traversal does not apply — the guard is there as a second line of defence. The
route is unauthenticated, so it exposes the full text of every indexed document
to anyone who can reach the server.
