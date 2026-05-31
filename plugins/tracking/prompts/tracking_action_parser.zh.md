<gp_user_input>
{{{input}}}
</gp_user_input>

{{#if existingInterests}}
<gp_existing_interests>
{{#each existingInterests}}
追踪项 #{{this.id}}："{{this.name}}" — 搜索词：{{this.searchQueries}}（{{#if this.enabled}}已启用{{else}}已禁用{{/if}}）
{{/each}}
</gp_existing_interests>
{{/if}}
