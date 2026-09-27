# BIS RAG Assistant

Grounded question-answering over real BIS standard PDFs. Answers are written only
from retrieved clauses, cite them by document, clause and page, and **refuse**
when the corpus has nothing relevant — no invented product data, no falling back
to general knowledge. Ask in English, Hindi, Punjabi or Telugu.

Everything runs on your own machine. Generation and embedding are both local
models, so there is no API key, no network dependency and no quota to run out of
mid-demo.

## Quick start

```bash
git clone https://github.com/pallaviraikwar/SIH_BIS_v2.git
cd SIH_BIS_v2

./scripts/ollama-host-setup.sh     # once; asks for your sudo password
./run.sh
```

Then open **http://localhost:3000**.

The repository ships the corpus — five BIS PDFs and a prepared index of 5,063
chunks — so there is nothing to download and nothing to ingest.

### What to expect

| | |
| --- | --- |
| `./scripts/ollama-host-setup.sh` | Pulls **4.6 GB** of model weights. Seconds if you already have them, otherwise however long that takes on your connection. The only step needing `sudo`. |
| first `./run.sh` | Builds the app image once: ~10 s if `node:22-slim` is already cached, longer on a machine that never has. |
| every later `./run.sh` | **~25 s** to a working app, restoring the prepared index rather than re-embedding. |
| answering a question | ~10–20 s. Generation is a 2B model on CPU. |

