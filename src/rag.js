import { config } from './config.js';
import { embedQuery, generateText } from './gemini.js';
import { searchChunks, listDocumentTitles } from './store.js';
import { normaliseLang, toEnglishQuery } from './translator.js';
import { ANSWER_SYSTEM, buildAnswerPrompt, GENERATION_FAILED_REPLY } from './prompts.js';
import {
  renderAnswerHtml,
  renderSourcesHtml,
  renderNotFoundHtml,
  renderGreetingHtml,
  modelSaysNotFound,
} from './render.js';
import { detectIntent } from './intent.js';

const ms = (start) => `${Date.now() - start}ms`;

/**
 * Titles of the indexed documents, for scope-aware replies.
 *
 * Fetched only when a reply actually needs it. It costs one cheap indexed query
 * and must never be able to fail a request, so any error degrades to an empty
 * list — the reply simply omits the coverage section.
 */
async function coverageTitles() {
  try {
    return await listDocumentTitles();
  } catch (err) {
    console.error(`[rag] could not list documents for scope message: ${err.message}`);
    return [];
  }
}

/**
 * Full pipeline: translate -> retrieve -> ground -> render.
 *
 * The original-language question is what the user is answered against, while
 * the English translation is what gets embedded. Answering in the requested
 * language from English context avoids the drift you get from generating in
 * English and then machine-translating the result.
 */
export async function answerQuestion({ query, lang: rawLang }) {
  const lang = normaliseLang(rawLang);
  const t0 = Date.now();

  // Greetings are handled before anything costs money. "hi" is the worst case for
  // a similarity threshold — it embeds near the centroid of generic prose and
  // scores 0.6056, above the configured bar — so retrieving for it produces a
  // confident answer about committee procedure to someone who just said hello.
  const intent = detectIntent(query);
  if (intent === 'chitchat') {
    return {
      answer: renderGreetingHtml({ lang, coverageTitles: await coverageTitles() }),
      sources: [],
      notFound: false,
      meta: {
        lang,
        intent,
        translationUsed: false,
        retrievalQuery: query,
        retrieved: 0,
        notFound: false,
        total: ms(t0),
        timings: { translate: '0ms', retrieve: '0ms', generate: '0ms' },
      },
    };
  }

  const translation = await toEnglishQuery(query, lang);
  const tTranslate = Date.now() - t0;

  const t1 = Date.now();
  const queryVector = await embedQuery(translation.text);
  const passages = await searchChunks({
    embedding: queryVector,
    topK: config.retrieval.topK,
    threshold: config.retrieval.threshold,
  });
  const tRetrieve = Date.now() - t1;

  // Nothing cleared the relevance bar. Answer without calling the model: there
  // is no grounded answer to be had, and a model given zero context will
  // cheerfully invent one.
  if (!passages.length) {
    return {
      answer: renderNotFoundHtml({ lang, coverageTitles: await coverageTitles() }),
      sources: [],
      notFound: true,
      meta: {
        lang,
        translationUsed: translation.translated,
        retrievalQuery: translation.text,
        retrieved: 0,
        notFound: true,
        reason: 'no_passages_above_threshold',
        timings: { translate: tTranslate, retrieve: tRetrieve, generate: '0ms' },
        threshold: config.retrieval.threshold,
      },
    };
  }

  const t2 = Date.now();
  let answerText;
  let generateError = null;
  try {
    answerText = await generateText({
      systemInstruction: ANSWER_SYSTEM,
      prompt: buildAnswerPrompt({ question: query, passages, lang }),
    });
  } catch (err) {
    generateError = err;
    console.error(`[rag] generation failed: ${err.message}`);
  }
  const tGenerate = Date.now() - t2;

  // Generation failing is not a 500: the retrieved evidence is still worth
  // showing, so degrade to a retryable notice plus the passages.
  //
  // This is deliberately NOT the "not found" copy. That message tells the user
  // the corpus has nothing, which is false here — retrieval succeeded and we are
  // holding real clauses. Telling someone their question is unanswerable when the
  // real problem is a model outage sends them off to rephrase a question that was
  // fine. The raw error goes to the log, not into the response body.
  if (generateError) {
    return {
      answer:
        `<p style="margin:0 0 8px">${escapeForHtml(GENERATION_FAILED_REPLY[lang] ?? GENERATION_FAILED_REPLY.en)}</p>` +
        renderSourcesHtml(passages, lang),
      sources: passages.map(publicSource),
      notFound: false,
      degraded: true,
      meta: {
        lang,
        translationUsed: translation.translated,
        retrievalQuery: translation.text,
        retrieved: passages.length,
        notFound: false,
        degraded: true,
        reason: 'generation_failed',
        timings: { translate: tTranslate, retrieve: tRetrieve, generate: tGenerate },
        threshold: config.retrieval.threshold,
      },
    };
  }

  return {
    answer: renderAnswerHtml({
      answerText,
      passages,
      lang,
      coverageTitles: await coverageTitles(),
    }),
    sources: passages.map(publicSource),
    answerText,
    notFound: modelSaysNotFound(answerText),
    meta: {
      lang,
      translationUsed: translation.translated,
      retrievalQuery: translation.text,
      retrieved: passages.length,
      timings: { translate: tTranslate, retrieve: tRetrieve, generate: tGenerate },
      threshold: config.retrieval.threshold,
      total: ms(t0),
    },
  };
}

/** Retrieval-only path, for the /api/search debug endpoint. No model call. */
export async function searchOnly(query, { topK, threshold } = {}) {
  const translation = await toEnglishQuery(query, 'en');
  const vector = await embedQuery(translation.text);

  const passages = await searchChunks({
    embedding: vector,
    topK: topK ?? config.retrieval.topK,
    threshold: threshold ?? config.retrieval.threshold,
  });

  return { query: translation.text, passages };
}

function publicSource(p) {
  return {
    docTitle: p.docTitle,
    clause: p.clause,
    pages: p.pageFrom === p.pageTo ? [p.pageFrom] : [p.pageFrom, p.pageTo],
    similarity: Number(p.similarity.toFixed(4)),
  };
}

function escapeForHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
