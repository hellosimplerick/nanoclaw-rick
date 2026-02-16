export type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
};

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

export async function braveSearch(query: string): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;

  if (!apiKey) {
    console.warn('[braveSearch] No BRAVE_SEARCH_API_KEY set.');
    return [];
  }

  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', '5');

  const response = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey,
    },
  });

  if (!response.ok) {
    console.error(
      `[braveSearch] Request failed: ${response.status} ${response.statusText}`,
    );
    return [];
  }

  type BraveWebResult = {
    title?: string;
    url?: string;
    description?: string;
  };

  type BraveResponse = {
    web?: {
      results?: BraveWebResult[];
    };
  };

  const data = (await response.json()) as BraveResponse;


  const results: SearchResult[] = [];

  const webResults = data?.web?.results ?? [];

  for (const r of webResults) {
    if (!r.url) continue;

    // Optional: bias toward dev domains
    if (!r.url.includes('github.com')) continue;

    results.push({
      title: r.title ?? r.url,
      url: r.url,
      snippet: r.description ?? '',
    });
  }

  return results.slice(0, 5);
}

export function formatSearchResultsBlock(
  query: string,
  results: SearchResult[],
): string {
  const lines: string[] = [];
  lines.push('[Search Results]');
  lines.push(`Query: ${query}`);

  if (results.length === 0) {
    lines.push('No relevant results found.');
    return lines.join('\n') + '\n---\n';
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. ${r.title} — ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  }

  return lines.join('\n') + '\n---\n';
}
