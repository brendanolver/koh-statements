const JSZip = require('jszip');
const { pdfFromSource } = require('./lib/pdf');

// Converts one customer's statement HTML + invoice print_urls into base64
// PDFs, all in parallel (both across customers and within one customer's
// invoice list) — this is a direct download, not an email, so there's no
// reason to wait on anything sequentially. A failed individual invoice PDF
// is dropped rather than failing the whole export.
async function buildCustomerAssets(c) {
  const [statementPdfBase64, invoiceResults] = await Promise.all([
    pdfFromSource(c.html),
    Promise.allSettled(
      (c.invoicePdfs || []).map(async ({ invoiceNumber, printUrl }) => ({
        invoiceNumber,
        base64: await pdfFromSource(printUrl),
      }))
    ),
  ]);

  return {
    customerName: c.customerName,
    statementPdfBase64,
    xlsxBase64: c.xlsxBase64,
    invoicePdfs: invoiceResults.filter((r) => r.status === 'fulfilled').map((r) => r.value),
  };
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
    }
    if (!process.env.PDFSHIFT_API_KEY) {
      return { statusCode: 500, body: JSON.stringify({ error: 'PDFSHIFT_API_KEY not configured' }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const { customers } = body;
    if (!Array.isArray(customers) || customers.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing customers array' }) };
    }
    if (customers.some((c) => !c.customerName || !c.html)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Every customer needs customerName and html' }) };
    }

    const assetsList = await Promise.all(customers.map(buildCustomerAssets));

    const zip = new JSZip();
    for (const a of assetsList) {
      const folder = zip.folder(a.customerName);
      folder.file('Statement.pdf', a.statementPdfBase64, { base64: true });
      if (a.xlsxBase64) {
        folder.file('Statement.xlsx', a.xlsxBase64, { base64: true });
      }
      if (a.invoicePdfs.length > 0) {
        const invoicesFolder = folder.folder('Invoices');
        for (const inv of a.invoicePdfs) {
          invoicesFolder.file(`Invoice ${inv.invoiceNumber}.pdf`, inv.base64, { base64: true });
        }
      }
    }
    const zipBase64 = await zip.generateAsync({ type: 'base64' });

    const filename = customers.length === 1
      ? `${customers[0].customerName} - Files.zip`
      : `Statements - ${customers.length} customers.zip`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename.replace(/"/g, "'")}"`,
      },
      body: zipBase64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
