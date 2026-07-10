// POST /.netlify/functions/scores  (also reachable at /api/scores — see netlify.toml redirect)
// Body: { store_id, store_name, score_key, value, author, updated_at }
//
// Last-write-wins upsert keyed on (store_id, score_key, author) — composite_key below.
// Unlike entries, scores ARE mutable (tap 3, change your mind, tap 4), so every call here
// overwrites the same record. A stale retry — one whose updated_at is older than what's
// already stored — is dropped instead of clobbering a newer value, so out-of-order network
// retries can never regress a score.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_SCORES = process.env.AIRTABLE_TABLE_SCORES || 'Scores';

function escFormula(v) {
  return String(v ?? '').replace(/"/g, '""');
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Malformed JSON body.' }) };
  }

  const { store_id, store_name, score_key, value, author, updated_at } = body;
  const missing = ['store_id', 'score_key', 'author', 'updated_at'].filter(
    (k) => body[k] === undefined || body[k] === null || body[k] === ''
  );
  if (missing.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `Missing required field(s): ${missing.join(', ')}` }) };
  }
  if (value !== null && value !== undefined && (!Number.isInteger(value) || value < 1 || value > 5)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'value must be an integer 1–5, or null to clear.' }) };
  }
  if (isNaN(Date.parse(updated_at))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'updated_at must be a valid ISO date string.' }) };
  }

  const compositeKey = `${store_id}::${score_key}::${author}`;
  const fields = {
    composite_key: compositeKey,
    store_id: String(store_id),
    store_name: store_name || '',
    score_key: String(score_key),
    value: value === undefined ? null : value,
    author: String(author),
    updated_at
  };

  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_SCORES)}`;
  const authHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  try {
    const lookupUrl = `${base}?filterByFormula=${encodeURIComponent(`{composite_key} = "${escFormula(compositeKey)}"`)}&maxRecords=1`;
    const lookupRes = await fetch(lookupUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!lookupRes.ok) {
      const t = await lookupRes.text();
      return { statusCode: lookupRes.status, body: JSON.stringify({ error: `Airtable error (lookup): ${t}` }) };
    }
    const lookupData = await lookupRes.json();

    let res;
    if (lookupData.records && lookupData.records.length) {
      const existing = lookupData.records[0];
      const existingUpdatedAt = existing.fields.updated_at;
      if (existingUpdatedAt && Date.parse(existingUpdatedAt) > Date.parse(updated_at)) {
        // A newer value is already stored — this write is stale. Drop it rather than
        // regress the score (last-write-wins means the latest WRITE wins, not the latest
        // request to arrive).
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ok: true, skipped: 'stale', recordId: existing.id })
        };
      }
      res = await fetch(`${base}/${existing.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ fields }) });
    } else {
      res = await fetch(base, { method: 'POST', headers: authHeaders, body: JSON.stringify({ fields }) });
    }

    if (!res.ok) {
      const t = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: `Airtable error (write): ${t}` }) };
    }
    const data = await res.json();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, recordId: data.id })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
