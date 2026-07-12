// GET /.netlify/functions/data  (also reachable at /api/data — see netlify.toml redirect)
//
// Full pull of the shared dataset: every locked entry and every (store, score_key, author)
// score. No server-side filtering or merging — the client reconciles this against its own
// local state so a pull can never clobber unsynced local data.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ENTRIES = process.env.AIRTABLE_TABLE_ENTRIES || 'Entries';
const AIRTABLE_TABLE_SCORES = process.env.AIRTABLE_TABLE_SCORES || 'Scores';

async function fetchAll(tableName) {
  const all = [];
  let offset = '';
  do {
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(tableName)}?pageSize=100${
      offset ? `&offset=${offset}` : ''
    }`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Airtable error (${tableName}): ${t}`);
    }
    const data = await res.json();
    all.push(...(data.records || []));
    offset = data.offset || '';
  } while (offset);
  return all;
}

exports.handler = async function () {
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }) };
  }
  try {
    const [entryRecords, scoreRecords] = await Promise.all([fetchAll(AIRTABLE_TABLE_ENTRIES), fetchAll(AIRTABLE_TABLE_SCORES)]);
    const entries = entryRecords.map((r) => r.fields);
    const scores = scoreRecords.map((r) => r.fields);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: true, entries, scores })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
