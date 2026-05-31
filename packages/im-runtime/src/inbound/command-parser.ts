import type { CommandOverride, CommandParserOptions, ParsedCommand } from '../types.js';

const COMMAND_REGEX = /^\/([a-zA-Z][a-zA-Z0-9_]*)(?:@([a-zA-Z][a-zA-Z0-9_]*))?(?:\s+([\s\S]*))?$/;

/**
 * Tagged result of a single trim+regex pass over an inbound text. The dispatcher
 * uses this to avoid running the regex twice (once in `parse`, again in
 * `isForeignCommand`) on every inbound message.
 */
export type CommandClassification =
  | { kind: 'own'; command: ParsedCommand }
  | { kind: 'foreign' }
  | { kind: 'none' };

export class CommandParser {
  constructor(private opts: CommandParserOptions = {}) {}

  setOptions(next: CommandParserOptions): void {
    this.opts = { ...this.opts, ...next };
  }

  classify(text: string): CommandClassification {
    const trimmed = text.trim();
    const match = COMMAND_REGEX.exec(trimmed);
    if (!match) return { kind: 'none' };
    const [, name, addressedBot, args] = match;
    if (this.isForeignBot(addressedBot)) return { kind: 'foreign' };
    return {
      kind: 'own',
      command: {
        name: name.toLowerCase(),
        args: (args ?? '').trim(),
        raw: trimmed,
      },
    };
  }

  isForeignCommand(text: string): boolean {
    return this.classify(text).kind === 'foreign';
  }

  parse(text: string): ParsedCommand | null {
    const result = this.classify(text);
    return result.kind === 'own' ? result.command : null;
  }

  private isForeignBot(addressedBot: string | undefined): boolean {
    if (!addressedBot || !this.opts.botUsername) return false;
    return addressedBot.toLowerCase() !== this.opts.botUsername.toLowerCase();
  }
}

export const defaultCommands: ReadonlyArray<CommandOverride> = [
  {
    name: 'ask',
    description: 'Ask the knowledge base a question.',
    boundIntent: 'query',
  },
  {
    name: 'note',
    description: 'Record a thought / opinion.',
    boundIntent: 'record_thought',
  },
  {
    name: 'save',
    description: 'Submit a URL to the knowledge base.',
    boundIntent: 'submit_url',
  },
  {
    name: 'help',
    description: 'List available commands.',
    builtIn: 'help',
  },
  {
    name: 'reset',
    description: 'Abort the current reply and start a fresh conversation.',
    builtIn: 'reset',
  },
  {
    name: 'release',
    description: 'Run the pending buffered message now (skip the wait timer).',
    builtIn: 'release',
  },
  {
    name: 'cancel',
    description: 'Drop the pending buffered message without running it.',
    builtIn: 'cancel',
  },
];
