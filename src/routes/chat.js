import express from 'express';
import { answerQuestion } from '../rag.js';
import { SUPPORTED_LANGS } from '../config.js';

// Multilingual UI strings the frontend does not send us. The answer itself is
// generated in the user's language; these are only the canned replies.
const NO_QUESTION = {
  en: 'Please type a question about a BIS standard.',
  hi: 'कृपया किसी BIS मानक के बारे में प्रश्न लिखें।',
  pa: 'ਕਿਰਪਾ ਕਰਕੇ ਕਿਸੇ BIS ਮਾਪਦੰਡ ਬਾਰੇ ਸਵਾਲ ਲਿਖੋ।',
  te: 'దయచేసి ఏదైనా BIS ప్రమాణం గురించి ప్రశ్న రాయండి.',
};

const ERROR_REPLY = {
  en: 'Something went wrong while answering that. Please try again.',
  hi: 'उत्तर देने में कुछ गड़बड़ हुई। कृपया पुनः प्रयास करें।',
  pa: 'ਜਵਾਬ ਦੇਣ ਵਿੱਚ ਕੁਝ ਗਲਤੀ ਹੋਈ। ਕਿਰਪਾ ਕਰਕੇ ਦੁਬਾਰਾ ਕੋਸ਼ਿਸ਼ ਕਰੋ।',
  te: 'సమాధానం ఇవ్వడంలో ఏదో తప్పు జరిగింది. దయచేసి మళ్ళీ ప్రయత్నించండి.',
};

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const chatRouter = express.Router();

chatRouter.post('/chat', async (req, res) => {
  const { query, lang: rawLang } = req.body ?? {};

  const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : 'en';

  if (typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ answer: escapeHtml(NO_QUESTION[lang]) });
  }

  const trimmed = query.trim();
  if (trimmed.length > 2000) {
    return res.status(413).json({
      answer: escapeHtml('Question is too long. Please keep it under 2000 characters.'),
    });
  }

  try {
    const result = await answerQuestion({ query: trimmed, lang });
    return res.json(result);
  } catch (err) {
    console.error('[chat] failed:', err);
    return res.status(500).json({ answer: escapeHtml(ERROR_REPLY[lang]) });
  }
});
