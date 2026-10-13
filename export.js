const { authorized, fetchStores } = require('./_lib');

const MAX_ROWS = 10000; // keeps the export inside Vercel's function time limit
const COLUMNS = [
  'domain', 'platform', 'country', 'category', 'emails', 'phones',
  'instagram', 'facebook', 'tiktok', 'uses_klaviyo', 'running_meta_ads',
  'product_count', 'source', 'last_crawled',
];

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong or missing access key.' });
  try {
    const lines = [COLUMNS.join(',')];
    let offset = 0;
    while (offset < MAX_ROWS) {
      const { rows } = await fetchStores(req.query, offset, 1000);
      rows.forEach((r) => lines.push(COLUMNS.map((c) => cell(r[c])).join(',')));
      if (rows.length < 1000) break;
      offset += 1000;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="stores.csv"');
    res.status(200).send(lines.join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
