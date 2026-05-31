import { describe, expect, it } from 'vitest';
import { serializeHandleInputResult } from '../src/routes/input-wire.js';

describe('serializeHandleInputResult', () => {
  it('serializes note results to the public /input wire shape', () => {
    const { statusCode, responseBody } = serializeHandleInputResult({
      type: 'note',
      detail: {
        id: 7,
        content: 'release note',
        contentTranslated: null,
        language: null,
        subtype: 'note',
        pinned: false,
        archived: false,
        sourceMessageId: null,
        tags: [],
        linkedEntities: [],
        linkedSources: [],
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    });

    expect(statusCode).toBe(200);
    expect(responseBody).toEqual({
      type: 'note',
      note: {
        id: 7,
        content: 'release note',
        subtype: 'note',
        tags: [],
        linkedEntities: [],
        linkedSources: [],
        createdAt: 1700000000000,
      },
    });
    expect(responseBody).not.toHaveProperty('detail');
  });

  it('serializes submit results to the same status/body contract as /input', () => {
    const { statusCode, responseBody } = serializeHandleInputResult({
      type: 'submit',
      result: {
        status: 'accepted',
        taskId: 123,
        sourceId: 456,
        warnings: [],
      },
    });

    expect(statusCode).toBe(201);
    expect(responseBody).toMatchObject({
      type: 'submit',
      status: 'accepted',
      taskId: 123,
      warnings: [],
    });
    expect(responseBody).not.toHaveProperty('result');
  });
});
