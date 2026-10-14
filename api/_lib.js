// Shared helpers. Files starting with "_" are not exposed as API routes by Vercel.
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

function authorized(req) {
  const key = process.env.ACCESS_KEY;
  return Boolean(key) && req.headers['x-access-key'] === key;
}

const clean = (v) => String(v || '').replace(/[*,()]/g, '').trim();
const toArr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map((s) => String(s).trim()).filter(Boolean);
const quote = (s) => '"' + s.replace(/"/g, '\\"') + '"';
const SOCIAL = { instagram: 'instagram', facebook: 'facebook', tiktok: 'tiktok' };

// Turns the page's filters (include / exclude lists, ranges, switches) into a Supabase query
function buildFilters(q) {
  const p = new URLSearchParams();
  const conds = [];

  for (const col of ['platform', 'country', 'category']) {
    const inc = toArr(q[col + '_in']);
    const exc = toArr(q[col + '_ex']);
    if (inc.length) p.append(col, 'in.(' + inc.map(quote).join(',') + ')');
    // "not in" must keep stores where the field is empty, so it goes in an OR group
    if (exc.length) conds.push(`or(${col}.is.null,${col}.not.in.(${exc.map(quote).join(',')}))`);
  }
  if (conds.length) p.append('and', '(' + conds.join(',') + ')');

  toArr(q.social_in).forEach((s) => SOCIAL[s] && p.append(SOCIAL[s], 'not.is.null'));
  toArr(q.social_ex).forEach((s) => SOCIAL[s] && p.append(SOCIAL[s], 'is.null'));

  const min = parseInt(q.product_min), max = parseInt(q.product_max);
  if (!isNaN(min)) p.append('product_count', 'gte.' + min);
  if (!isNaN(max)) p.append('product_count', 'lte.' + max);

  if (q.q) p.set('domain', 'ilike.*' + clean(q.q) + '*');
  if (q.has_email === '1') p.set('emails', 'neq.{}');
  if (q.has_phone === '1') p.set('phones', 'neq.{}');
  if (q.klaviyo === '1') p.set('uses_klaviyo', 'eq.true');
  if (q.klaviyo === '0') p.set('uses_klaviyo', 'eq.false');
  if (q.pixel === '1') p.set('has_meta_pixel', 'eq.true');
  if (q.pixel === '0') p.set('has_meta_pixel', 'eq.false');
  if (q.active === '1') p.set('is_active', 'eq.true');
  return p;
}

const headers = () => {
  const h = { apikey: SB_KEY };
  if (!SB_KEY.startsWith('sb_')) h.Authorization = 'Bearer ' + SB_KEY;
  return h;
};

async function fetchStores(q, offset, limit) {
  const p = buildFilters(q);
  p.set('select', '*');
  p.set('order', 'created_at.desc');
  p.set('offset', String(offset));
  p.set('limit', String(limit));
  const r = await fetch(`${SB_URL}/rest/v1/stores?${p}`, { headers: { ...headers(), Prefer: 'count=exact' } });
  if (!r.ok) throw new Error('Supabase error: ' + (await r.text()));
  const rows = await r.json();
  const count = Number((r.headers.get('content-range') || '').split('/')[1]) || 0;
  return { rows, count };
}

// Reads some columns for every store (used for the filter counts)
async function fetchColumns(select) {
  let out = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/stores?select=${select}&order=id&limit=1000&offset=${offset}`, { headers: headers() });
    if (!r.ok) throw new Error('Supabase error: ' + (await r.text()));
    const rows = await r.json();
    out = out.concat(rows);
    if (rows.length < 1000) break;
  }
  return out;
}

module.exports = { authorized, fetchStores, fetchColumns };
