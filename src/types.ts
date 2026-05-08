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
}

export interface DigestStats {
  total: number;
  byBucket: Partial<Record<Bucket, number>>;
  highPriorityCount: number;
  manualOnlyCount: number;
}
