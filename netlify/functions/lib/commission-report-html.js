function fmtMoney(n) {
  const v = Number(n || 0);
  const abs = Math.abs(v).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? `($${abs})` : `$${abs}`;
}

// Standalone document — converted to PDF via PDFShift, shared by the email
// send path (attachment) and the direct-download path so both always
// produce byte-identical reports. Mirrors the in-app expanded detail view:
// Customer -> Invoice rows, per-customer subtotal, grand total at the end.
function buildCommissionReportHtml({ agentName, monthLabel, customers, total, currency }) {
  const customerBlocks = (customers || []).map((cust) => {
    const rows = (cust.invoices || []).map((li) => `
      <tr>
        <td>Invoice ${li.invoiceNum}</td>
        <td>${li.date || ''}</td>
        <td>${li.po || ''}</td>
        <td class="num">${Number(li.rate).toFixed(2)}%</td>
        <td class="num">${fmtMoney(li.commission)}</td>
      </tr>`).join('');
    return `
      <tr class="cust-row"><td colspan="5">${cust.customerName}</td></tr>
      ${rows}
      <tr class="subtotal-row"><td colspan="4">Subtotal</td><td class="num">${fmtMoney(cust.subtotal)}</td></tr>`;
  }).join('');

  return `<html><head><meta charset="utf-8"><style>
    body { font-family: Arial, Helvetica, sans-serif; color: #1a1a1a; margin: 32px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .sub { color: #6b7280; font-size: 12px; margin-bottom: 20px; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.4px; color: #6b7280; border-bottom: 1.5px solid #1a1a1a; padding: 0 6px 6px; }
    td { padding: 5px 6px; border-bottom: 1px solid #eee; }
    .num { text-align: right; }
    .cust-row td { font-weight: 700; border-bottom: none; padding-top: 14px; }
    .subtotal-row td { font-weight: 700; border-top: 1px solid #ccc; border-bottom: none; }
    .total-row td { font-weight: 700; font-size: 14px; border-top: 2px solid #1a1a1a; padding-top: 10px; }
  </style></head><body>
    <h1>Commission Report — ${monthLabel}</h1>
    <div class="sub">${agentName}</div>
    <table>
      <thead><tr><th>Invoice</th><th>Date</th><th>PO</th><th class="num">Rate</th><th class="num">Commission</th></tr></thead>
      <tbody>
        ${customerBlocks}
        <tr class="total-row"><td colspan="4">Total (ex GST)</td><td class="num">${fmtMoney(total)} ${currency || 'AUD'}</td></tr>
      </tbody>
    </table>
  </body></html>`;
}

module.exports = { buildCommissionReportHtml, fmtMoney };
