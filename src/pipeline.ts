import { classify } from './classifier/classifier.service.js';
import { classifyKeywords } from './classifier/keyword-monitor.service.js';
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

    // Phase-3 keyword classifier (Dennis 2026-05-21). Runs in parallel
    // with the existing 6-bucket classifier on the RAW (pre-mask)
    // subject+body — PII-mask redacts whole bodies for IBAN/medical
    // content (manualOnly=true) so we'd otherwise miss "kan niet
    // betalen" in those mails. The hit itself only ever touches MASKED
    // fields when posting to Slack.
    // fromAddress is passed so the classifier can suppress B2B partner
    // senders (ratehawk/viator/phl-tickets/crossover-ING) whose replies
    // use customer-complaint vocabulary about partner-side order ids.
    const keywordHit = classifyKeywords({
      subject: m.subject,
      body: m.body,
      fromAddress: m.fromAddress,
    });

    // P0/P1 keyword hits escalate priority to HIGH (mirrors the
    // manipulation-flag escalation above). Downstream Slack #alerts
    // post is handled by KeywordAlertService in the runner, but the
    // priority bump also helps the queue-task dispatcher route these
    // through the HIGH-priority path.
    const priority: 'NORMAL' | 'HIGH' =
      flags.length > 0 || keywordHit !== null ? 'HIGH' : 'NORMAL';

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
      keywordHit,
    });
  }
  return processed;
}
