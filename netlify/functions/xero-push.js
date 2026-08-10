const { getValidConnection } = require('./lib/xero-auth');

const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

// Confirmed against a real GET /TaxRates call on the live org — 2 of the 3
// original placeholder guesses were wrong (EXEMPTEXPENSES not
// INPUTEXEMPTEXPENSES, BASEXCLUDED not NONE), which is exactly why this
// wasn't trusted for anything real until verified.
const TAX_TYPE_MAP = {
  'GST on Expenses': 'INPUT',
  'GST Free Expenses': 'EXEMPTEXPENSES',
  'BAS Excluded': 'BASEXCLUDED',
};

function escapeXeroString(s) {
  return String(s).replace(/"/g, '\\"');
}

async function xeroGet(connection, path, params) {
  const qs = new URLSearchParams(params || {}).toString();
  const url = `${XERO_API_BASE}/${path}${qs ? `?${qs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${connection.access_token}`,
      'Xero-tenant-id': connection.tenant_id,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.Message || data.Detail || `Xero GET ${path} failed (${res.status})`);
  }
  return data;
}

async function xeroPost(connection, path, body) {
  const url = `${XERO_API_BASE}/${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.access_token}`,
      'Xero-tenant-id': connection.tenant_id,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  let data;
  try { data = JSON.parse(rawText || '{}'); } catch { data = {}; }
  if (!res.ok) {
    // Xero validation errors surface per-element, not just a top-level message
    // — and even that top-level message is sometimes only a fragment (e.g.
    // "To update fields..." with nothing after it), so fall all the way back
    // to the raw response body rather than silently losing detail.
    const elementErrors = data.Elements && data.Elements[0] && data.Elements[0].ValidationErrors;
    const detail = (elementErrors && elementErrors.map((v) => v.Message).join('; ')) || data.Message || data.Detail;
    throw new Error(detail || rawText.slice(0, 500) || `Xero POST ${path} failed (${res.status})`);
  }
  return data;
}

// GET first, POST with ContactID to update if found, POST without it to
// create. Only writes fields that were actually supplied — never blanks an
// existing email/bank detail in Xero just because this particular invoice
// didn't have one attached to it.
//
// BankAccountDetails is the one field that only goes out on CREATE, never
// on an update to an existing contact — Xero rejects that write outright
// (a security restriction: bank details can be set when a contact is first
// created, but not silently changed afterward via the API, so a compromised
// integration can't redirect where a supplier gets paid). Live-confirmed:
// every contact this app tried to push a bill for had already been created
// (either genuinely pre-existing, or by an earlier attempt of this app's
// own that got as far as the contact step before failing later), so every
// retry was hitting the update path and failing at this exact point —
// explains three unrelated suppliers all failing identically.
async function findOrCreateContact(connection, { name, email, bsb, accNo, accName }) {
  if (!name) throw new Error('Contact name required');
  const existing = await xeroGet(connection, 'Contacts', { where: `Name=="${escapeXeroString(name)}"` });
  const found = existing.Contacts && existing.Contacts[0];

  const bankAccountDetails = (bsb || accNo)
    ? String(bsb || '').replace(/[^0-9]/g, '') + String(accNo || '').replace(/[^0-9]/g, '')
    : undefined;

  const contactPayload = {};
  if (found) contactPayload.ContactID = found.ContactID;
  contactPayload.Name = name;
  if (email) contactPayload.EmailAddress = email;
  if (bankAccountDetails && !found) contactPayload.BankAccountDetails = bankAccountDetails;

  const result = await xeroPost(connection, 'Contacts', { Contacts: [contactPayload] });
  const contact = result.Contacts && result.Contacts[0];
  if (!contact) throw new Error('Xero did not return the created/updated contact');
  return { contactId: contact.ContactID, created: !found };
}

// The actual duplicate-prevention safety net — checked explicitly rather
// than assumed, since it's unconfirmed whether Xero's API hard-enforces
// per-contact invoice-number uniqueness the way its UI warns about.
async function checkBillExists(connection, { contactId, invoiceNumber }) {
  if (!contactId || !invoiceNumber) throw new Error('contactId and invoiceNumber required');
  const where = `Type=="ACCPAY"&&InvoiceNumber=="${escapeXeroString(invoiceNumber)}"&&Contact.ContactID==guid("${contactId}")`;
  const result = await xeroGet(connection, 'Invoices', { where });
  return { exists: !!(result.Invoices && result.Invoices.length) };
}

async function createBill(connection, { contactId, invoiceNum, date, due, reference, lineItems }) {
  if (!contactId || !invoiceNum || !Array.isArray(lineItems) || !lineItems.length) {
    throw new Error('Missing required bill fields (contactId, invoiceNum, lineItems)');
  }
  const payload = {
    Invoices: [{
      Type: 'ACCPAY',
      Contact: { ContactID: contactId },
      Date: date,
      DueDate: due || undefined,
      InvoiceNumber: invoiceNum,
      Reference: reference || undefined,
      Status: 'AUTHORISED',
      // Xero defaults line amounts to tax-EXCLUSIVE when this is omitted —
      // inv.amount is always the GST-inclusive total (that's what gets
      // extracted), so without this every bill would land ~10% too high.
      LineAmountTypes: 'Inclusive',
      LineItems: lineItems.map((li) => ({
        Description: li.description || 'Invoice',
        Quantity: 1,
        UnitAmount: li.amount,
        AccountCode: li.accountCode,
        TaxType: TAX_TYPE_MAP[li.taxType] || 'NONE',
      })),
    }],
  };
  const result = await xeroPost(connection, 'Invoices', payload);
  const invoice = result.Invoices && result.Invoices[0];
  if (!invoice) throw new Error('Xero did not return the created bill');
  return { xeroInvoiceId: invoice.InvoiceID, invoiceNumber: invoice.InvoiceNumber };
}

const ACTIONS = { findOrCreateContact, checkBillExists, createBill };

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: JSON.stringify({ error: 'POST only' }) };
    }

    let connection;
    try {
      connection = await getValidConnection();
    } catch (err) {
      return { statusCode: err.statusCode || 500, body: JSON.stringify({ error: err.message }) };
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    const fn = ACTIONS[body.action];
    if (!fn) {
      return { statusCode: 400, body: JSON.stringify({ error: `Unknown action: ${body.action}` }) };
    }

    const result = await fn(connection, body.params || {});
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, result }),
    };
  } catch (err) {
    return { statusCode: 502, body: JSON.stringify({ error: err.message }) };
  }
};
