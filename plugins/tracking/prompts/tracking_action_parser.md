<gp_user_input>
{{{input}}}
</gp_user_input>

{{#if existingInterests}}
<gp_existing_interests>
{{#each existingInterests}}
Interest #{{this.id}}: "{{this.name}}" — search queries: {{this.searchQueries}} ({{#if this.enabled}}enabled{{else}}disabled{{/if}})
{{/each}}
</gp_existing_interests>
{{/if}}
