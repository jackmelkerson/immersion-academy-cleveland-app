// POST /.netlify/functions/upload-photo
// Body: { recordId, filename, contentType, base64 }
// Uploads a single photo (already resized/compressed client-side, must stay under 5MB)
// directly to the Photos attachment field on the matching Airtable row.

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
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

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${recordId}/${encodeURIComponent(AIRTABLE_PHOTOS_FIELD)}/uploadAttachment`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contentType: contentType || 'image/jpeg',
        file: base64,
        filename: filename || `photo_${Date.now()}.jpg`
      })
    });

    if (!res.ok) {
      const text = await res.text();
      return { statusCode: res.status, body: JSON.stringify({ error: `Airtable error: ${text}` }) };
    }

    const data = await res.json();
    const fieldEntry = Object.values(data.fields || {})[0];
    const attachment = Array.isArray(fieldEntry) ? fieldEntry[fieldEntry.length - 1] : null;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, url: attachment ? attachment.url : null, filename: attachment ? attachment.filename : filename })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
