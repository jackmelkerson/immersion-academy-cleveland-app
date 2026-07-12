// POST /.netlify/functions/entries — two shapes, both POST (see below for why DELETE isn't used)
// (also reachable at /api/entries — see netlify.toml redirect)
//
// Upsert body: { entry_id, store_id, store_name, lens, dimension_id, dimension_name, timestamp, text, author }
// Idempotent upsert keyed on entry_id (a client-generated crypto.randomUUID()). A retry on
// flaky store wifi re-sends the same entry_id, which this function recognizes and re-writes
// onto the SAME Airtable record rather than creating a duplicate.
//
// Delete body: { action: 'delete', entry_id }
// Removes that one record. Deleting an entry_id that's already gone (or never existed) is
// treated as success, not an error — safe to retry from an offline queue. Deliberately a POST
// with an action flag rather than a true HTTP DELETE — some proxy layers don't forward
// non-GET/POST methods reliably through a rewrite, and POST is already proven to work end to end.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_ENTRIES = process.env.AIRTABLE_TABLE_ENTRIES || 'Entries';

const VALID_LENS = ['creative', 'strategy', 'one_thing'];

function escFormula(v) {
  return String(v ?? '').replace(/"/g, '""');
}

async function findRecordByEntryId(base, entryId) {
  const lookupUrl = `${base}?filterByFormula=${encodeURIComponent(`{entry_id} = "${escFormula(entryId)}"`)}&maxRecords=1`;
  const res = await fetch(lookupUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Airtable error (lookup): ${t}`);
  }
  const data = await res.json();
  return data.records && data.records.length ? data.records[0] : null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }) };
  }
  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_ENTRIES)}`;

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Malformed JSON body.' }) };
  }

  // ---------- Delete (POST with an action flag — see file header for why) ----------
  if (body.action === 'delete') {
    const { entry_id } = body;
    console.log('[entries] DELETE requested for entry_id=' + JSON.stringify(entry_id));
    if (!entry_id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing entry_id.' }) };
    }
    try {
      const existing = await findRecordByEntryId(base, entry_id);
      if (!existing) {
        console.log('[entries] DELETE: no record found with entry_id=' + JSON.stringify(entry_id) + ' — treating as already-gone.');
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, deleted: false }) };
      }
      console.log('[entries] DELETE: found record ' + existing.id + ' (its stored entry_id=' + JSON.stringify(existing.fields.entry_id) + '), deleting it now.');
      const delRes = await fetch(`${base}/${existing.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
      const delText = await delRes.text();
      console.log('[entries] DELETE: Airtable responded status=' + delRes.status + ' body=' + delText);
      if (!delRes.ok) {
        return { statusCode: delRes.status, body: JSON.stringify({ error: `Airtable error (delete): ${delText}` }) };
      }
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, deleted: true }) };
    } catch (err) {
      console.log('[entries] DELETE threw: ' + err.message);
      return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
  }

  // ---------- Create / upsert ----------
  const { entry_id, store_id, store_name, lens, dimension_id, dimension_name, timestamp, text, author } = body;

  // Validate server-side — reject anything malformed rather than let a broken record land in Airtable.
  const missing = ['entry_id', 'store_id', 'lens', 'dimension_id', 'timestamp', 'text', 'author'].filter(
    (k) => body[k] === undefined || body[k] === null || body[k] === ''
  );
  if (missing.length) {
    return { statusCode: 400, body: JSON.stringify({ error: `Missing required field(s): ${missing.join(', ')}` }) };
  }
  if (!VALID_LENS.includes(lens)) {
    return { statusCode: 400, body: JSON.stringify({ error: `lens must be one of ${VALID_LENS.join(', ')}` }) };
  }
  if (typeof text !== 'string' || !text.trim()) {
    return { statusCode: 400, body: JSON.stringify({ error: 'text must be a non-empty string.' }) };
  }
  if (isNaN(Date.parse(timestamp))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'timestamp must be a valid ISO date string.' }) };
  }

  const fields = {
    entry_id: String(entry_id),
    store_id: String(store_id),
    store_name: store_name || '',
    lens,
    dimension_id: String(dimension_id),
    dimension_name: dimension_name || '',
    timestamp,
    text,
    author: String(author)
  };

  const authHeaders = { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' };

  try {
    // Idempotency check — does a record with this entry_id already exist?
    const existing = await findRecordByEntryId(base, entry_id);
    console.log('[entries] UPSERT entry_id=' + JSON.stringify(entry_id) + (existing ? ' — already exists as ' + existing.id + ', patching' : ' — new, creating'));

    let res;
    if (existing) {
      // Already exists — this is a retry. Re-write the same record (a no-op in practice
      // since the content is identical) instead of creating a duplicate.
      res = await fetch(`${base}/${existing.id}`, { method: 'PATCH', headers: authHeaders, body: JSON.stringify({ fields }) });
    } else {
      res = await fetch(base, { method: 'POST', headers: authHeaders, body: JSON.stringify({ fields }) });
    }

    if (!res.ok) {
      const t = await res.text();
      console.log('[entries] UPSERT write failed: ' + t);
      return { statusCode: res.status, body: JSON.stringify({ error: `Airtable error (write): ${t}` }) };
    }
    const data = await res.json();
    console.log('[entries] UPSERT wrote record ' + data.id + ' with entry_id=' + JSON.stringify((data.fields || {}).entry_id));
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, recordId: data.id, entry_id })
    };
  } catch (err) {
    console.log('[entries] UPSERT threw: ' + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
