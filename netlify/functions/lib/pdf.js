const PDFSHIFT_URL = 'https://api.pdfshift.io/v3/convert/pdf';

// PDFShift's `source` field accepts either raw HTML or a URL it fetches
// itself — used both ways by callers: statement HTML we built ourselves,
// and each underlying ApparelMagic invoice's existing print_url.
//
// use_print:true is essential, not optional — PDFShift defaults to
// screen media, which for the AM invoice URL captures its interactive
// on-screen view (a wide desktop layout plus its floating Print/Close
// toolbar) instead of AM's actual print stylesheet, and for our own
// statement HTML silently skips the @media print rules entirely (e.g.
// the zoom:0.9 print-size reduction never applied to emailed/downloaded
// PDFs — only to the browser's own Print dialog — until this was added).
async function pdfFromSource(source) {
  const apiKey = (process.env.PDFSHIFT_API_KEY || '').trim();
  const res = await fetch(PDFSHIFT_URL, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, format: 'A4', use_print: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PDFShift failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

module.exports = { pdfFromSource };
