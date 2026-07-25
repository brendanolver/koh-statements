const AM_BASE = 'https://kohindustries.app.apparelmagic.com/api';
const ALLOWED = ['customers', 'invoices'];

exports.handler = async (event) => {
  const AM_TOKEN = process.env.AM_TOKEN;
  if (!AM_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: 'AM_TOKEN not configured' }) };
  }

  const params = { ...(event.queryStringParameters || {}) };
  const path = params.path;
  if (!path || !ALLOWED.some((a) => path === a || path.startsWith(a + '/'))) {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid path' }) };
  }
  delete params.path;

  const t = Date.now();
  const qs = new URLSearchParams({ ...params, token: AM_TOKEN, time: t }).toString();
  const url = `${AM_BASE}/${path}/?${qs}`;

  try {
    const resp = await fetch(url);
    const text = await resp.text();
    return {
      statusCode: resp.status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: text,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
