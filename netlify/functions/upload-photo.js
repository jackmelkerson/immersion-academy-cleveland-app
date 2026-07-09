// POST /.netlify/functions/upload-photo
// Body: { recordId, filename, contentType, base64 }
//
// Airtable's direct byte-upload endpoint (uploadAttachment) was returning NOT_FOUND for this
// base even via a raw curl call bypassing this function entirely — an Airtable-side issue, not
// a bug here. This version uses Airtable's older, more universally-supported method instead:
// stash the photo in Netlify Blobs, hand Airtable a public URL to fetch it from, and attach it
// to the record that way. This has worked reliably for attachments since long before the newer
// endpoint existed.

const { getStore } = require('@netlify/blobs');

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Field Notes';
const AIRTABLE_PHOTOS_FIELD = process.env.AIRTABLE_PHOTOS_FIELD || 'Photos';

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Use POST' }) };
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }) };
  }

  try {
    const { recordId, filename, contentType, base64 } = JSON.parse(event.body || '{}');
    if (!recordId || !base64) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing recordId or file data.' }) };
    }

    // 1. Store the photo bytes in Netlify Blobs.
    const store = getStore('photos');
    const key = `${recordId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.set(key, Buffer.from(base64, 'base64'), {
      metadata: { contentType: contentType || 'image/jpeg' }
    });

    // 2. Build a public URL Airtable's servers can fetch it from.
    const host = event.headers['x-forwarded-host'] || event.headers.host;
    const proto = event.headers['x-forwarded-proto'] || 'https';
    const publicUrl = `${proto}://${host}/.netlify/functions/serve-photo?key=${encodeURIComponent(key)}`;

    // 3. Read the record's current Photos so we append rather than overwrite existing ones.
    const recordUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
    const getRes = await fetch(recordUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!getRes.ok) {
      const text = await getRes.text();
      return { statusCode: getRes.status, body: JSON.stringify({ error: `Airtable error (reading record): ${text}` }) };
    }
    const record = await getRes.json();
    const existing = (record.fields && record.fields[AIRTABLE_PHOTOS_FIELD]) || [];

    // 4. Patch the record with the existing attachments plus the new one appended.
    //    Only url/filename are sent back — including Airtable's own id/size/type fields on
    //    an update can trigger an INVALID_ATTACHMENT_OBJECT error.
    const patchRes = await fetch(recordUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fields: {
          [AIRTABLE_PHOTOS_FIELD]: [
            ...existing.map((a) => ({ url: a.url, filename: a.filename })),
            { url: publicUrl, filename: filename || `photo_${Date.now()}.jpg` }
          ]
        }
      })
    });
    if (!patchRes.ok) {
      const text = await patchRes.text();
      return { statusCode: patchRes.status, body: JSON.stringify({ error: `Airtable error (attaching): ${text}` }) };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, url: publicUrl })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
