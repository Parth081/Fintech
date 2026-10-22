import { corridorById, type PayloadMap, type Party } from '@ct/contracts';

export const MAX_AMOUNT_MINOR = 1_000_000_00; // 1M major units
export type PaymentRequest = Omit<PayloadMap['payment.initiated'], 'idempotencyKey'>;

export type ValidationResult = { ok: true; value: PaymentRequest } | { ok: false; details: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validateParty(label: string, v: unknown, details: string[]): Party | undefined {
  if (!isObject(v)) {
    details.push(`${label} must be an object {name, country, accountId}`);
    return undefined;
  }
  const { name, country, accountId } = v;
  const before = details.length;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 140) details.push(`${label}.name must be a non-empty string (max 140 chars)`);
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) details.push(`${label}.country must be an ISO 3166-1 alpha-2 code`);
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(accountId)) details.push(`${label}.accountId must be 1-64 chars [A-Za-z0-9._:-]`);
  if (details.length !== before) return undefined;
  return { name: (name as string).trim(), country: country as string, accountId: accountId as string };
}

export function validatePaymentRequest(body: unknown): ValidationResult {
  const details: string[] = [];
  if (!isObject(body)) return { ok: false, details: ['body must be a JSON object'] };

  const corridor = typeof body.corridor === 'string' ? corridorById(body.corridor) : undefined;
  if (!corridor) details.push(`corridor must be one of the supported corridors`);

  const amount = body.amount;
  let amountMinor: number | undefined;
  let currency: string | undefined;
  if (!isObject(amount)) {
    details.push('amount must be an object {amountMinor, currency}');
  } else {
    if (typeof amount.amountMinor !== 'number' || !Number.isSafeInteger(amount.amountMinor) || amount.amountMinor <= 0) {
      details.push('amount.amountMinor must be a positive integer (minor units)');
    } else if (amount.amountMinor > MAX_AMOUNT_MINOR) {
      details.push(`amount.amountMinor must be <= ${MAX_AMOUNT_MINOR}`);
    } else {
      amountMinor = amount.amountMinor;
    }
    if (typeof amount.currency !== 'string' || !/^[A-Z]{3}$/.test(amount.currency)) {
      details.push('amount.currency must be an ISO 4217 code');
    } else {
      currency = amount.currency;
      if (corridor && currency !== corridor.sourceCurrency) details.push(`amount.currency must be ${corridor.sourceCurrency} for corridor ${corridor.id}`);
    }
  }

  const targetCurrency = body.targetCurrency;
  if (typeof targetCurrency !== 'string' || !/^[A-Z]{3}$/.test(targetCurrency)) {
    details.push('targetCurrency must be an ISO 4217 code');
  } else if (corridor && targetCurrency !== corridor.targetCurrency) {
    details.push(`targetCurrency must be ${corridor.targetCurrency} for corridor ${corridor.id}`);
  }

  const debtor = validateParty('debtor', body.debtor, details);
  const creditor = validateParty('creditor', body.creditor, details);

  let scenario: string | undefined;
  if (body.scenario !== undefined && body.scenario !== null) {
    if (typeof body.scenario !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.scenario)) details.push('scenario must be a short lowercase slug');
    else scenario = body.scenario;
  }

  if (details.length || !corridor || amountMinor === undefined || !currency || !debtor || !creditor) {
    return { ok: false, details: details.length ? details : ['invalid payment'] };
  }
  const value: PaymentRequest = {
    amount: { amountMinor, currency },
    targetCurrency: targetCurrency as string,
    corridor: corridor.id,
    debtor,
    creditor,
  };
  if (scenario) value.scenario = scenario;
  return { ok: true, value };
}

export function validateIdempotencyKey(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === '') return undefined; // absent
  if (typeof v !== 'string' || v.length > 128 || !/^[\x21-\x7e]+$/.test(v)) return null; // invalid
  return v;
}
