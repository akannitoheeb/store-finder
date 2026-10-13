// Shared helpers. Files starting with "_" are not exposed as API routes by Vercel.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function authorized(req) {
  const key = process.env.ACCESS_KEY;
  return Boolean(key) && req.headers['x-access-key'] === key;
}

// Remove characters that could break a PostgREST filter
const clean = (v) => String(v || '').replace(/[*,()]/g, '').trim();

function buildFilters(q) {
  const p = new URLSearchParams();
  if (q.platform) p.set('platform', 'eq.' + clean(q.platform));
  if (q.country) {
    const aliases = { uk: 'United Kingdom', gb: 'United Kingdom', us: 'United States', usa: 'United States', uae: 'United Arab Emirates' };
    const c = clean(q.country);
    p.set('country', 'ilike.*' + (aliases[c.toLowerCase()] || c) + '*');
  }
  if (q.category) p.set('category', 'ilike.*' + clean(q.category) + '*');
  if (q.q) p.set('domain', 'ilike.*' + clean(q.q) + '*');
  if (q.has_email === '1') p.set('emails', 'neq.{}');
  if (q.has_phone === '1') p.set('phones', 'neq.{}');
  if (q.has_instagram === '1') p.set('instagram', 'not.is.null');
  if (q.klaviyo === '1') p.set('uses_klaviyo', 'eq.true');
  if (q.klaviyo === '0') p.set('uses_klaviyo', 'eq.false');
  if (q.ads === '1') p.set('running_meta_ads', 'eq.true');
  return p;
}

async function fetchStores(q, offset, limit) {
  const p = buildFilters(q);
  p.set('select', '*');
  p.set('order', 'created_at.desc');
  p.set('offset', String(offset));
  p.set('limit', String(limit));

  const headers = { apikey: SB_KEY, Prefer: 'count=exact' };
  // Legacy JWT keys need the Authorization header; new "sb_" keys do not
  if (!SB_KEY.startsWith('sb_')) headers.Authorization = 'Bearer ' + SB_KEY;

  const r = await fetch(`${SB_URL}/rest/v1/stores?${p}`, { headers });
  if (!r.ok) throw new Error('Supabase error: ' + (await r.text()));
  const rows = await r.json();
  const range = r.headers.get('content-range') || '';
  const count = Number(range.split('/')[1]) || 0;
  return { rows, count };
}

module.exports = { authorized, fetchStores };
