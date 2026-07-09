// GET /.netlify/functions/serve-photo?key=...
// Serves a photo back out of Netlify Blobs as a plain public image response.
// This is the URL that gets handed to Airtable so it can fetch and attach the photo itself —
// no authentication here on purpose, since Airtable's own servers need to reach it directly.

const { getStore } = require('@netlify/blobs');

exports.handler = async function (event) {
  const key = event.queryStringParameters && event.queryStringParameters.key;
  if (!key) {
    return { statusCode: 400, body: 'Missing key' };
  }
  try {
    const store = getStore('photos');
    const blob = await store.get(key, { type: 'arrayBuffer' });
    if (!blob) {
      return { statusCode: 404, body: 'Not found' };
    }
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=31536000, immutable'
      },
      body: Buffer.from(blob).toString('base64'),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 500, body: `Error: ${err.message}` };
  }
};
