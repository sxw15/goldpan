const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'twclid',
  'mc_eid',
  '_ga',
  '_gl',
  'igshid',
  'oly_anon_id',
  'oly_enc_id',
  '_openstat',
  'vero_id',
  'wickedid',
  'yclid',
  'spm',
  'scm',
]);

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

export function normalizeUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const safePreview = raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
    throw new Error(`Invalid URL: ${safePreview}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${url.protocol}`);
  }

  url.protocol = 'https:';
  url.username = '';
  url.password = '';
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  if (url.hostname.startsWith('www.') && url.hostname.length > 4) {
    url.hostname = url.hostname.slice(4);
  }

  url.hash = '';

  if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.replace(/\/+$/, '');
  }

  const params = new URLSearchParams(url.search);
  const filtered: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (!isTrackingParam(key)) {
      filtered.push([key, value]);
    }
  }
  filtered.sort(([aKey], [bKey]) => (aKey < bKey ? -1 : aKey > bKey ? 1 : 0));

  if (filtered.length > 0) {
    url.search = `?${new URLSearchParams(filtered).toString()}`;
  } else {
    url.search = '';
  }

  let result = url.toString();
  if (result.endsWith('/') && url.pathname === '/') {
    result = result.slice(0, -1);
  }
  return result;
}
