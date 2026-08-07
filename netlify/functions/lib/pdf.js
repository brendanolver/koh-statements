const PDFSHIFT_URL = 'https://api.pdfshift.io/v3/convert/pdf';

// PDFShift's `source` field accepts either raw HTML or a URL it fetches
// itself — used both ways by callers: statement HTML we built ourselves,
// and each underlying ApparelMagic invoice's existing print_url.
async function pdfFromSource(source) {
  const apiKey = (process.env.PDFSHIFT_API_KEY || '').trim();
  const res = await fetch(PDFSHIFT_URL, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, format: 'A4' }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PDFShift failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

module.exports = { pdfFromSource };
