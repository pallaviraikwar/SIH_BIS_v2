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
| `GET /api/health` | DB reachability, corpus size, model config. |

`answer` is HTML because the existing frontend injects it with `innerHTML`.
Model output, document titles, and clause labels are all escaped server-side
(`src/render.js`); `[[1]]` markers become citation chips and a Sources block is
appended.

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

It costs API quota — several `generateContent` calls — so it will fail on the
free tier's ~20-per-day generation cap. Run it deliberately, not in a loop.

## Known limitations

- **The current corpus is regulatory, not product.** `data/pdfs` holds
  regulations, rules, gazette notifications and a recruitment rule — no biscuits,
  cement, or food limits. Product questions are therefore *correctly* refused
  (verified: "maximum moisture content in biscuits" and "28 day compressive
  strength of cement mortar" both return zero passages). The pipeline is working;
  the corpus just has nothing to answer. Add real product standards to make
  product queries return grounded answers.
- **Two Hindi PDFs are excluded via `PDF_EXCLUDE`.** `BIS_CA_12032019.pdf` and
  `BIS_CA_Amendment_Regulations_2020.pdf` are Devanagari fee-schedule tables whose
  extracted text has corrupted glyph ordering ("क ाक.र्ग्ा."). They would supply
  the majority of the corpus's chunks while being the least retrievable. Clear
  `PDF_EXCLUDE` to index them anyway.
- **Scanned PDFs are not OCR-ed.** `listofproducts.pdf` is a pure scan (22 blank
  pages) and is skipped rather than silently ingested as one junk chunk. It
  needs OCR before it is useful.
- **Thresholds are model- and corpus-specific.** See the measurements above.
- **Clause detection is heuristic**, tuned on Indian Standards layout. Documents
  that number requirements unusually may cite a parent clause (e.g. "cl. 5" for
  text under 5.1) rather than the exact subclause.
- **Single corpus, single embedding space.** No re-ranking or hybrid search yet.

## Security

`.env` is gitignored and never commit a real key. This repository is a **public
fork** — if a key was ever pasted into chat, logs, or a commit, rotate it in the
Google AI console before shipping.
