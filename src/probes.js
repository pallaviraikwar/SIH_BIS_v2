/**
 * Labelled probe sets for measuring the relevance threshold.
 *
 * The threshold is the one number in this system that cannot be reasoned out —
 * it depends on the embedding model, the vector width, and what is in the
 * corpus. Guessing it is how "hi" ended up retrieving a page of committee
 * procedure, so the numbers are measured and the probe sets live here where they
 * can be edited when the corpus changes.
 *
 * The out-of-corpus set deliberately leads with greetings and single words.
 * Product questions were the original probe set and they turned out to be the
 * *easy* negatives: greetings score far higher (0.59-0.61) because a short,
 * semantically empty string embeds near the centroid of generic prose. Only
 * measuring the easy negatives made the gap look wider than it was.
 */

export const IN_CORPUS = [
  // Written against SP 21:2005, "Summaries of Indian Standards for Building
  // Materials". REWRITE THIS whenever the corpus changes — a probe whose answer
  // is not in the corpus is worse than no probe, because it drags the in-corpus
  // floor down and drags the threshold down with it.
  //
  // These must be phrased the way a person types, NOT as standard titles. The
  // first version of this set was a list of near-verbatim standard titles, and
  // that was actively harmful: a title like "coarse and fine aggregates from
  // natural sources for concrete" is almost exactly the chunk's own heading, so
  // it scored 0.78 while the real question "what is cement" scored 0.71. The
  // probe set measured the ceiling of an easy case and reported it as the
  // floor, which pushed the threshold to 0.712 and refused ordinary questions
  // about material the corpus is entirely about. Measured floor is now 0.677.
  'what is cement',
  'tell me about cement',
  'give me the IS code for bricks',
  'how much water can I add to concrete',
  'what is the compressive strength of concrete',
  'how strong should concrete be',
  'which standard covers fly ash cement',
  'what does SP 21 say',
  'what is the tensile strength of steel pipes',
  'is asbestos still used in buildings',
  'what is water proofing',
  'tensile test on steel pipes',
  'requirements for aggregates used in structural concrete',
  'precast ferrocement water tank',
];

export const OUT_OF_CORPUS = [
  // Greetings and chit-chat: the highest-scoring negatives that exist.
  'hello',
  'hi',
  'hey',
  'hellowe',
  'thanks',
  'thank you',
  'who are you',
  'help',
  'what can you do',
  'asdfghjkl',
  'test',
  'ok',

  // Real questions about things this corpus does not contain. Note that
  // "compressive strength of cement mortar" is NOT here any more: this corpus
  // covers cement and concrete standards, so it is a genuine in-corpus question
  // and labelling it a negative would corrupt the measurement.
  'tell me about the plastics',
  'maximum moisture content in biscuits',
  'packaged drinking water specification',
  'gold hallmarking licence fees',
  'who won the cricket world cup',
  'reverse a string in python',
  'what is the weather today',
  'symptoms of vitamin c deficiency',

  // Vague, open-ended asks. These are the ones a real user actually types when
  // they have not yet decided what they want, and they belong here because
  // answering them with a random clause is the worst outcome available. All of
  // them measure between 0.49 and 0.66, comfortably under the chit-chat cluster
  // above only in the sense of being boring — which is exactly why they are
  // worth keeping as negatives.
  'tell me something',
  'how are you',
  'what is your name',
  'tell me a joke',
  'anything you can tell me',
  'what should I build',
];
