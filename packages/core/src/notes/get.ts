import type { NoteDetail, NotesRepository } from './types';

export interface GetNoteDeps {
  repo: NotesRepository;
}

export function getNote(id: number, deps: GetNoteDeps): NoteDetail | null {
  return deps.repo.get(id);
}
