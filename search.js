const { authorized, fetchStores } = require('./_lib');

module.exports = async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'Wrong or missing access key.' });
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 50);
    const { rows, count } = await fetchStores(req.query, (page - 1) * limit, limit);
    res.status(200).json({ rows, count, page, limit });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
