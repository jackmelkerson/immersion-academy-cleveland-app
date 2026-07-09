// POST /.netlify/functions/upload-photo
// Body: { recordId, filename, contentType, base64 }
//
// Airtable's direct "upload bytes" endpoint (uploadAttachment) returned NOT_FOUND for this base
// even via a raw curl call bypassing this app entirely — confirmed as an Airtable-side issue.
// This uses Airtable's older, more universally-supported method instead: stash the photo in
// Netlify Blobs, hand Airtable a public URL to fetch it from, and attach it to the record that
// way — the way attachments have worked reliably in Airtable for years.
//
// Written using the newer "Functions 2.0" signature (Request/Response, .mjs) rather than the
// classic Lambda-style handler — Netlify Blobs' automatic credential injection only works
// reliably with this newer style, which is why this one file differs from the others.

import { getStore } from '@netlify/blobs';

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE || 'Field Notes';
const AIRTABLE_PHOTOS_FIELD = process.env.AIRTABLE_PHOTOS_FIELD || 'Photos';

export default async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Use POST' }), { status: 405 });
  }
  if (!AIRTABLE_TOKEN || !AIRTABLE_BASE_ID) {
    return new Response(JSON.stringify({ error: 'Airtable environment variables are not configured yet.' }), { status: 500 });
  }

  try {
    const { recordId, filename, contentType, base64 } = await req.json();
    if (!recordId || !base64) {
      return new Response(JSON.stringify({ error: 'Missing recordId or file data.' }), { status: 400 });
    }

    // 1. Store the photo bytes in Netlify Blobs.
    const store = getStore('photos');
    const key = `${recordId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await store.set(key, Buffer.from(base64, 'base64'), {
      metadata: { contentType: contentType || 'image/jpeg' }
    });

    // 2. Build a public URL Airtable's servers can fetch it from.
    const reqUrl = new URL(req.url);
    const host = req.headers.get('x-forwarded-host') || reqUrl.host;
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const publicUrl = `${proto}://${host}/.netlify/functions/serve-photo?key=${encodeURIComponent(key)}`;

    // 3. Read the record's current Photos so we append rather than overwrite existing ones.
    const recordUrl = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`;
    const getRes = await fetch(recordUrl, { headers: { Authorization: `Bearer ${AIRTABLE_TOKEN}` } });
    if (!getRes.ok) {
      const text = await getRes.text();
      return new Response(JSON.stringify({ error: `Airtable error (reading record): ${text}` }), { status: getRes.status });
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
      return new Response(JSON.stringify({ error: `Airtable error (attaching): ${text}` }), { status: patchRes.status });
    }

    return new Response(JSON.stringify({ ok: true, url: publicUrl }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