`./scripts/ollama-host-setup.sh --check` prints what is present and changes
nothing; it must exit 0. That step cannot be skipped or worked around, and the
symptom of skipping it is a healthy `/api/health` followed by every answer
failing — see [Models on the host](#models-on-the-host).

`.env` is not in the commands because you should not create it. `run.sh` makes it
from `.env.example`, and every default is local, so there is no key to add.

## Prerequisites

- **Docker**, with Compose **v2.24.0 or later**. Not just any v2: `docker-compose.yml`
  uses `env_file: required: false`, and that field does not exist before 2.24.0. On
  anything older `docker compose up` fails to parse the file and blames the file
  rather than your Compose version.
- **Node 22+**, only for the no-Docker path.
- **Ollama on the host**, and three models in it. The models run on your machine,
  not in a container — see [Models on the host](#models-on-the-host).
- About **4.6 GB of disk** for the model weights on first run.
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

What ships in the clone, and why:

- **`data/pdfs/`** — five BIS documents, 17 MB
- **`index-snapshots/`** — the matching prepared index, 19 MB

That is deliberate. It means the demo is `./run.sh` and nothing else, with no
corpus to assemble first. See [The corpus](#the-corpus) for what is in it and
[Sharing a prepared index](#sharing-a-prepared-index) to export your own from a
different set of documents.

If you would rather start from your own standards, replace `data/pdfs/` and run
`./run.sh --no-snapshot` to ingest them from scratch.

`run.sh` does the whole first run: checks Docker and Ollama, creates `.env`, builds
and starts the two containers, **waits for each one to actually be ready** rather
than assuming, then fills the corpus — from a prepared index if there is a
compatible one, otherwise by ingesting your PDFs — and finally prints the health
report and the URL. It is idempotent: run it again whenever and it repairs what is
missing instead of starting over.

It also fixes the two things that most often derail this by hand: not telling you
the stack is up while Postgres is still initialising, and not noticing that port
5433 is already taken.

| | |
| --- | --- |
| `./run.sh --status` | what is running, and the health report. Changes nothing. |
| `./run.sh --logs` | follow the app logs |
| `./run.sh --stop` | stop the stack, keep the data |
| `./run.sh --reset` | stop and **delete** the database volume. Model weights on the host are untouched. |
| `./run.sh --smoke` | also ask one real question, end to end |
| `./run.sh --force-ingest` | re-embed even though the corpus is non-empty |
| `./run.sh --skip-ingest` | bring the stack up and stop there |
| `./run.sh --import-snapshot` | only load a prepared index, never fall back to ingest |
| `./run.sh --no-snapshot` | ignore `index-snapshots/` and ingest from the PDFs |

### Doing it by hand

```bash
./scripts/ollama-host-setup.sh  # once, needs sudo
cp .env.example .env            # no API key to fill in — the defaults are local
npm run docker:up               # or: docker compose up -d --build
npm run docker:ingest           # extract, chunk, embed, store
```

Two containers come up: `pgvector` (the store) and `app`. Ollama is already
running on the host, so the first `docker:up` only builds the app image.

Everything above is also available as plain `docker compose` commands — the npm
scripts just save you typing. `npm run docker:logs` to watch, `npm run
docker:down` to stop, `npm run docker:reset` to stop **and delete** the database
volume. The model weights live on the host and no Compose command touches them.

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

## Models on the host

Ollama runs on your machine, not in a container. The weights are 4.6 GB; in a
Compose volume they would be at the mercy of a stray `docker compose down -v` and
would be re-downloaded on every new machine that may already have them.

Install the three models this project needs, and make Ollama reachable from the
container, in one step:

```bash
./scripts/ollama-host-setup.sh
```

It writes a systemd drop-in, restarts Ollama, pulls whatever is missing, and then
verifies. It needs `sudo` once. Re-run it any time; it is safe and it will not
re-download what you have.

| | |
| --- | --- |
| `./scripts/ollama-host-setup.sh --check` | report what is present, change nothing |
| `./scripts/ollama-host-setup.sh --revert` | undo the systemd change |

**It also exposes Ollama to your whole network.** The drop-in sets
`OLLAMA_HOST=0.0.0.0`, and Ollama has no authentication of its own — anything that
can reach port 11434 can read your models and run them. That is the only way a
container can reach a host service, so on a shared or untrusted network use
`--revert` afterwards, or reach Ollama over a Tailscale/WireGuard interface
instead.

The container reaches the host as `host.docker.internal`, mapped through
`extra_hosts: host-gateway`. `run.sh` tests this from inside a container rather
than assuming it, because a loopback-only Ollama looks perfectly healthy from your
shell and still fails from the app.

If you would rather not touch systemd, any equivalent works: bind Ollama to
`0.0.0.0:11434` yourself and set `OLLAMA_BASE_URL` in `.env` to an address the
container can reach.

## Sharing a prepared index

Ingesting a few thousand chunks on CPU takes 5-20 minutes. Doing it once and
carrying the result is a much better deal, so the project can export its whole
index as a self-contained directory.

```bash
npm run index:export                  # -> index-snapshots/<stamp>-<model>-<dims>/
```

You get roughly 19 MB for 5,063 chunks, containing every vector, plus a
`manifest.json` that records which embedding model produced them, the chunking
settings, a SHA-256 for every file, and the name, size and digest of each source
PDF. Copy the directory to whoever needs it, and on their machine:

```bash
./run.sh --import-snapshot
```

That is the entire install. `run.sh` does it automatically when the corpus is
empty, so usually you need to do nothing at all.

`index-snapshots/LATEST` names which bundle to use. It is a plain text file, not a
symlink, because symlinks do not survive being zipped and copied around.

**The bundle contains no PDFs**, and that is deliberate — it would be 17 MB on top
of the 19 MB of vectors, and a bundle meant to be handed around should not drag the
source documents with it. So on a machine that has not got the corpus, answers are
still fully grounded but clicking a citation will not open anything. The import
tells you which documents are affected. Drop the PDFs into `data/pdfs/` and the
links resolve. This repository ships both, so a clone gets working links.

Three things about a bundle are worth knowing:

- **It refuses a model mismatch.** If `.env` names a different embedding model or
  vector width, the import stops before writing anything. Vectors from two
  unrelated models are not comparable, and a corpus that mixes them answers
  confidently and wrongly. `run.sh` then falls back to ingesting from the PDFs,
  so the mismatch costs you time rather than correctness.
- **It verifies every checksum** before it touches the database, so a truncated
  download is caught rather than imported as a corpus that is quietly missing
  documents.
- **It is idempotent.** Loading the same bundle twice changes nothing. To replace
  an index built by a different model, `npm run index:import -- --replace`.

This repository tracks exactly one bundle — the one matching its corpus. Further
exports are gitignored, so re-running `index:export` never quietly stages another
19 MB. To keep a second one, negate it in `.gitignore` first.

## The corpus

Five BIS documents, committed so that a clone works out of the box.

| Document | Pages | What it covers |
| --- | --- | --- |
| SP 21 — Summaries of Indian Standards for Building Materials | 929 | brick, mortar and concrete properties; the richest source in the corpus |
| BIS CA 12032019 | 412 | Devanagari fee schedule — largely tables, and the source of the garbled-Hindi problem in Troubleshooting |
| BIS Hallmarking Regulations 2018 (Incorp. Amdt 1) | — | precious-metal hallmarking |
| The Bureau of Indian Standards Act, 2016 | — | the BIS Act itself |
| GoL Guidelines 01052019 | — | guidelines of legislation |

The two that are BIS *publications* rather than government gazette documents —
SP 21 and the CA 12032019 fee schedule — are here for a working demo. If you extend
this project or publish it further, check the position on redistribution before
adding a sixth.

Two things follow from the corpus being real rather than synthetic, and both are
visible in the output:

- **`BIS_CA_12032019` retrieves badly.** Its extracted text has corrupted glyph
  ordering, so it matches questions it should not. `PDF_EXCLUDE` in `.env` parks
  it; see Troubleshooting.
- **Answers sometimes name the wrong property.** SP 21's brick clauses sit close
  together, so a question about efflorescence can return a passage about
  compressive strength. This is a retrieval-quality issue, not a plumbing one, and
  the thresholds in `.env` are the lever.

`./run.sh --smoke` asks one real question end to end so you can see both the
grounding and this.

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

**`./run.sh` exits with "start Ollama first, then re-run."** You skipped
`./scripts/ollama-host-setup.sh`, which is the one step in the quick start that
cannot be worked around. It pulls the models and makes the Ollama daemon
reachable from the container. Run it, then re-run `./run.sh`; nothing you have
already done is lost.

**`docker ps` gives a permission error.** You are not in the `docker` group — see
Prerequisites. Nothing in this project will work until that is fixed.

**`docker compose up` fails with "port 5433 is already allocated".** Something
else on this machine is listening there — check `ss -ltnp | grep 5433`. Start the
stack on a different host port with `PG_HOST_PORT=5434 docker compose up -d`.
Only the host side moves; the app still reaches the database at `pgvector:5432`,
so nothing else changes.

**The container database is empty even though the app was working before.** A
Docker volume and a Postgres you installed natively are different databases. The
container's `bis_pgdata` volume starts empty. Either put a prepared index in
`index-snapshots/` and run `./run.sh --import-snapshot`, or `npm run
docker:ingest`. If you would rather keep using the Postgres you already have,
stay on the no-Docker path — it only needs Postgres, and the app works against
either.

**Ollama is running, but the app says it cannot reach it.** Almost always the
binding. Ollama listens on `127.0.0.1` by default, and a container has no
interface to loopback on the host, so the app cannot connect no matter how healthy
Ollama looks from your shell. `./scripts/ollama-host-setup.sh --check` says which
of the two cases you are in. `./scripts/ollama-host-setup.sh` fixes it, and
`--revert` puts it back.

**A prepared index was rejected: "embedding model differs".** The bundle was built
with a different `EMBED_MODEL` than your `.env` has. Vectors from two models
cannot be compared, so this is refused on purpose. Either set `EMBED_MODEL` in
`.env` to what the bundle's `manifest.json` says, or ignore the bundle and ingest
your own PDFs with `./run.sh --no-snapshot`.

**`./run.sh` ignored my index-snapshots bundle.** It only loads one when the
corpus is empty, unless you pass `--force-ingest`, which deliberately rebuilds
instead. `npm run index:import -- --dir index-snapshots/<name>` runs it on demand
and prints exactly what it refused and why.

**Answers fail with a model or connection error, but `/api/health` is `ok`.** Ollama
runs on the host, so there is no `ollama` service to read logs from. Check
`ollama list` — `nomic-embed-text`, `MedAIBase/Tencent-HY-MT1.5:1.8b-q4_K_M` and
`mashriram/sarvam-1` all need to be there — and `./scripts/ollama-host-setup.sh
--check` for reachability from the container.

**Answers come back truncated, generic, or citing a passage that is not in the
Sources block.** Check `OLLAMA_CONTEXT_LENGTH` is `8192`. Ollama's default is 4096
and a grounded prompt here is ~5,400-6,600 tokens; the daemon does not reject an
oversized prompt, it trims the evidence and still returns HTTP 200, so this fails
silently. `scripts/ollama-host-setup.sh` sets it in the host's systemd drop-in.

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

## Deployment

This is built to run on your own machine, and that is where it should stay. Two
things are worth knowing before you put it anywhere else:

- **Ollama must be reachable from the container**, so `scripts/ollama-host-setup.sh`
  binds it to `0.0.0.0`. Ollama has no authentication, so that exposes your models
  to everything that can reach port 11434. On an untrusted network, run
  `--revert` and reach Ollama over a private interface instead.
- **`/documents/:docId/pdf` serves the source PDFs to anyone who can reach the
  app.** That is the correct behaviour locally — verifying a citation is the whole
  point of the feature — but on a public host it republishes the standards. Put it
  behind authentication, or accept that it is public, deliberately.

## Configuration

Everything is in `.env`, and `.env.example` documents each value in place. The ones
people actually change:

| setting | default | when to change it |
| --- | --- | --- |
| `PDF_DIR` | `./data/pdfs` | where the PDFs are. In Docker this is `/data/pdfs`. |
| `PDF_EXCLUDE` | `listofproducts` | comma-separated filename substrings to skip |
| `DATABASE_URL` | `…@127.0.0.1:5433/bis_rag` | in Docker this is overridden to the service name |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | in Docker this is overridden to `http://host.docker.internal:11434` |
| `SIMILARITY_THRESHOLD` | `0.67` | after adding documents or changing the model — re-measure, do not guess |
| `GEN_MODEL` / `EMBED_MODEL` | local Ollama | see `.env.example` for what each requires |

`.env` is gitignored. Never commit a real key. This repository is a public fork,
so if a key ever reaches chat, logs or a commit, rotate it before shipping.

## Tests

```bash
npm test          # 316 tests, no network, ~5s
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
