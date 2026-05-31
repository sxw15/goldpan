<gp_entity_context>
{{#each entities}}
[{{entityKey}}] {{entityName}}
{{#each points}}
- [{{pointKey}}] ({{type}}) {{{content}}}
{{/each}}

{{/each}}
</gp_entity_context>

从上面列出的实体中提取它们之间的关系。每条关系请提供：
- `sourceEntityKey`：关系源实体的 entityKey
- `targetEntityKey`：关系目标实体的 entityKey
- `relationType`：取值为 "organizational"、"competitive"、"collaborative"、"technical"、"causal"、"general" 之一
- `description`：关系的简洁描述
