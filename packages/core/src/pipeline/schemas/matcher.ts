import { z } from 'zod';

/** Single entity match result — passthrough allows LLM to add extra fields without breaking validation */
export const entityMatchSchema = z
  .object({
    entityKey: z.string().min(1),
    entityName: z.string().min(1).max(200).optional(),
    resolvedCategoryPath: z.string().min(1).max(300),
    knowledgePointKeys: z.array(z.string().min(1)).min(1).max(50),
    discoveredAliases: z.array(z.string()).max(20).optional(),
    keywords: z.array(z.string()).max(8).optional(),
    description: z.string().max(2000).optional(),
  })
  .passthrough();

/** Matching step complete output — passthrough tolerates extra top-level fields from LLM */
export const matchingSchema = z
  .object({
    entities: z.array(entityMatchSchema).max(20),
  })
  .passthrough();

export type EntityMatch = z.infer<typeof entityMatchSchema>;
export type MatchingOutput = z.infer<typeof matchingSchema>;

/*
matchingSchema → JSON Schema:
{
  "type": "object",
  "properties": {
    "entities": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "entityKey":            { "type": "string", "minLength": 1 },
          "entityName":           { "type": "string", "minLength": 1, "maxLength": 200 },        // optional
          "resolvedCategoryPath": { "type": "string", "maxLength": 300 },
          "knowledgePointKeys":   { "type": "array", "items": { "type": "string" }, "maxItems": 50 },
          "discoveredAliases":    { "type": "array", "items": { "type": "string" }, "maxItems": 20 },        // optional
          "keywords":             { "type": "array", "items": { "type": "string" }, "maxItems": 8 },          // optional
          "description":          { "type": "string", "maxLength": 2000 }                                     // optional
        },
        "required": ["entityKey", "resolvedCategoryPath", "knowledgePointKeys"],
        "additionalProperties": {}
      }
    }
  },
  "required": ["entities"],
  "additionalProperties": {}
}
*/
