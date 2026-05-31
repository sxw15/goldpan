Context:
- Available presets: {{presetNames}}
- User message: {{userInput}}

Output JSON with key "kind" and supporting fields. Valid shapes:
- {"kind":"subscribe","presetName":"<name>","pushTime":"HH:MM"}
- {"kind":"unsubscribe"[,"presetName":"<name>"]}
- {"kind":"list"}
- {"kind":"pause"[,"presetName":"<name>"]}
- {"kind":"resume"[,"presetName":"<name>"]}
- {"kind":"set_push_time"[,"presetName":"<name>"],"pushTime":"HH:MM"}

Rules:
- Only use presetName values from the list above.
- Time must be 24h HH:MM local format.
- If the user's request is ambiguous, choose the closest match or fall back to "list".

Output JSON only, no surrounding prose.
