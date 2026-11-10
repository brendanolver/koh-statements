const { withAuth } = require('./lib/auth');
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

  // Name is the other field that only goes out on CREATE, same reasoning as
  // BankAccountDetails above — a live comparison (Sharp Accounting's
  // INV-10138, which succeeded, vs INV-10137 against the same contact,
  // which kept failing identically even after the BankAccountDetails fix)
  // pointed at Name specifically: 10138 was very likely this contact's
  // first-ever push (Name only ever mattered as the initial value on
  // create), while every subsequent push is a resend of whatever this
  // invoice's own PDF extraction produced — which won't always exactly
  // match Xero's stored Name (there are three slightly different "Sharp
  // Accounting" contacts in this org alone, including one with garbled
  // text merged in from a PDF-extraction quirk) — resending a different
  // value on update risks Xero treating it as an unintended rename.
  const contactPayload = {};
  if (found) contactPayload.ContactID = found.ContactID;
  else contactPayload.Name = name;
  if (email) contactPayload.EmailAddress = email;
  if (bankAccountDetails && !found) contactPayload.BankAccountDetails = bankAccountDetails;

  const result = await xeroPost(connection, 'Contacts', { Contacts: [contactPayload] });
  const contact = result.Contacts && result.Contacts[0];
  if (!contact) throw new Error('Xero did not return the created/updated contact');
  return { contactId: contact.ContactID, created: !found };
}

