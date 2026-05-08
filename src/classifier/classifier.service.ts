import type { Bucket, Classification } from '../types.js';

interface BucketSpec {
  bucket: Exclude<Bucket, 'needs_human_review'>;
  keywords: { phrase: string; weight: number }[];
}

const SPECS: BucketSpec[] = [
  {
    bucket: 'cancellation_request',
    keywords: [
      { phrase: 'annuleren', weight: 5 },
      { phrase: 'annulering', weight: 5 },
      { phrase: 'cancel', weight: 4 },
      { phrase: 'cancellation', weight: 5 },
      { phrase: 'kunnen niet komen', weight: 3 },
      { phrase: 'wij willen afzeggen', weight: 4 },
      { phrase: 'opzeggen', weight: 3 },
    ],
  },
  {
    bucket: 'refund_request',
    keywords: [
      { phrase: 'terugbetalen', weight: 5 },
      { phrase: 'terugbetaling', weight: 5 },
      { phrase: 'refund', weight: 5 },
      { phrase: 'geld terug', weight: 5 },
      { phrase: 'restitutie', weight: 5 },
      { phrase: 'storneren', weight: 4 },
      { phrase: 'wil mijn geld', weight: 4 },
    ],
  },
  {
    bucket: 'partner_issue',
    keywords: [
      { phrase: 'hotel', weight: 2 },
      { phrase: 'ratehawk', weight: 5 },
      { phrase: 'viator', weight: 5 },
      { phrase: 'getyourguide', weight: 5 },
      { phrase: 'musement', weight: 5 },
      { phrase: 'partner', weight: 3 },
      { phrase: 'kamer was', weight: 3 },
      { phrase: 'ticket niet ontvangen', weight: 4 },
      { phrase: 'no-show', weight: 3 },
      { phrase: 'overboekt', weight: 4 },
    ],
  },
  {
    bucket: 'booking_question',
    keywords: [
      { phrase: 'boeking', weight: 3 },
      { phrase: 'reservering', weight: 3 },
      { phrase: 'wanneer', weight: 1 },
      { phrase: 'hoe boek ik', weight: 4 },
      { phrase: 'voucher code', weight: 4 },
      { phrase: 'voucher inleveren', weight: 4 },
      { phrase: 'verzilveren', weight: 4 },
      { phrase: 'aankomstdatum', weight: 3 },
      { phrase: 'check-in', weight: 2 },
      { phrase: 'check in', weight: 2 },
    ],
  },
  {
    bucket: 'general_info',
    keywords: [
      { phrase: 'info', weight: 1 },
      { phrase: 'informatie', weight: 2 },
      { phrase: 'vraag', weight: 1 },
      { phrase: 'hoe werkt', weight: 3 },
      { phrase: 'openingstijden', weight: 4 },
      { phrase: 'contact', weight: 1 },
    ],
  },
  {
    bucket: 'spam_out_of_scope',
    keywords: [
      { phrase: 'unsubscribe', weight: 3 },
      { phrase: 'newsletter', weight: 3 },
      { phrase: 'special offer', weight: 3 },
      { phrase: 'sales', weight: 2 },
      { phrase: 'marketing partnership', weight: 4 },
      { phrase: 'seo services', weight: 5 },
      { phrase: 'b2b leads', weight: 4 },
      { phrase: 'cold outreach', weight: 4 },
    ],
  },
];

const MIN_CONFIDENCE = 0.5;

export function classify(subject: string, body: string): Classification {
  const corpus = (subject + '\n' + body).toLowerCase();
  const scores = new Map<Bucket, number>();
  let totalScore = 0;

  for (const spec of SPECS) {
    let bucketScore = 0;
    for (const { phrase, weight } of spec.keywords) {
      const occurrences = countOccurrences(corpus, phrase.toLowerCase());
      bucketScore += occurrences * weight;
    }
    if (bucketScore > 0) {
      scores.set(spec.bucket, bucketScore);
      totalScore += bucketScore;
    }
  }

  if (totalScore === 0) {
    return { bucket: 'needs_human_review', confidence: 0 };
  }

  let topBucket: Bucket = 'needs_human_review';
  let topScore = 0;
  for (const [b, s] of scores) {
    if (s > topScore) {
      topScore = s;
      topBucket = b;
    }
  }

  const confidence = topScore / totalScore;

  if (confidence <= MIN_CONFIDENCE) {
    return { bucket: 'needs_human_review', confidence };
  }

  return { bucket: topBucket, confidence };
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}
