import { migrate, closePool } from '../src/db.js';
import { answerQuestion } from '../src/rag.js';
import { SUPPORTED_LANGS } from '../src/config.js';

/**
 * Ask a question straight against the RAG pipeline, bypassing HTTP.
 *
 *   npm run ask "maximum moisture in biscuits"
 *   npm run ask -- "TDS limit" --lang hi
 */

const args = process.argv.slice(2);
const langFlag = args.indexOf('--lang');
const lang = langFlag !== -1 ? args[langFlag + 1] : 'en';
// The flag positions are only meaningful when the flag is actually present.
// With langFlag === -1, `i === langFlag + 1` is `i === 0`, which quietly dropped
// the first word of every question asked without --lang — and turned a
// single-word question into an empty string, so the script printed its usage
// message and exited 1 for a perfectly valid query.
const question = args
  .filter((a, i) => (langFlag === -1 ? true : !(i === langFlag || i === langFlag + 1)))
  .join(' ')
  .trim();

if (!question) {
  console.log('Usage: npm run ask -- "your question" [--lang en|hi|pa|te]');
  process.exit(1);
}
if (!SUPPORTED_LANGS.includes(lang)) {
  console.error(`Unsupported --lang "${lang}". Use one of: ${SUPPORTED_LANGS.join(', ')}`);
  process.exit(1);
}

const stripTags = (html) =>
  html
    .replace(/<\/(p|li|div)>/g, '\n')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();

async function main() {
  await migrate();

  console.log(`\n[${lang}] ${question}\n${'-'.repeat(66)}`);
  const result = await answerQuestion({ query: question, lang });

  console.log(stripTags(result.answer));
  console.log('-'.repeat(66));

  if (result.sources?.length) {
    console.log('\nRetrieved passages:');
    result.sources.forEach((s, i) => {
      const pages = s.pages.length > 1 ? `${s.pages[0]}-${s.pages[1]}` : `${s.pages[0]}`;
      console.log(
        `  [${i + 1}] ${s.docTitle}${s.clause ? `  cl. ${s.clause}` : ''}  p.${pages}  (match ${(s.similarity * 100).toFixed(1)}%)`
      );
    });
  }

  const m = result.meta;
  console.log(
    `\ntranslated=${m.translationUsed}  retrieved=${m.retrieved}  ` +
      `translate=${m.timings.translate}  retrieve=${m.timings.retrieve}  generate=${m.timings.generate}`
  );
  if (m.notFound) console.log(`not-found: ${m.reason ?? 'model declined'}`);
  console.log();
}

main()
  .catch((err) => {
    console.error('\n✗', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
