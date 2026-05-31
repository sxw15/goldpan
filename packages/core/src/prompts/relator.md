<gp_entity_context>
{{#each entities}}
[{{entityKey}}] {{entityName}}
{{#each points}}
- [{{pointKey}}] ({{type}}) {{{content}}}
{{/each}}

{{/each}}
</gp_entity_context>

Extract relationships between the entities listed above. For each relationship, provide:
- `sourceEntityKey`: the entity key of the relationship source
- `targetEntityKey`: the entity key of the relationship target
- `relationType`: one of "organizational", "competitive", "collaborative", "technical", "causal", "general"
- `description`: concise description of the relationship
