import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RepeatedMailerStore } from '../src/classifier/repeated-mailer.service.js';
import { buildDigestMessage } from '../src/digest/digest.service.js';
import { processMails } from '../src/pipeline.js';
import type { RawMail } from '../src/types.js';

async function main(): Promise<void> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-'));
  const store = new RepeatedMailerStore({
    filePath: path.join(tmp, 'h.json'),
    salt: 'demo-salt',
    thresholdCount: 3,
    windowDays: 7,
  });
  await store.load();

  // Simulate a 5-minute window of inbound mail.
  const baseTime = new Date('2026-05-08T14:25:00Z');
  const raw: RawMail[] = [
    {
      uid: 1001,
      fromAddress: 'lisa.devries@gmail.com',
      fromName: 'Lisa de Vries',
      toAddress: 'klantenservice@favotrip.nl',
      subject: 'Vraag over voucher FT-AB-CD-EF',
      body: 'Hoi, ik heb mijn voucher gekocht maar ik weet niet hoe ik kan boeken. Mijn telefoonnr is 0612345678. Groetjes, Lisa de Vries',
      date: new Date(baseTime.getTime() + 1 * 60_000),
      reservationCode: 'FT-AB-CD-EF',
    },
    {
      uid: 1002,
      fromAddress: 'martijn.b@hotmail.com',
      fromName: 'Martijn Bakker',
      toAddress: 'klantenservice@favotrip.nl',
      subject: 'Hoe boek ik een hotel? FT-XX-YY-ZZ',
      body: 'Mijn boeking FT-XX-YY-ZZ is bevestigd, hoe boek ik nu het hotel?',
      date: new Date(baseTime.getTime() + 2 * 60_000),
      reservationCode: 'FT-XX-YY-ZZ',
    },
    {
      uid: 1003,
      fromAddress: 'anna.t@example.nl',
      fromName: 'Anna Thijssen',
      toAddress: 'klantenservice@favotrip.nl',
      subject: 'Annulering reis FT-PP-QQ-RR',
      body: 'Wij willen onze reis annuleren wegens omstandigheden. Reservering FT-PP-QQ-RR.',
      date: new Date(baseTime.getTime() + 3 * 60_000),
      reservationCode: 'FT-PP-QQ-RR',
    },
    {
      uid: 1004,
      fromAddress: 'frustrated.customer@example.com',
      fromName: 'Karel Driessen',
      toAddress: 'klantenservice@favotrip.nl',
      subject: 'GELD TERUG - dit is niet acceptabel - FT-MM-NN-OO',
      body: 'Ik wil mijn geld terug. Mijn moeder is in het ziekenhuis en als ik geen refund krijg schakel ik mijn advocaat in en meld het bij de AFM.',
      date: new Date(baseTime.getTime() + 4 * 60_000),
      reservationCode: 'FT-MM-NN-OO',
    },
    {
      uid: 1005,
      fromAddress: 'iban.user@example.com',
      fromName: 'Pieter de Boer',
      toAddress: 'klantenservice@favotrip.nl',
      subject: 'Bankgegevens voor refund FT-VV-WW-XX',
      body: 'Mijn IBAN is NL91ABNA0417164300, graag het bedrag van € 425 hierop terugstorten.',
      date: new Date(baseTime.getTime() + 5 * 60_000),
      reservationCode: 'FT-VV-WW-XX',
    },
  ];

  // Pre-seed repeated-mailer store so frustrated.customer triggers
  store.observe('frustrated.customer@example.com', new Date(baseTime.getTime() - 86_400_000));
  store.observe('frustrated.customer@example.com', new Date(baseTime.getTime() - 43_200_000));

  const processed = processMails(raw, store);
  const digest = buildDigestMessage(processed, new Date(baseTime.getTime() + 5 * 60_000));

  console.log('=== SYNTHETIC DIGEST OUTPUT ===');
  console.log(digest);
  console.log('=== END ===');
  console.log('');
  console.log('per-mail audit:');
  for (const m of processed) {
    console.log(
      JSON.stringify(
        {
          uid: m.uid,
          bucket: m.bucket,
          confidence: Math.round(m.confidence * 100) / 100,
          flags: m.flags,
          priority: m.priority,
          manualOnly: m.manualOnly,
          maskedFrom: m.maskedFrom,
          maskedSubject: m.maskedSubject,
          maskedBody: m.maskedBody.slice(0, 80) + (m.maskedBody.length > 80 ? '…' : ''),
          reservationCode: m.reservationCode,
        },
        null,
        2,
      ),
    );
  }

  await fs.rm(tmp, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