// The actual duplicate-prevention safety net — checked explicitly rather
// than assumed. Originally scoped per-contact (InvoiceNumber unique per
// Contact.ContactID), on the assumption Xero's real constraint matched its
// UI's per-contact duplicate warning. Live-confirmed wrong: InvoiceNumber
// is unique ACCPAY-wide, not per-contact — e.g. "INV-010" already exists
// in this org for three entirely unrelated contacts, none of them the one
// a new push was for. The per-contact check silently missed that (each
// individually correctly reported "no duplicate for this contact"), so
// createBill was the thing actually rejecting the push downstream, with a
// much less clear error than this check now surfaces up front. contactId
// is unused now but kept in the signature — call sites already pass it,
// and dropping it is a bigger diff than it's worth.
async function checkBillExists(connection, { contactId, invoiceNumber }) {
  if (!invoiceNumber) throw new Error('invoiceNumber required');
  const where = `Type=="ACCPAY"&&InvoiceNumber=="${escapeXeroString(invoiceNumber)}"`;
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

// ── Amex Import: spend / receive money on a bank or credit-card account ──────

const dtExpr = (iso) => `DateTime(${Number(iso.slice(0, 4))},${Number(iso.slice(5, 7))},${Number(iso.slice(8, 10))})`;
const isoDay = (s) => String(s || '').slice(0, 10);
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

async function accountByCode(connection, code) {
  if (!code) throw new Error('accountCode required');
  const data = await xeroGet(connection, 'Accounts', { where: `Code=="${escapeXeroString(code)}"` });
  const acct = data.Accounts && data.Accounts[0];
  if (!acct) throw new Error(`No account with code ${code} in Xero`);
  if (acct.Type !== 'BANK') throw new Error(`Account ${code} (${acct.Name}) is not a bank / credit-card account`);
  return { accountId: acct.AccountID, name: acct.Name };
}

// What Xero already holds on one bank/card account between two dates — slimmed down to what the Amex
// import needs to spot duplicates (date, direction, amount, and the Reference this app stamps on its own
// entries). Deleted entries don't count. Xero is asked to filter by account; if it refuses that filter
// the same date range is read org-wide and filtered here instead.
async function listBankTransactions(connection, { accountCode, from, to }) {
  if (!ISO_RE.test(from || '') || !ISO_RE.test(to || '')) throw new Error('from / to must be YYYY-MM-DD');
  const { accountId, name } = await accountByCode(connection, accountCode);
  const dates = `Date>=${dtExpr(from)}&&Date<=${dtExpr(to)}`;
  const PAGE = 200;

  async function readAll(where, keep) {
    const out = [];
    for (let page = 1; page <= 25; page++) {
      const data = await xeroGet(connection, 'BankTransactions', { where, page: String(page), pageSize: String(PAGE) });
      const rows = data.BankTransactions || [];
      for (const t of rows) {
        if (t.Status === 'DELETED' || !keep(t)) continue;
        out.push({
          date: isoDay(t.DateString || t.Date),
          type: String(t.Type || '').startsWith('SPEND') ? 'SPEND' : 'RECEIVE',
          cents: Math.round(Math.abs(Number(t.Total) || 0) * 100),
          reference: t.Reference || '',
          reconciled: !!t.IsReconciled,
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  let transactions;
  try {
    transactions = await readAll(`BankAccount.AccountID==Guid("${accountId}")&&${dates}`, () => true);
  } catch (err) {
    transactions = await readAll(dates, (t) => t.BankAccount && t.BankAccount.AccountID === accountId);
  }
  return { accountId, accountName: name, transactions };
}

const BT_STATUS_HINT = 'Xero refused the write. If this is the first Amex push, press Reconnect Xero (it asks for the new bank-transaction write permission) and try again.';

// Creates one Spend Money / Receive Money entry per item on the card account. Each carries the item's
// stable key in Reference, and anything whose key is already on the account is skipped (so a double-click,
// a second browser or a re-dropped file can't double up). Returns one result per item, in order.
async function createBankTransactions(connection, { accountCode, items }) {
  if (!accountCode) throw new Error('accountCode required');
  if (!Array.isArray(items) || !items.length) throw new Error('items required');
  if (items.length > 50) throw new Error('At most 50 items per call');

  const results = items.map((i) => ({ key: i && i.key, ok: false }));
  const valid = [];
  items.forEach((i, idx) => {
    const bad = !i || typeof i !== 'object' ? 'Bad item'
      : !/^AMEX:[0-9a-f]{12}$/.test(i.key || '') ? 'Bad key'
      : i.type !== 'SPEND' && i.type !== 'RECEIVE' ? 'Type must be SPEND or RECEIVE'
      : !ISO_RE.test(i.date || '') ? 'Bad date'
      : !(Number(i.amount) > 0) ? 'Amount must be above zero'
      : !String(i.contact || '').trim() ? 'Contact required'
      : !String(i.account || '').trim() ? 'Account required'
      : !TAX_TYPE_MAP[i.tax] ? `Unknown tax "${i.tax}"`
      : null;
    if (bad) results[idx].error = bad; else valid.push(idx);
  });
  if (!valid.length) return { results };

  const dates = valid.map((idx) => items[idx].date).sort();
  const existing = await listBankTransactions(connection, { accountCode, from: dates[0], to: dates[dates.length - 1] });
  const have = new Set(existing.transactions.map((t) => t.reference).filter(Boolean));
  const todo = [];
  for (const idx of valid) {
    if (have.has(items[idx].key)) { results[idx].ok = true; results[idx].skipped = 'already in Xero'; } else todo.push(idx);
  }
  if (!todo.length) return { results };

  const payload = {
    BankTransactions: todo.map((idx) => {
      const i = items[idx];
      return {
        Type: i.type,
        Contact: { Name: String(i.contact).trim().slice(0, 255) },
        BankAccount: { AccountID: existing.accountId },
        Date: i.date,
        Reference: i.key,
        Status: 'AUTHORISED',
        // The card statement amount is what was actually charged, GST included.
        LineAmountTypes: 'Inclusive',
        LineItems: [{
          Description: String(i.description || '').slice(0, 4000) || 'Amex',
          Quantity: 1,
          UnitAmount: Number(i.amount),
          AccountCode: String(i.account).trim(),
          TaxType: TAX_TYPE_MAP[i.tax],
        }],
      };
    }),
  };

  const res = await fetch(`${XERO_API_BASE}/BankTransactions?summarizeErrors=false`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${connection.access_token}`,
      'Xero-tenant-id': connection.tenant_id,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const rawText = await res.text();
  let data = {};
  try { data = JSON.parse(rawText || '{}'); } catch { data = {}; }
  const list = data.BankTransactions || data.Elements || [];
  if (!list.length) {
    if (res.status === 401 || res.status === 403) throw new Error(BT_STATUS_HINT);
    throw new Error(data.Message || data.Detail || rawText.slice(0, 300) || `Xero POST BankTransactions failed (${res.status})`);
  }
  todo.forEach((idx, n) => {
    const el = list[n] || {};
    const errs = (el.ValidationErrors || []).map((v) => v.Message).filter(Boolean);
    if (el.HasErrors || errs.length || !el.BankTransactionID) {
      results[idx].error = errs.join('; ') || 'Xero did not create this entry';
    } else {
      results[idx].ok = true;
      results[idx].id = el.BankTransactionID;
    }
  });
  return { results };
}

const ACTIONS = { findOrCreateContact, checkBillExists, createBill, listBankTransactions, createBankTransactions };

const handler = async (event) => {
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

// Signed-in people only, and only with one of these sections ticked (see lib/auth.js).
exports.handler = withAuth(['bills', 'amex'], handler);
