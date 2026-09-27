# index-snapshots

Prepared vector indexes. A snapshot lets someone install this project with a
working corpus **without running ingest**, which on CPU takes 5-20 minutes for a
few thousand chunks.

The whole folder is gitignored except this file. A snapshot is a derived
artefact — anyone can rebuild one with `npm run index:export` — so committing a
~19 MB binary blob of text extracted from BIS standards into a public repository
buys nothing.

## Using one

Put the bundle directory in here. That is the entire install step:

```
index-snapshots/
  20260927T115319Z-ollama-nomic-embed-text-768d/     <- copy this directory in
  LATEST                                             <- one line: which one
```

```bash
npm run index:import          # loads whatever LATEST names
```

`./run.sh` does this on its own: if the store is empty and a snapshot is here and
compatible, it loads the snapshot instead of ingesting. Pass `--no-snapshot` to
force an ingest, or `--import-snapshot` to allow only the snapshot path.

## Making one

```bash
npm run index:export          # -> index-snapshots/<stamp>-<model>-<dims>/
```

The directory name carries the provider, model and vector width because you will
end up with more than one, and the name settles which is which before anything is
opened.

## Format

```
<stamp>-<provider>-<model>-<dims>d/
  manifest.json          fingerprint, chunking, counts, checksums, PDF digests
  documents.jsonl.gz     one bis_documents row per line
  chunks.jsonl.gz        one bis_chunks row per line, vectors included
```

Gzipped NDJSON, so it streams and needs no database to read. You can look inside
one without this project:

```bash
zcat chunks.jsonl.gz | head -1 | python3 -m json.tool
```

`manifest.json` is what makes a bundle safe to hand to someone. It records the
embedding provider, model and width that produced the vectors, and the import
**refuses** the bundle if those differ from the receiving machine's `.env`. That
guard is not ceremony: cosine distance between two unrelated vector spaces is a
meaningful-looking number that retrieves confidently and wrongly, and
`bis_index_meta` already exists in the database to stop exactly that. The
manifest applies the same rule one step earlier, before anything is written.

## What is not in here: the PDFs

A snapshot records each document's source filename and sha256, and does not
include the file. The BIS standards are not ours to redistribute, and the PDFs
are 16 MB on top of the 19 MB of vectors.

The consequence, which the import reports explicitly:

- **answers are unaffected** — retrieval reads the vectors, not the file
- **citation links do not work** without the PDFs. Clicking "open the source at
  page 34" needs `data/pdfs/<sourceFile>` to exist. Drop the PDFs in and every
  link resolves.

If you have both the bundle and the PDFs, you get a fully working install in
about ten seconds.
