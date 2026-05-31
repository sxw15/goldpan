export interface RewriteContext {
  owner: string;
  repo: string;
  defaultBranch: string;
}

const LINK_RE = /(!?)\[([^\]]*)\]\((\.\/[^)]+|\.\.\/[^)]+|[^:)#][^)]*?)\)/g;

export function rewriteMarkdownLinks(markdown: string, ctx: RewriteContext): string {
  return markdown.replace(LINK_RE, (match, bang: string, text: string, href: string) => {
    if (/^https?:\/\//i.test(href)) return match;
    if (href.startsWith('#')) return match;
    if (href.startsWith('mailto:')) return match;

    const clean = href.replace(/^\.\//, '').replace(/^\/+/, '');
    const base =
      bang === '!'
        ? `https://raw.githubusercontent.com/${ctx.owner}/${ctx.repo}/${ctx.defaultBranch}`
        : `https://github.com/${ctx.owner}/${ctx.repo}/blob/${ctx.defaultBranch}`;
    return `${bang}[${text}](${base}/${clean})`;
  });
}
