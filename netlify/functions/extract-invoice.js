const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// One field per thing the Bills Import table/CSV export actually needs — see
// extPDF() in the Bills tab, which maps this straight into row.invoice/row.ec.
// Nullable fields use ["string","null"] rather than omitting them from
// `required`, since additionalProperties:false schemas expect every declared
// property present (as null when the model can't find it on the page).
const SCHEMA = {
  type: 'object',
  properties: {
    supplier_name: { type: ['string', 'null'], description: 'The company or person who issued/sent the invoice (never the recipient, KOH Industries / WNDRR).' },
    invoice_number: { type: ['string', 'null'], description: 'The invoice number as printed on the document.' },
    invoice_date: { type: ['string', 'null'], description: 'Invoice/issue date in YYYY-MM-DD format.' },
    due_date: { type: ['string', 'null'], description: 'Payment due date in YYYY-MM-DD format, if shown.' },
    total_amount_inc_gst: { type: ['number', 'null'], description: 'The final total amount payable, including GST/tax.' },
    reference_or_po: { type: ['string', 'null'], description: 'A purchase order number or reference code, if shown.' },
    bank_account_name: { type: ['string', 'null'], description: "The supplier's bank account name for payment, if shown." },
    bank_bsb: { type: ['string', 'null'], description: 'BSB number for payment, if shown.' },
    bank_account_number: { type: ['string', 'null'], description: 'Bank account number for payment, if shown.' },
    email: { type: ['string', 'null'], description: "The supplier's contact email address, if shown." },
  },
  required: [
    'supplier_name', 'invoice_number', 'invoice_date', 'due_date',
    'total_amount_inc_gst', 'reference_or_po',
    'bank_account_name', 'bank_bsb', 'bank_account_number', 'email',
  ],
  additionalProperties: false,
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    // Three input shapes: fileBase64+mediaType (PDF/image — original path),
    // pdfBase64 (kept working for whatever still calls the single-purpose
    // shape), or plain text (CSV/XLSX — those already get their content
    // flattened to text client-side for the regex pipeline, and Claude has
    // no way to parse raw XLSX bytes anyway, so reusing that same text is
    // both simpler and more reliable than trying to ship the binary file).
    const fileBase64 = body.fileBase64 || body.pdfBase64;
    const mediaType = body.mediaType || 'application/pdf';
    const text = body.text;

    let content;
    if (text) {
      // Cap length — a large spreadsheet shouldn't turn into an oversized,
      // expensive request; any single invoice's fields live well within this.
      const clipped = String(text).slice(0, 8000);
      content = [{
        type: 'text',
        text: 'Extract the fields from this supplier invoice text. The invoice is addressed TO KOH Industries or WNDRR — never return those as the supplier. If a field is not present, return null for it rather than guessing.\n\nInvoice text:\n\n' + clipped,
      }];
    } else {
      if (!fileBase64) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing fileBase64 or text' }) };
      }
      if (mediaType !== 'application/pdf' && !IMAGE_TYPES.includes(mediaType)) {
        return { statusCode: 400, body: JSON.stringify({ error: `Unsupported mediaType: ${mediaType}` }) };
      }
      const fileBlock = mediaType === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: mediaType, data: fileBase64 } }
        : { type: 'image', source: { type: 'base64', media_type: mediaType, data: fileBase64 } };
      content = [
        fileBlock,
        {
          type: 'text',
          text: 'Extract the fields from this supplier invoice. The invoice is addressed TO KOH Industries or WNDRR — never return those as the supplier. If a field is not present on the document, return null for it rather than guessing.',
        },
      ];
    }

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        output_config: { format: { type: 'json_schema', schema: SCHEMA } },
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `Anthropic API failed (${res.status})`;
      return { statusCode: 502, body: JSON.stringify({ error: msg }) };
    }

    const textBlock = (data.content || []).find((b) => b.type === 'text');
    if (!textBlock) {
      return { statusCode: 502, body: JSON.stringify({ error: 'No structured output returned' }) };
    }

    const fields = JSON.parse(textBlock.text);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, fields }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
