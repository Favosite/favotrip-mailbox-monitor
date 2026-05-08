import type { ManipulationFlag } from '../types.js';

interface Pattern {
  flag: ManipulationFlag;
  // Each item is an AND-list. The flag fires if any AND-list fully matches.
  matchers: { all: RegExp[] }[];
}

const PATTERNS: Pattern[] = [
  {
    flag: 'sob_story_money',
    matchers: [
      {
        all: [
          /\b(geld terug|refund|terugbetaling|restitutie|geld\s+retour)\b/i,
          /\b(noodgeval|ziek|ziekenhuis|advocaat|kort geding|afm|acm|mijn moeder|sterfgeval|overlijden|operatie)\b/i,
        ],
      },
    ],
  },
  {
    flag: 'legal_threat',
    matchers: [
      {
        all: [
          /\b(advocaat|rechtszaak|ingebrekestelling|afm|acm|consumentenbond|rechtbank|deurwaarder|aansprakelijk|sommatie)\b/i,
        ],
      },
    ],
  },
  {
    flag: 'chargeback',
    matchers: [
      {
        all: [
          /\b(chargeback|terugboeking|stornering|visa dispute|mastercard dispute|geld is teruggeboekt|teruggeboekt door (?:mijn )?bank)\b/i,
        ],
      },
    ],
  },
];

export function detectManipulationFlags(subject: string, body: string): ManipulationFlag[] {
  const corpus = subject + '\n' + body;
  const flags: ManipulationFlag[] = [];
  for (const pattern of PATTERNS) {
    const fired = pattern.matchers.some((m) => m.all.every((re) => re.test(corpus)));
    if (fired) {
      flags.push(pattern.flag);
    }
  }
  return flags;
}
