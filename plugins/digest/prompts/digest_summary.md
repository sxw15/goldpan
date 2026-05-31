Input snapshot (JSON):
{{snapshotJson}}

Produce a JSON object with exactly these keys:
- "headline": one-sentence highlight (≤ 80 chars)
- "bullets": array of 2-5 strings, each a one-sentence highlight referencing a concrete
  item in the snapshot (prefer findings and thoughts)
- "closing": optional one-sentence outlook (may be empty string)

Rules:
- Do NOT invent items not present in the snapshot.
- Prefer specific titles/URLs over generic phrasing.
- Keep tone neutral, informative, no emojis.

Output ONLY the JSON object, no surrounding prose.
