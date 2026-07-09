// GET /.netlify/functions/serve-photo?key=...
// Serves a photo back out of Netlify Blobs as a plain public image response.
// This is the URL handed to Airtable so it can fetch and attach the photo itself — no
// authentication here on purpose, since Airtable's own servers need to reach it directly.
//
// Written using the newer "Functions 2.0" signature (Request/Response, .mjs) rather than the
// classic Lambda-style handler — Netlify Blobs' automatic credential injection only works
// reliably with this newer style, which is why this one file differs from the others.

import { getStore } from '@netlify/blobs';

export default async (req) => {
  const key = new URL(req.url).searchParams.get('key');
  if (!key) {
    return new Response('Missing key', { status: 400 });
  }
  try {
    const store = getStore('photos');
    const blob = await store.get(key, { type: 'arrayBuffer' });
    if (!blob) {
      return new Response('Not found', { status: 404 });
    }
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};
