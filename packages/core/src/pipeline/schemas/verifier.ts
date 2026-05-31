import { z } from 'zod';

/** Verifier step output */
export const verifierSchema = z.object({
  verifiedPointKeys: z.array(z.string().min(1)).max(50),
  rejectedPointKeys: z
    .array(
      z.object({
        pointKey: z.string().min(1),
        reason: z.string().max(500),
      }),
    )
    .max(50),
});

export type VerifierOutput = z.infer<typeof verifierSchema>;

/*
verifierSchema → JSON Schema:
{
  "type": "object",
  "properties": {
    "verifiedPointKeys": {
      "type": "array",
      "maxItems": 50,
      "items": { "type": "string", "minLength": 1 }
    },
    "rejectedPointKeys": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "properties": {
          "pointKey": { "type": "string", "minLength": 1 },
          "reason":   { "type": "string", "maxLength": 500 }
        },
        "required": ["pointKey", "reason"],
        "additionalProperties": false
      }
    }
  },
  "required": ["verifiedPointKeys", "rejectedPointKeys"],
  "additionalProperties": false
}
*/
