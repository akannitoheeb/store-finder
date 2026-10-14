const { authorized, fetchColumns } = require('./_lib');

// Counts for every filter option, like BootLeads shows next to each choice
module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong or missing access key.' });
  try {
    const rows = await fetchColumns('platform,country,category,instagram,facebook,tiktok');
    const tally = (key, max) => {
      const counts = {};
      rows.forEach((r) => {
        const v = (r[key] || '').trim();
        if (v) counts[v] = (counts[v] || 0) + 1;
      });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, max).map(([v, n]) => ({ v, n }));
    };
    const has = (k) => rows.filter((r) => r[k]).length;
    res.status(200).json({
      total: rows.length,
      platforms: tally('platform', 20),
      countries: tally('country', 250),
      categories: tally('category', 300),
      socials: { instagram: has('instagram'), facebook: has('facebook'), tiktok: has('tiktok') },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
