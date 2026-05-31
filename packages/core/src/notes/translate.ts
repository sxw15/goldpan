import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { DrizzleDB } from '../db/connection';
import type { LlmCallRepository } from '../db/repositories/types';
import { notes } from '../db/schema';
import { utcNowMs } from '../db/timestamp';
import { LANGUAGE_LABEL } from '../i18n/labels';
import type { Language } from '../i18n/types';
import { type CallLlmFn, type TranslationItemKind, translatingSchema } from '../pipeline/types';
import { compilePrompt, computePromptHash, loadPromptTemplate } from '../prompts/loader';
import type { NotesRepository } from './types';

// User-generated note content is subjective free text — `'opinion'` is the
// closest existing TranslationItemKind. translator-system.md uses kind only
// as informational hint (no register-tuning rules), so any existing kind is
// safe. Picking 'opinion' avoids extending TranslationItemKind for one caller.
const NOTE_TRANSLATION_KIND: TranslationItemKind = 'opinion';

export interface TranslateNoteDeps {
  notesRepo: NotesRepository;
  db: DrizzleDB;
  callLlm: CallLlmFn;
  llmCallRepo: LlmCallRepository;
  language: Language;
  logPayloads: boolean;
}

export interface TranslateNoteResult {
  contentTranslated: string;
}

export type TranslateNoteErrorCode =
  | 'note_not_found'
  | 'note_archived'
  | 'note_empty'
  | 'already_target_language'
  | 'note_changed'
  | 'translate_failed';

export class TranslateNoteError extends Error {
  constructor(
    public code: TranslateNoteErrorCode,
    public reason: string,
  ) {
    super(reason);
    this.name = 'TranslateNoteError';
  }
}

/**
 * Translate a user-note's content into `deps.language` and persist the result
 * into `notes.content_translated`. Reuses the pipeline `translator` step:
 * same prompts, same LlmStep, same `translatingSchema`, same LANGUAGE_LABEL.
 * Each call re-runs the LLM and overwrites the existing translation — UI is
 * expected to disable the trigger button while pending.
 *
 * Manual trigger BYPASSES `config.translation.translatePipelineOutput` —
 * that gate is for the automatic pipeline step (opt-in); clicking the UI
 * button is explicit consent so we always run.
 */
export async function translateNote(
  noteId: number,
  deps: TranslateNoteDeps,
): Promise<TranslateNoteResult> {
  const note = deps.notesRepo.get(noteId);
  if (!note) {
    throw new TranslateNoteError('note_not_found', `Note ${noteId} not found`);
  }
  if (note.archived) {
    throw new TranslateNoteError('note_archived', `Note ${noteId} is archived`);
  }
  if (!note.content.trim()) {
    throw new TranslateNoteError('note_empty', `Note ${noteId} has empty content`);
  }
  if (note.language === deps.language) {
    throw new TranslateNoteError(
      'already_target_language',
      `Note language (${note.language}) matches target (${deps.language}); nothing to translate`,
    );
  }

  const targetLanguageLabel = LANGUAGE_LABEL[deps.language];
  const systemTemplate = loadPromptTemplate('translator-system', deps.language);
  const userTemplate = loadPromptTemplate('translator', deps.language);
  const system = compilePrompt(systemTemplate, {});
  const prompt = compilePrompt(userTemplate, {
    targetLanguageLabel,
    items: [{ id: 'note', kind: NOTE_TRANSLATION_KIND, text: note.content }],
  });
  const promptHash = computePromptHash(
    userTemplate,
    systemTemplate,
    deps.language,
    `note=${noteId}`,
  );

  let output: z.infer<typeof translatingSchema>;
  try {
    output = await deps.callLlm({
      step: 'translator',
      schema: translatingSchema,
      system,
      prompt,
      promptHash,
      sourceId: null,
      llmCallRepo: deps.llmCallRepo,
      logPayloads: deps.logPayloads,
    });
  } catch (err) {
    throw new TranslateNoteError(
      'translate_failed',
      err instanceof Error ? err.message : String(err),
    );
  }

  const translated = output.translations.find((row) => row.id === 'note')?.translated?.trim() ?? '';
  if (!translated) {
    throw new TranslateNoteError('translate_failed', 'LLM returned empty translation');
  }

  const write = deps.db
    .update(notes)
    .set({ contentTranslated: translated, updatedAt: utcNowMs() })
    .where(and(eq(notes.id, noteId), eq(notes.content, note.content), eq(notes.archived, false)))
    .run();
  if (write.changes === 0) {
    const current = deps.notesRepo.get(noteId);
    if (!current) {
      throw new TranslateNoteError('note_not_found', `Note ${noteId} not found`);
    }
    if (current.archived) {
      throw new TranslateNoteError('note_archived', `Note ${noteId} is archived`);
    }
    throw new TranslateNoteError(
      'note_changed',
      `Note ${noteId} changed while translation was in progress`,
    );
  }

  return { contentTranslated: translated };
}
