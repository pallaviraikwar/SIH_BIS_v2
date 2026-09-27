# BIS RAG Assistant

Grounded question-answering over real BIS standard PDFs. Answers are written only
from retrieved clauses, cite them by document, clause and page, and **refuse**
when the corpus has nothing relevant — no invented product data, no falling back
to general knowledge. Ask in English, Hindi, Punjabi or Telugu.

Everything runs on your own machine. Generation and embedding are both local
models, so there is no API key, no network dependency and no quota to run out of
mid-demo.

## Prerequisites

- **Docker**, with Compose **v2.24.0 or later**. Not just any v2: `docker-compose.yml`
  uses `env_file: required: false`, and that field does not exist before 2.24.0. On
  anything older `docker compose up` fails to parse the file and blames the file
  rather than your Compose version.
- **Node 22+**, only for the no-Docker path.
- About **3 GB of disk** for the model weights on first run.
- **8 GB of RAM**. The three models sit resident together at ~4.1 GB; a machine
  with less will start and then get OOM-killed mid-answer.

Check Docker actually works for your user before anything else:

```bash
docker ps
```

`permission denied while trying to connect to the docker API` means you are not in
the `docker` group. Fix it once:

```bash
sudo usermod -aG docker $USER
newgrp docker          # or log out and back in
docker ps              # must now work without sudo
```

## Install and run

Put the BIS PDFs you have in **`data/pdfs/`** first. They are gitignored, because
the standards are not ours to redistribute, so a fresh clone has an empty folder and
ingest will have nothing to read.

### One command

```bash
git clone https://github.com/pallaviraikwar/SIH_BIS_v2.git
cd SIH_BIS_v2
./run.sh
```

`run.sh` does the whole first run: checks Docker, creates `.env`, builds and starts
all four containers, **waits for each one to actually be ready** rather than
assuming, pulls the models, ingests your PDFs if the corpus is empty, then prints
the health report and the URL. It is idempotent — run it again whenever and it
repairs what is missing instead of starting over.

It also fixes the two things that most often derail this by hand: not telling you
the stack is up while Postgres is still initialising, and not noticing that port
5433 is already taken.

| | |
| --- | --- |
| `./run.sh --status` | what is running, and the health report. Changes nothing. |
| `./run.sh --logs` | follow the app and Ollama logs |
| `./run.sh --stop` | stop the stack, keep the data |
| `./run.sh --reset` | stop and **delete** the database and the model weights |
| `./run.sh --smoke` | also ask one real question, end to end |
| `./run.sh --force-ingest` | re-embed even though the corpus is non-empty |
| `./run.sh --skip-ingest` | bring the stack up and stop there |

Then open **http://localhost:3000**.

### Doing it by hand

```bash
cp .env.example .env          # no API key to fill in — the defaults are local
npm run docker:up             # or: docker compose up -d --build
npm run docker:ingest         # extract, chunk, embed, store
```

The first `docker:up` pulls ~3 GB of models and takes a few minutes. Later starts
take seconds. Four containers come up: `pgvector` (the store), `ollama` (the
models), `models` (a one-shot pull that then exits), and `app`.

Everything above is also available as plain `docker compose` commands — the npm
scripts just save you typing. `npm run docker:logs` to watch, `npm run
docker:down` to stop, `npm run docker:reset` to stop **and delete** the database
and the model weights.

### On Windows

`run.sh` needs a POSIX shell, and the Docker it talks to has to be the one inside
WSL. From PowerShell that is one line:

```powershell
wsl -d Ubuntu -- bash -lc "cd <wsl-path>/SIH_BIS_v2 && ./run.sh"
```

`<wsl-path>` is the path as WSL sees it — `/home/you/...` for a repo on the WSL
filesystem, or `/mnt/c/Users/you/...` for a repo cloned on the Windows side. Do not
paste a `C:\...` path; WSL cannot use it.

Git Bash is not a substitute. It is a Windows shell with no route to the WSL Docker
daemon, so the script would run and then fail on every single `docker` call. There
is nothing Windows-native to point it at — the stack, the database and the model
weights all live inside WSL. Docker Desktop plus the manual `docker compose`
commands above also work fine on Windows; only the wrapper is Linux-only.

### Without Docker

The only thing that needs a container is Postgres, and only it:

```bash
npm install
cp .env.example .env
npm run db:up                # pgvector alone, on 127.0.0.1:5433
ollama serve                 # must already be running; see .env.example for the models
npm run ingest
npm start                    # http://localhost:3000
```

## Verify it works

```bash
curl -s localhost:3000/api/health
```

You want `"status":"ok"` and a non-zero `corpus.chunkCount`. Note that this
endpoint answers **503** when the store is unreachable or nothing has been
ingested — that is the endpoint working correctly, not the check failing. Read
the `warnings` array; it names the problem.

Then ask something, over HTTP:

```bash
curl -s localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"query":"maximum moisture permitted in clay bricks","lang":"auto"}'
```

A grounded answer comes back with a Sources block naming the document, clause and
page. Ask something outside the corpus — "maximum moisture permitted in biscuits" —
and you should get a refusal that names what *is* indexed, which is the behaviour
that matters more than the answer.

