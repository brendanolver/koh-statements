const { pdfFromSource } = require('./lib/pdf');
const { buildCommissionReportHtml } = require('./lib/commission-report-html');

// Direct-download counterpart to send-commission-report.js's PDF
// attachment — same html builder, so the downloaded file and the emailed
// attachment are always byte-identical. No recipient/send involved here.
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

    const { agentName, monthLabel, customers, total, netTotal, currency } = body;
    if (!agentName || !monthLabel || !Array.isArray(customers)) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing agentName, monthLabel, or customers' }) };
    }

    const pdfBase64 = await pdfFromSource(buildCommissionReportHtml({ agentName, monthLabel, customers, total, netTotal, currency }));
    const filename = `Commission Report - ${agentName} - ${monthLabel}.pdf`.replace(/"/g, "'");

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
      body: pdfBase64,
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
