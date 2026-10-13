const { authorized, fetchColumns } = require('./_lib');

// Returns the countries and categories that exist in your data, with counts, for the dropdowns
module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong or missing access key.' });
  try {
    const rows = await fetchColumns('country,category');
    const tally = (key, max) => {
      const counts = {};
      rows.forEach((r) => {
        const v = (r[key] || '').trim();
        if (v) counts[v] = (counts[v] || 0) + 1;
      });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, max).map(([v, n]) => ({ v, n }));
    };
    res.status(200).json({ countries: tally('country', 200), categories: tally('category', 150) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
