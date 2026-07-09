// POST /.netlify/functions/submit-entry
// Body: { stopKey, storeName, banner, address, submittedBy, notes, rating }
// Creates a brand-new row in Airtable every time it's called — nothing is ever overwritten.
// Returns the new recordId so the front-end can attach any staged photos to this exact entry.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Field Notes';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }) };
  }

  try {
    const { stopKey, storeName, banner, address, submittedBy, notes, rating } = JSON.parse(event.body || '{}');
    if (!stopKey) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing stopKey.' }) };
    }

    const fields = {
      StopKey: stopKey,
      'Store Name': storeName || '',
      Banner: banner || '',
      Address: address || '',
      'Submitted By': submittedBy || '',
      Notes: notes || ''
    };
    if (rating) fields.Rating = Number(rating);

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: `Airtable error: ${text}` }) };
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
