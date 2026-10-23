const { authorized, headers, SB_URL } = require('./_lib');

// Which stores have really been audited? Reads the leads saved by the site-audit tool.
// Works when both tools share one Supabase project. If the leads table is not there, it returns an empty list and nothing breaks.
module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong or missing access key.' });
  const table = process.env.LEADS_TABLE || 'leads';
  const out = {};
  try {
    for (let offset = 0; offset < 10000; offset += 1000) {
      const r = await fetch(`${SB_URL}/rest/v1/${table}?select=url,status,emailed,updated_at&order=updated_at.desc&limit=1000&offset=${offset}`, { headers: headers() });
      if (!r.ok) break;
      const rows = await r.json();
      for (const l of rows) {
        let host = '';
        try { host = new URL(l.url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { continue; }
        if (!out[host]) out[host] = { status: l.status || 'New', at: Date.parse(l.updated_at) || Date.now(), emailed: Boolean(l.emailed) };
      }
      if (rows.length < 1000) break;
    }
  } catch (e) { /* leave the list empty */ }
  res.status(200).json({ audited: out });
};
