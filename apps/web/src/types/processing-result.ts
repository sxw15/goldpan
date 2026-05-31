export interface ProcessingResultStats {
  extracted: number;
  accepted: number;
  droppedUnassigned: number;
  quarantined: number;
  skipped: number;
  verifierRejected: number;
}

export interface DroppedPoint {
  pointKey: string;
  content: string;
  reason: 'unassigned' | 'invalid_entity_ref' | 'invalid_entity_key_format';
  entityKey?: string;
  type: 'fact' | 'opinion';
}

export interface RejectedPoint {
  pointKey: string;
  content?: string;
  reason: string;
  /** Translation of `reason`, when the translating step produced one. */
  reasonTranslated?: string;
}

export interface NewOpinionPoint {
  pointKey: string;
  pointId?: number;
  content: string;
  /** Translation of `content`, when the translating step produced one. */
  contentTranslated?: string;
  /** Hashtag-style labels surfaced on the NoteBubbleCard. Undefined when the
   * extractor did not assign any (e.g. fact submissions). */
  tags?: string[];
}

export type ValidationWarning = string;

export interface ProcessingResultEntity {
  entityKey: string;
  entityId?: number;
  entityName: string;
  categoryPath: string;
  isNew: boolean;
  outputMode: 'full_summary' | 'summary_plus_increment' | 'increment_only';
  keywords: string[];
  summary?: string;
  /** Translation of `summary`, when the translating step produced one. */
  summaryTranslated?: string;
  /** Translation of a newly created entity's description, when produced. */
  descriptionTranslated?: string;
  skippedFactCount: number;
  newFactPoints: Array<{
    pointKey: string;
    pointId?: number;
    content: string;
    /** Translation of `content`, when produced. */
    contentTranslated?: string;
  }>;
  skippedFactPoints: Array<{
    pointKey: string;
    matchedPointId: number;
    matchedContent: string;
  }>;
  newOpinionPoints: NewOpinionPoint[];
  rejectedPoints?: RejectedPoint[];
}

export interface ProcessingResultSource {
  title: string;
  originalUrl?: string;
  id: number;
  kind: 'external' | 'user';
}

export interface ProcessingResultClassification {
  categoryPath?: string;
  keywords?: string[];
}

export interface ProcessingResult {
  /** Mirrors `processing_tasks.input_type` — drives whether the chat bubble
   * uses TaskBubbleCard (fact) or NoteBubbleCard (opinion). */
  inputMode?: 'fact' | 'opinion';
  /** Verbatim user opinion text (only set when inputMode='opinion'). */
  noteQuote?: string;
  stats: ProcessingResultStats;
  entities: ProcessingResultEntity[];
  source?: ProcessingResultSource;
  classification?: ProcessingResultClassification;
  droppedPoints?: DroppedPoint[];
  validationWarnings?: ValidationWarning[];
  relationStats?: {
    extracted: number;
    validated: number;
    stored: number;
    deduplicated: number;
  };
  error?: { step: string; message: string; retryable: boolean };
}
