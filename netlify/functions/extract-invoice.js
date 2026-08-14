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
    supplier_name: { type: ['string', 'null'], description: 'The company or person who issued/sent the invoice — never the recipient (KOH Industries / WNDRR), even if their details also appear on the page (e.g. in a "To:"/billing-address section).' },
    invoice_number: { type: ['string', 'null'], description: "The invoice number as printed. If the source is a spreadsheet and the number shows a spreadsheet formatting artifact (e.g. '276.0' for what is really invoice 276), return the clean form ('276')." },
    invoice_date: { type: ['string', 'null'], description: "Invoice/issue date in YYYY-MM-DD format. If the day and month are shown but no year is printed anywhere on the document, use the current date's year (given below) rather than guessing a different one." },
    due_date: { type: ['string', 'null'], description: "Payment due date in YYYY-MM-DD format, if shown. Same rule as invoice_date for a missing year." },
    total_amount_inc_gst: { type: ['number', 'null'], description: 'The final total amount payable, including GST/tax.' },
    reference_or_po: { type: ['string', 'null'], description: 'A purchase order number or reference code, if shown.' },
    bank_account_name: { type: ['string', 'null'], description: "The SUPPLIER's own bank account name for receiving payment — never KOH Industries' or WNDRR's, if shown." },
    bank_bsb: { type: ['string', 'null'], description: "The SUPPLIER's own BSB number for receiving payment, if shown." },
    bank_account_number: { type: ['string', 'null'], description: "The SUPPLIER's own bank account number for receiving payment, if shown." },
    email: { type: ['string', 'null'], description: "The SUPPLIER's own contact email address — never an email belonging to KOH Industries or WNDRR (e.g. one appearing under a \"To:\"/recipient/billing section), even if it's the only email on the page." },
    currency: { type: ['string', 'null'], description: 'The invoice\'s currency — return exactly "AUD", "NZD", or "USD" (nothing else). Only return "NZD" or "USD" if there is a clear signal on the page — an explicit "NZ$"/"$NZD"/"NZD" or "US$"/"$USD"/"USD" symbol or code, or a supplier bank account explicitly described as a New Zealand or United States account. Otherwise return null (the app defaults to AUD) rather than guessing.' },
  },
  required: [
    'supplier_name', 'invoice_number', 'invoice_date', 'due_date',
    'total_amount_inc_gst', 'reference_or_po',
    'bank_account_name', 'bank_bsb', 'bank_account_number', 'email', 'currency',
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

    // Anchors "no year printed" dates (e.g. "9 August", confirmed live —
    // a real invoice with no year anywhere on it) to the actual current
    // year instead of leaving the model to guess one on its own. Live-
    // confirmed the model *will* guess rather than return null here: the
    // day/month ARE present on the page, so "return null if not present"
    // doesn't clearly cover a year that's specifically missing, and an
    // ungrounded guess landed before this org's Xero year-end lock date —
    // rejected outright on push, silently otherwise.
    const todayStr = new Date().toISOString().slice(0, 10);
    const dateAnchor = `Today's date is ${todayStr}. If an invoice date or due date shows a day and month but no year anywhere on the document, use ${todayStr.slice(0, 4)} rather than guessing a different year.`;

    let content;
    if (text) {
      // Cap length — a large spreadsheet shouldn't turn into an oversized,
      // expensive request; any single invoice's fields live well within this.
      const clipped = String(text).slice(0, 8000);
      content = [{
        type: 'text',
        text: 'Extract the fields from this supplier invoice text. The invoice is addressed TO KOH Industries or WNDRR — every field you return (name, email, bank details) must belong to the SUPPLIER sending the invoice, never to KOH Industries or WNDRR, even where their details also appear on the page (e.g. in a billing/"To:" section). If a field is not present, return null for it rather than guessing. ' + dateAnchor + '\n\nInvoice text:\n\n' + clipped,
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
          text: 'Extract the fields from this supplier invoice. The invoice is addressed TO KOH Industries or WNDRR — every field you return (name, email, bank details) must belong to the SUPPLIER sending the invoice, never to KOH Industries or WNDRR, even where their details also appear on the document (e.g. in a billing/"To:" section). If a field is not present on the document, return null for it rather than guessing. ' + dateAnchor,
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
