import { classify } from './classifier/classifier.service.js';
import { detectManipulationFlags } from './classifier/manipulation-flag.service.js';
import { RepeatedMailerStore } from './classifier/repeated-mailer.service.js';
import { maskBody, maskFromHeader, maskSubject } from './pii-mask/pii-mask.service.js';
import type { ProcessedMail, RawMail } from './types.js';

export function processMails(raw: RawMail[], hashStore: RepeatedMailerStore): ProcessedMail[] {
  const processed: ProcessedMail[] = [];
  for (const m of raw) {
    const sighting = hashStore.observe(m.fromAddress, m.date);

    const subjectMasked = maskSubject(m.subject);
    const bodyResult = maskBody(m.body);

    const classification = classify(m.subject, m.body);
    const flags = detectManipulationFlags(m.subject, m.body);
    if (sighting.isRepeated) {
      flags.push('repeated_mailer');
    }

    const priority: 'NORMAL' | 'HIGH' = flags.length > 0 ? 'HIGH' : 'NORMAL';

    processed.push({
      uid: m.uid,
      fromHash: sighting.hash,
      maskedFrom: maskFromHeader(
        m.fromName ? `${m.fromName} <${m.fromAddress}>` : m.fromAddress,
      ),
      maskedSubject: subjectMasked,
      maskedBody: bodyResult.masked,
      manualOnly: bodyResult.manualOnly,
      reservationCode: m.reservationCode,
      date: m.date,
      bucket: classification.bucket,
      confidence: classification.confidence,
      flags,
      priority,
    });
  }
  return processed;
}
