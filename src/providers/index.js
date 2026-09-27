import { config } from '../config.js';
import * as openrouter from './openrouter.js';
import * as gemini from './gemini.js';
import * as ollama from './ollama.js';

/**
 * Provider dispatch.
 *
 * Generation and embedding are routed separately, and the asymmetry is the point:
 *
 *   generateText  falls back. Two different models writing prose is harmless; the
 *                 worst case is a slightly different answer to the same question.
 *
 *   embed*        never falls back. Vectors from two models are not comparable,
 *                 and a corpus holding both does not error — it just retrieves
 *                 worse, silently, which is much harder to notice than an outage.
 *                 Switching embedding provider is therefore a deliberate act that
 *                 drops the index and re-embeds; see syncIndexToConfig in db.js.
 *
 * `rag.js` and `translator.js` import from here and are otherwise unaware of which
 * provider is configured.
 */

const REGISTRY = { openrouter, gemini, ollama };

function provider(name) {
  const mod = REGISTRY[name];
  if (!mod) throw new Error(`Unknown provider "${name}". Known: ${Object.keys(REGISTRY).join(', ')}.`);
  return mod;
}

/**
 * Should this failure move generation to the fallback provider?
 *
 * Only for quota and rate-limit conditions. A 400 (bad model name, malformed
 * request) or a 401 is a bug that fails identically on every provider, and
 * switching would bury it under a second, more confusing error. Daily caps on
 * either side count: the fallback may well have quota left when the primary does
 * not, which is the whole point of having one.
 */
export function isFallbackWorthy(err) {
  if (!err) return false;
  if (err.dailyQuota) return true;
  if (err.status === 429 || err.status === 402) return true;

  const text = `${err.message ?? ''} ${err.body ?? ''}`.toLowerCase();
  return (
    text.includes('429') ||
    text.includes('quota') ||
    text.includes('rate limit') ||
    text.includes('rate_limit') ||
    text.includes('resource_exhausted') ||
    text.includes('insufficient') ||
    text.includes('credits') ||
    text.includes('overloaded')
  );
}

/**
 * Generate text, falling back to the secondary provider on quota failures.
 *
 * Returns the provider that actually answered along with the text, because a
 * fallback answer and a primary answer are not the same thing and a debugging
 * session that cannot tell them apart is miserable.
 */
export async function generateText({ systemInstruction, prompt, temperature, maxOutputTokens }) {
  const { provider: primary, fallbackProvider, fallbackEnabled } = config.generation;

  const order = [primary];
  if (fallbackEnabled && fallbackProvider && fallbackProvider !== primary && provider(fallbackProvider).hasKey()) {
    order.push(fallbackProvider);
  }

  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const which = order[i];
    try {
      const text = await provider(which).chat({ systemInstruction, prompt, temperature, maxOutputTokens });
      if (i > 0) console.warn(`[ai] ${order[0]} hit a quota limit; answered via ${which} instead.`);
      return { text, provider: which, degraded: i > 0 };
    } catch (err) {
      lastErr = err;

      if (i === order.length - 1) throw err;
      if (!isFallbackWorthy(err)) {
        // Said out loud, because "why did it not use the fallback?" is otherwise
        // invisible: the reason is nearly always that it was not a quota error.
        console.warn(
          `[ai] ${which} failed with a non-quota error (${String(err.message).slice(0, 100)}); ` +
            `not falling back to ${order[i + 1]}.`
        );
        throw err;
      }
      console.warn(
        `[ai] ${which} failed (${String(err.message).slice(0, 100)}); trying ${order[i + 1]}.`
      );
    }
  }
  throw lastErr;
}

/** Embed documents as `{ text, title }`, in order. No provider fallback. */
export async function embedDocuments(items) {
  if (!items.length) return [];
  return provider(config.embedding.provider).embedDocuments(items);
}

/** Embed one query, or an array of them, as a unit vector. */
export async function embedQuery(text) {
  return provider(config.embedding.provider).embedQuery(text);
}

/**
 * Translate, on a model that is not the answering model.
 *
 * This exists as its own entry point rather than a flag on `generateText` because
 * the two jobs need different models, different prompt formats and different
 * timeouts, and `generateText` is hardcoded to `config.generation.*`. Before this,
 * `rag.js` (writing prose) and `translator.js` (converting a Hindi question to
 * English) both called `generateText` and therefore both used sarvam-1 — which is
 * why asking it to translate produced an answer to the question instead.
 *
 * The dispatch is on `translation.raw` rather than on the provider alone. Only
 * Ollama exposes a raw completion path; the hosted providers have no equivalent,
 * so a `TRANSLATION_PROVIDER` pointed at one of them still works through the
 * chat route instead of failing on a missing method.
 *
 * There is deliberately no fallback ladder here, unlike above. A fallback *writer*
 * produces different prose for the same question, which is harmless. A fallback
 * *translator* can produce a different language, and the retrieval that follows
 * would be wrong with nothing downstream able to detect it. Better to throw and let
 * the caller degrade to a reply that admits the translation failed.
 */
export async function translateText({ prompt, temperature, maxOutputTokens }) {
  const { provider: which, raw } = config.translation;

  if (raw && typeof provider(which).rawGenerate === 'function') {
    const text = await provider(which).rawGenerate({ prompt, temperature, maxOutputTokens });
    return { text, provider: which, raw: true };
  }

  const gen = await generateText({ prompt, temperature, maxOutputTokens });
  return { ...gen, raw: false };
}

export const activeEmbeddingProvider = () => config.embedding.provider;
export const activeGenerationProvider = () => config.generation.provider;
