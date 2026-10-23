// Reads crawler/domains.txt, visits each store, and saves what it finds to Supabase.
// Run locally:  SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node crawler/crawl.js
const fs = require('fs');
const path = require('path');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const MAX_PER_RUN = parseInt(process.env.MAX_PER_RUN) || 200; // stores per run
const RECRAWL_DAYS = 14; // skip stores crawled more recently than this
const CONCURRENCY = 4;
const UA = 'Mozilla/5.0 (compatible; StoreFinder/1.0)';

if (!SB_URL || !SB_KEY) { console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.'); process.exit(1); }

const sbHeaders = { apikey: SB_KEY, 'Content-Type': 'application/json' };
if (!SB_KEY.startsWith('sb_')) sbHeaders.Authorization = 'Bearer ' + SB_KEY;

const COUNTRIES = {
  us: 'United States', gb: 'United Kingdom', uk: 'United Kingdom', ca: 'Canada', au: 'Australia',
  ng: 'Nigeria', gh: 'Ghana', ke: 'Kenya', za: 'South Africa', in: 'India', nz: 'New Zealand',
  tr: 'Turkey', al: 'Albania', se: 'Sweden', no: 'Norway', dk: 'Denmark', pl: 'Poland', pt: 'Portugal',
  br: 'Brazil', mx: 'Mexico', sg: 'Singapore', my: 'Malaysia', ph: 'Philippines', jp: 'Japan', kr: 'South Korea',
  sa: 'Saudi Arabia', eg: 'Egypt', hk: 'Hong Kong', cn: 'China', tw: 'Taiwan', th: 'Thailand', vn: 'Vietnam',
  id: 'Indonesia', ar: 'Argentina', cl: 'Chile', co: 'Colombia', pk: 'Pakistan', bd: 'Bangladesh', lk: 'Sri Lanka',
  ru: 'Russia', ua: 'Ukraine', ch: 'Switzerland', at: 'Austria', be: 'Belgium', fi: 'Finland', gr: 'Greece',
  cz: 'Czechia', ro: 'Romania', hu: 'Hungary', il: 'Israel', qa: 'Qatar', kw: 'Kuwait', tz: 'Tanzania', ug: 'Uganda', ie: 'Ireland', de: 'Germany', fr: 'France', es: 'Spain', it: 'Italy', nl: 'Netherlands', ae: 'United Arab Emirates',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalize(line) {
  return line.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
}

async function get(url, timeout = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/json' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return null;
    return (await r.text()).slice(0, 1500000);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Very simple robots.txt check: skip the store if "User-agent: *" disallows everything
async function allowed(domain) {
  const txt = await get(`https://${domain}/robots.txt`, 6000);
  if (!txt || /<html/i.test(txt)) return true;
  let applies = false;
  for (const raw of txt.split('\n')) {
    const line = raw.split('#')[0].trim().toLowerCase();
    if (line.startsWith('user-agent:')) applies = line.slice(11).trim() === '*';
    else if (applies && /^disallow:\s*\/\s*$/.test(line)) return false;
  }
  return true;
}

function detectPlatform(html) {
  if (/cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i.test(html)) return 'Shopify';
  if (/wp-content\/plugins\/woocommerce|woocommerce/i.test(html)) return 'WooCommerce';
  if (/static\.wixstatic\.com|wix\.com\/|X-Wix/i.test(html)) return 'Wix';
  if (/prestashop/i.test(html)) return 'PrestaShop';
  if (/cdn\d*\.bigcommerce\.com|bigcommerce/i.test(html)) return 'BigCommerce';
  if (/Magento|\/static\/version\d+\/frontend\//i.test(html)) return 'Magento';
  return null;
}

const BAD_EMAIL = /(\.(png|jpe?g|gif|webp|svg|css|js)$)|sentry|wixpress|example\.|yourdomain|domain\.com|shopify\.com|godaddy|email\.com|@2x|eposta\.com|powerfulform|^(ornek|name|user|username|test|sample|email|you|your|john|jane)@/i;
function findEmails(html) {
  const decoded = html.replace(/&#64;|&commat;|\[at\]/gi, '@');
  const found = decoded.match(/[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}/gi) || [];
  return [...new Set(found.map((e) => e.toLowerCase()).filter((e) => !BAD_EMAIL.test(e)))].slice(0, 5);
}

// Turns "(407) 621-4000" or "+1 407 621 4000" into "+14076214000". Returns null if it does not look like a real number.
function normalizePhone(raw) {
  let t = String(raw).replace(/\(0\)/g, '').trim();
  try { t = decodeURIComponent(t); } catch (e) { /* keep as is */ }
  const digits = t.replace(/\D/g, '');
  if (t.startsWith('+') || t.startsWith('00')) {
    const d = t.startsWith('+') ? digits : digits.slice(2);
    return /^[1-9]\d{7,14}$/.test(d) ? '+' + d : null;
  }
  if (/^1?[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return '+1' + digits.slice(-10); // US / Canada
  return null; // local formats (0801...) need the store's country: the audit tool handles those
}
const junkPhone = (p) => { const t = p.replace(/\D/g, '').slice(-10); return /^(\d)\1+$/.test(t) || '01234567890123456789'.includes(t); };

function findPhones(html) {
  const raw = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  for (const m of html.matchAll(/(?:wa\.me\/|whatsapp\.com\/send\/?\?phone=)(\d{8,15})/gi)) raw.push('+' + m[1]);
  for (const m of html.matchAll(/"telephone"\s*:\s*"([^"]+)"/gi)) raw.push(m[1]);
  const out = [];
  for (const r of raw) {
    const n = normalizePhone(r);
    if (n && !junkPhone(n) && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 3);
}

function findSocials(html, domain) {
  const out = {};
  const BAD = /^(p|reels?|explore|accounts|sharer|sharer\.php|share|share\.php|tr|plugins|dialog|policies|login|intent|shopify|stories|direct|tv|about|legal|developer|instagram|facebook|meta|home|profile\.php)$/i;
  const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const label = flat(String(domain || '').replace(/^www\./, '').split('.')[0]);
  // Among all handles on the page, prefer the one that looks like the store's own name (not a theme author or app)
  const pick = (re, min) => {
    const seen = [];
    for (const m of html.matchAll(re)) {
      const h = m[1].replace(/\.$/, '');
      if (BAD.test(h) || /\.(php|html?|png|jpe?g|gif|svg|js|css)$/i.test(h) || seen.includes(h)) continue;
      seen.push(h);
    }
    return seen.find((h) => label.length > 2 && (flat(h).includes(label) || label.includes(flat(h)))) || seen[0];
  };
  const ig = pick(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi);
  const fb = pick(/facebook\.com\/([A-Za-z0-9.\-]{3,})/gi);
  const tt = html.match(/tiktok\.com\/@([A-Za-z0-9._]{2,30})/);
  if (ig) out.instagram = 'https://instagram.com/' + ig;
  if (fb) out.facebook = 'https://facebook.com/' + fb;
  if (tt) out.tiktok = 'https://tiktok.com/@' + tt[1];
  return out;
}

function guessCountry(domain, html) {
  const tld = domain.split('.').pop();
  if (COUNTRIES[tld]) return COUNTRIES[tld];
  const m = html.match(/property=["']og:locale["'][^>]*content=["'][a-z]{2}_([A-Za-z]{2})/i);
  return m && COUNTRIES[m[1].toLowerCase()] ? COUNTRIES[m[1].toLowerCase()] : null;
}


// ---- store details taken from the homepage we already download (no extra requests) ----
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim();

function metaContent(html, attr, name) {
  const tag = html.match(new RegExp('<meta[^>]*' + attr + '=["\']' + name + '["\'][^>]*>', 'i'));
  if (!tag) return '';
  const m = tag[0].match(/content=(?:"([^"]*)"|'([^']*)')/i);
  return m ? decode(m[1] ?? m[2]) : '';
}

function pickName(title, domain) {
  const label = domain.replace(/^www\./, '').split('.')[0];
  const flat = (x) => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const parts = decode(title).split(/\s[|\-\u2013\u2014\u2022:]\s/).map((p) => p.trim()).filter(Boolean);
  const match = parts.find((p) => flat(p) && (flat(label).includes(flat(p)) || flat(p).includes(flat(label))));
  const generic = /^(home|homepage|welcome|shop|online store|official (web)?site)\b/i;
  const name = match || (parts.length === 1 && parts[0].length <= 40 && !generic.test(parts[0]) ? parts[0] : '');
  return name || label.charAt(0).toUpperCase() + label.slice(1);
}

function findInfo(html, domain) {
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]).slice(0, 200);
  const description = (metaContent(html, 'name', 'description') || metaContent(html, 'property', 'og:description')).slice(0, 500);
  const siteName = metaContent(html, 'property', 'og:site_name').slice(0, 80);
  const language = ((html.match(/<html[^>]*\slang=["']([a-zA-Z-]{2,10})["']/i) || [])[1] || '').slice(0, 10);
  return { title, description, language, site_name: siteName || pickName(title, domain) };
}

// Links to the store's own policy / info pages (Shipping, Returns, About ...)
function findPages(html, domain) {
  const KEYS = { shipping: /shipping|delivery/, returns: /return|refund/, about: /about/, faq: /faq/, terms: /terms/, privacy: /privacy/, contact: /contact/, wholesale: /wholesale/, affiliate: /affiliate|ambassador/ };
  const host = domain.replace(/^www\./, '');
  const out = {};
  for (const m of html.matchAll(/href=["']([^"'#\s]+)["']/gi)) {
    if (/^(mailto|tel|javascript):/i.test(m[1])) continue;
    let u; try { u = new URL(m[1], `https://${domain}/`); } catch (e) { continue; }
    if (u.hostname.replace(/^www\./, '') !== host) continue;
    const p = u.pathname.toLowerCase();
    if (/^\/(products|collections|cart|account|search)/.test(p) || p === '/') continue;
    for (const k in KEYS) if (!out[k] && KEYS[k].test(p)) out[k] = u.origin + u.pathname;
  }
  return Object.keys(out).length ? out : null;
}

async function crawl(domain, isNew) {
  if (!(await allowed(domain))) return { skip: 'blocked by robots.txt' };
  const home = await get(`https://${domain}`);
  if (!home) return { skip: 'site did not load', dead: true };
  const platform = detectPlatform(home);
  if (!platform) return { skip: 'not a recognised store platform' };

  // Contact page: use a link found on the homepage, otherwise try common paths
  const candidates = [];
  for (const m of home.matchAll(/href=["']([^"'#\s]*contact[^"'#\s]*)["']/gi)) {
    if (/^(mailto|tel|javascript|sms|whatsapp):/i.test(m[1])) continue; // "mailto:contact@..." is not a contact page
    try {
      const u = new URL(m[1], `https://${domain}/`);
      if (u.hostname.replace(/^www\./, '') === domain.replace(/^www\./, '')) { candidates.push(u.href); break; }
    } catch (e) { /* skip bad link */ }
  }
  candidates.push(`https://${domain}/pages/contact`, `https://${domain}/contact`, `https://${domain}/contact-us`);
  let contact = '';
  for (const url of candidates) { contact = (await get(url, 8000)) || ''; if (contact) break; }

  const all = home + '\n' + contact;
  const row = {
    domain, platform,
    uses_klaviyo: /klaviyo\.com/i.test(all),
    is_active: true,
    has_meta_pixel: /fbevents\.js|fbq\(|connect\.facebook\.net/i.test(all),
    last_crawled: new Date().toISOString(),
  };
  const country = guessCountry(domain, home);
  if (country) row.country = country;
  // Keep emails on the store's own domain; fall back to free-mail (gmail etc). Drops app-vendor emails.
  const parts = domain.split('.').filter((p) => p.length > 2 && !['www', 'com', 'org', 'net', 'shop', 'store'].includes(p));
  const label = parts.sort((a, b) => b.length - a.length)[0] || domain;
  const found = findEmails(all);
  const own = found.filter((e) => e.split('@')[1].includes(label));
  const free = found.filter((e) => /@(gmail|yahoo|outlook|hotmail|icloud|proton|protonmail)\./.test(e));
  const emails = own.length ? own : free;
  if (emails.length) row.emails = emails;
  else if (found.length) row.emails = []; // only vendor/junk emails found: clear any old ones
  const phones = findPhones(all); if (phones.length) row.phones = phones;
  Object.assign(row, findSocials(all, domain));
  Object.assign(row, findInfo(home, domain));
  const pages = findPages(home, domain); if (pages) row.pages = pages;
  if (isNew) row.source = 'crawler';

  if (platform === 'Shopify') {
    try {
      const m = JSON.parse(await get(`https://${domain}/meta.json`, 8000));
      if (m.country) row.country = COUNTRIES[String(m.country).toLowerCase()] || m.country;
      if (m.name) row.site_name = String(m.name).slice(0, 80);
      if (m.description && !row.description) row.description = String(m.description).slice(0, 500);
      if (m.currency) row.currency = String(m.currency).slice(0, 8);
      if (m.primary_locale) row.language = String(m.primary_locale).slice(0, 10);
      const loc = [m.city, m.province].filter(Boolean).join(', '); if (loc) row.location = loc.slice(0, 80);
      if (Number.isFinite(Number(m.published_products_count))) row.total_products = Number(m.published_products_count);
    } catch (e) { /* meta.json not public, keep the domain-based guess */ }
    const json = await get(`https://${domain}/products.json?limit=250`, 10000);
    try {
      const products = JSON.parse(json).products || [];
      row.product_count = products.length; // capped at 250 by Shopify
      const counts = {};
      products.forEach((p) => { if (p.product_type) counts[p.product_type] = (counts[p.product_type] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) row.category = top[0];
    } catch (e) { /* products.json not public, ignore */ }
  }
  return { row };
}

// A store that used to load but no longer does is marked inactive (set back to active on the next good crawl)
async function markInactive(domain) {
  await fetch(`${SB_URL}/rest/v1/stores?domain=eq.${encodeURIComponent(domain)}`, {
    method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ is_active: false, last_crawled: new Date().toISOString() }),
  });
}

async function save(row) {
  const r = await fetch(`${SB_URL}/rest/v1/stores?on_conflict=domain`, {
    method: 'POST',
    headers: { ...sbHeaders, Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(await r.text());
}

async function existingStores() {
  const map = new Map();
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${SB_URL}/rest/v1/stores?select=domain,last_crawled,site_name,is_active&limit=1000&offset=${offset}`, { headers: sbHeaders });
    if (!r.ok) throw new Error('Could not read stores: ' + (await r.text()));
    const rows = await r.json();
    rows.forEach((s) => map.set(s.domain, { last: s.last_crawled, name: s.site_name, active: s.is_active }));
    if (rows.length < 1000) break;
  }
  return map;
}

// Domains queued by discover.js (ignored quietly if that table does not exist yet)
async function pendingDiscovered() {
  const r = await fetch(`${SB_URL}/rest/v1/discovered_domains?select=domain&status=eq.pending&order=found_at.asc&limit=${MAX_PER_RUN}`, { headers: sbHeaders });
  if (!r.ok) return [];
  return (await r.json()).map((x) => x.domain);
}
async function markDiscovered(domain, status) {
  await fetch(`${SB_URL}/rest/v1/discovered_domains?domain=eq.${encodeURIComponent(domain)}`, {
    method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ status }),
  });
}

(async () => {
  const file = fs.readFileSync(path.join(__dirname, 'domains.txt'), 'utf8');
  const domains = [...new Set(file.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map(normalize))];
  const existing = await existingStores();
  const cutoff = Date.now() - RECRAWL_DAYS * 86400000;
  const queue = domains.filter((d) => !existing.has(d) || new Date(existing.get(d).last).getTime() < cutoff).slice(0, MAX_PER_RUN);
  const pending = new Set(await pendingDiscovered());
  for (const d of pending) if (queue.length < MAX_PER_RUN && !queue.includes(d)) queue.push(d);
  // Stores saved before names existed: fill them in, a batch per run
  for (const [d, v] of existing) if (queue.length < MAX_PER_RUN && !v.name && v.active !== false && !queue.includes(d)) queue.push(d);
  console.log(`${domains.length} domains listed, ${pending.size} discovered, ${queue.length} to crawl this run.`);

  let saved = 0, skipped = 0, failed = 0;
  async function worker() {
    while (queue.length) {
      const domain = queue.shift();
      try {
        const res = await crawl(domain, !existing.has(domain));
        if (res.skip) { skipped++; console.log(`skip  ${domain}: ${res.skip}`); if (res.dead && existing.has(domain)) await markInactive(domain); }
        else { await save(res.row); saved++; console.log(`saved ${domain} (${res.row.platform}, ${(res.row.emails || []).length} emails)`); }
        if (pending.has(domain)) await markDiscovered(domain, res.skip ? 'skipped' : 'done');
      } catch (e) {
        failed++; console.log(`error ${domain}: ${e.message.slice(0, 120)}`);
        if (pending.has(domain)) await markDiscovered(domain, 'error');
      }
      await sleep(1000);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Done. Saved ${saved}, skipped ${skipped}, errors ${failed}.`);
})();
