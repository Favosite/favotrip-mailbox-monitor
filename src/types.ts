export type Bucket =
  | 'booking_question'
  | 'cancellation_request'
  | 'refund_request'
  | 'partner_issue'
  | 'general_info'
  | 'spam_out_of_scope'
  | 'needs_human_review';

export type ManipulationFlag =
  | 'sob_story_money'
  | 'legal_threat'
  | 'chargeback'
  | 'repeated_mailer';

export interface RawMail {
  uid: number;
  fromAddress: string;
  fromName?: string;
  toAddress: string;
  subject: string;
  body: string;
  date: Date;
  reservationCode?: string;
}

export interface MaskedMail {
  uid: number;
  fromHash: string;
  maskedFrom: string;
  maskedSubject: string;
  maskedBody: string;
  manualOnly: boolean;
  reservationCode?: string;
  date: Date;
}

export interface Classification {
  bucket: Bucket;
  confidence: number;
}

export interface ProcessedMail extends MaskedMail, Classification {
  flags: ManipulationFlag[];
  priority: 'NORMAL' | 'HIGH';
  /**
   * Phase-3 keyword classifier output (Dennis 2026-05-21). Populated by
   * the pipeline when a P0/P1 keyword matches. null/undefined when no
   * keyword matched. The 6-bucket `bucket` field is unaffected — this
   * is an ADDITIONAL signal, not a replacement.
   */
  keywordHit?: KeywordHitSummary | null;
}

/**
 * Public-shape mirror of `classifier/keyword-monitor.service.ts`'s
 * `KeywordHit`. Defined here to keep the type tree free of cycles
 * between types.ts and the classifier service.
 */
export interface KeywordHitSummary {
  severity: 'P0' | 'P1';
  keywords: string[];
  runbook: string;
}

export interface DigestStats {
  total: number;
  byBucket: Partial<Record<Bucket, number>>;
  highPriorityCount: number;
  manualOnlyCount: number;
}
