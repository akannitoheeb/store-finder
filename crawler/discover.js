// Searches Google (via Serper) for each query in niches.txt and queues new store domains for the crawler.
const fs = require('fs');
const path = require('path');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const SERPER_KEY = process.env.SERPER_API_KEY;
const MAX_SEARCHES = parseInt(process.env.DISCOVER_MAX_SEARCHES) || 05; // Serper credits used per run

if (!SB_URL || !SB_KEY || !SERPER_KEY) { console.error('Missing SUPABASE_URL, SUPABASE_SERVICE_KEY or SERPER_API_KEY.'); process.exit(1); }

const sbHeaders = { apikey: SB_KEY, 'Content-Type': 'application/json' };
if (!SB_KEY.startsWith('sb_')) sbHeaders.Authorization = 'Bearer ' + SB_KEY;

// Sites that show up in results but are not independent stores
const BLOCKED = [
  'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'aliexpress.com', 'alibaba.com', 'temu.com',
  'facebook.com', 'instagram.com', 'pinterest.com', 'tiktok.com', 'youtube.com', 'reddit.com', 'twitter.com', 'x.com',
  'linkedin.com', 'wikipedia.org', 'quora.com', 'medium.com', 'substack.com', 'wordpress.com', 'blogspot.com',
  'shopify.com', 'google.com', 'apple.com', 'yelp.com', 'trustpilot.com', 'tripadvisor.com', 'forbes.com',
  'vogue.com', 'nytimes.com', 'theguardian.com', 'businessinsider.com', 'github.com', 'wix.com', 'squarespace.com',
];
const isBlocked = (h) => BLOCKED.some((b) => h === b || h.endsWith('.' + b)) || /\.(gov|edu)(\.|$)/.test(h);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q, gl, page) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': SERPER_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl, page }),
  });
  if (!r.ok) throw new Error(`Serper ${r.status}: ${(await r.text()).slice(0, 100)}`);
  return (await r.json()).organic || [];
}

async function knownDomains() {
  const known = new Set();
  for (const table of ['stores', 'discovered_domains']) {
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}?select=domain&limit=1000&offset=${offset}`, { headers: sbHeaders });
      if (!r.ok) throw new Error(`Could not read ${table}: ` + (await r.text()));
      const rows = await r.json();
      rows.forEach((x) => known.add(x.domain));
      if (rows.length < 1000) break;
    }
  }
  return known;
}

(async () => {
  const lines = fs.readFileSync(path.join(__dirname, 'niches.txt'), 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
  const queries = lines.map((l) => {
    const [q, gl] = l.split('|').map((s) => s.trim());
    return { q, gl: (gl || 'us').toLowerCase() };
  }).sort(() => Math.random() - 0.5).slice(0, MAX_SEARCHES);

  const known = await knownDomains();
  const found = new Map();

  for (const { q, gl } of queries) {
    const page = 1 + Math.floor(Math.random() * 5); // vary the page so repeat runs find new stores
    try {
      const results = await search(q, gl, page);
      let added = 0;
      for (const item of results) {
        let host;
        try { host = new URL(item.link).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { continue; }
        if (isBlocked(host) || known.has(host) || found.has(host)) continue;
        found.set(host, { domain: host, query: q });
        added++;
      }
      console.log(`"${q}" (${gl}, page ${page}): ${results.length} results, ${added} new`);
    } catch (e) {
      console.log(`error on "${q}": ${e.message}`);
    }
    await sleep(500);
  }

  if (found.size) {
    const r = await fetch(`${SB_URL}/rest/v1/discovered_domains?on_conflict=domain`, {
      method: 'POST',
      headers: { ...sbHeaders, Prefer: 'resolution=ignore-duplicates' },
      body: JSON.stringify([...found.values()]),
    });
    if (!r.ok) throw new Error('Could not save domains: ' + (await r.text()));
  }
  console.log(`Done. Queued ${found.size} new domains for the crawler.`);
})();