## Use it

```bash
npm run ask -- "maximum moisture permitted in biscuits"
npm run ask -- "TDS limit" --lang hi        # en | hi | pa | te
```

| Endpoint | Purpose |
| --- | --- |
| `POST /api/chat` | `{query, lang}` → `{answer, sources, meta}`. `answer` is HTML. |
| `GET /api/search?q=…&k=…&threshold=…` | retrieval only, no model call. Use to re-tune. |
| `GET /api/documents` | what is in the vector store. Backs the sidebar's index. |
| `GET /api/documents/:docId/pdf` | serves the source PDF inline, opened at the cited page. |
| `GET /api/documents/citable` | which documents the citation route will serve. |
| `GET /api/health` | DB reachability, corpus size, active models. |

Click any citation in an answer to see the exact passage that was read, with the
cited document open beside it at the right page. `page_from` is the **1-based PDF
page index**, not the folio printed in the footer, so the two can disagree; the
panel says so too.

## Troubleshooting

**`docker ps` gives a permission error.** You are not in the `docker` group — see
Prerequisites. Nothing in this project will work until that is fixed.

**`docker compose up` fails with "port 5433 is already allocated".** Something
else on this machine is listening there — check `ss -ltnp | grep 5433`. Start the
stack on a different host port with `PG_HOST_PORT=5434 docker compose up -d`.
Only the host side moves; the app still reaches the database at `pgvector:5432`,
so nothing else changes.

**The container database is empty even though the app was working before.** A
Docker volume and a Postgres you installed natively are different databases. The
container's `bis_pgdata` volume starts empty, so run `npm run docker:ingest`. If
you would rather keep using the Postgres you already have, stay on the no-Docker
path — it only needs Postgres, and the app works against either.

**Answers fail with a model or connection error, but `/api/health` is `ok`.** The
app cannot reach Ollama. Check `npm run docker:logs` for the `ollama` service, and
confirm the models arrived: `docker compose exec ollama ollama list`. All three of
`nomic-embed-text`, `MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M` and
`mashriram/sarvam-1` need to be there.

**Answers come back truncated, generic, or citing a passage that is not in the
Sources block.** Check `OLLAMA_CONTEXT_LENGTH` is `8192`. Ollama's default is 4096
and a grounded prompt here is ~5,400-6,600 tokens; the daemon does not reject an
oversized prompt, it trims the evidence and still returns HTTP 200, so this fails
silently. Both the app and the `ollama` service set it in `docker-compose.yml`.

**`/api/health` says `degraded` and names no chunks.** Ingest has not been run, or
ran against an empty `data/pdfs`. The corpus is not in version control, so a fresh
clone has nothing to read.

**A document is skipped with a warning about being a scan.** Scanned PDFs have no
text layer, so ingestion skips them rather than storing one useless chunk. It
needs OCR first.

**A document you expected is not in the sidebar.** `PDF_EXCLUDE` in `.env` parks
documents without moving them. Clear the line and re-run `npm run ingest:force`.

**The corpus is mostly garbled Hindi fragments.** The `BIS_CA_*` files are Devanagari
fee-schedule tables whose extracted text has corrupted glyph ordering. Add them to
`PDF_EXCLUDE` — they would otherwise supply most of the corpus and retrieve worst.

**Ingest resumes rather than starting over.** That is deliberate. It is idempotent
and resumable, and a document whose page and chunk counts already match is
skipped. Use `npm run ingest:force` to re-embed everything — required after
changing the chunker, the embedding model, or the vector width, because stored
vectors are only comparable within one of those.

## Configuration

Everything is in `.env`, and `.env.example` documents each value in place. The ones
people actually change:

| setting | default | when to change it |
| --- | --- | --- |
| `PDF_DIR` | `./data/pdfs` | where the PDFs are |
| `PDF_EXCLUDE` | `listofproducts` | comma-separated filename substrings to skip |
| `DATABASE_URL` | `…@127.0.0.1:5433/bis_rag` | in Docker this is overridden to the service name |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | in Docker this is overridden to `http://ollama:11434` |
| `SIMILARITY_THRESHOLD` | `0.67` | after adding documents or changing the model — re-measure, do not guess |
| `GEN_MODEL` / `EMBED_MODEL` | local Ollama | see `.env.example` for what each requires |

`.env` is gitignored. Never commit a real key. This repository is a public fork,
so if a key ever reaches chat, logs or a commit, rotate it before shipping.

## Tests

```bash
npm test          # 274 tests, no network, ~5s
npm run test:e2e  # real local models against an in-memory store
```

Both talk only to local models, so neither costs quota and both can run in a
loop. `test:e2e` is the slow one — it loads and runs real models, and it is what
proves grounding, refusal and the Hindi-with-English-citations path still work.
In Docker they are `npm run docker:test` and `npm run docker:test:e2e`.

## How it works, and why

The reasoning behind the pipeline — the three retrieval bands and the measured
overlap that forces them, the model split, the bugs found in it and what they cost
— lives in **[doc/architecture.md](doc/architecture.md)**, along with the
citations design, the settings cheat sheet, the colour system and the known
limits. This file is deliberately just how to install, run and use it.
