export function normalizeCurrency(
  amount: string | number | null | undefined,
  fromCurrency?: string,
  toCurrency = 'USD'
): number | null {
  if (amount === null || amount === undefined) return null;
  
  let value: number;
  if (typeof amount === 'string') {
    const cleaned = amount.replace(/[^0-9.-]/g, '');
    value = parseFloat(cleaned);
  } else {
    value = amount;
  }

  if (isNaN(value)) return null;

  const rates: Record<string, number> = {
    USD: 1,
    EUR: 0.85,
    GBP: 0.73,
    AUD: 1.35,
    VND: 23000,
  };

  const fromRate = fromCurrency ? rates[fromCurrency] ?? 1 : 1;
  const toRate = rates[toCurrency] ?? 1;

  return (value / fromRate) * toRate;
}

export function extractDate(
  text: string | null | undefined
): string | null {
  if (!text) return null;

  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }

  const usMatch = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (usMatch) {
    const [, month, day, year] = usMatch;
    return `${year}-${month?.padStart(2, '0') ?? ''}-${day?.padStart(2, '0') ?? ''}`;
  }

  const parsed = Date.parse(text);
  if (!isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return null;
}

export function cleanName(name: string | null | undefined): string | null {
  if (!name) return null;
  
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseMoneyValue(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw * 100) / 100 : null;
  }

  const cleaned = raw.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.' || cleaned === '-.') return null;
  
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function parseDateValue(raw: string | null | undefined): string | null {
  if (!raw) return null;
  
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  
  const parsed = Date.parse(raw.trim());
  if (Number.isNaN(parsed)) return null;
  
  return new Date(parsed).toISOString().slice(0, 10);
}

export function parseIntValue(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.trunc(raw) : null;
  }
  
  const cleaned = raw.replace(/[^0-9-]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

export function validateEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

export function validatePhone(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const cleaned = phone.replace(/[^0-9+]/g, '');
  return cleaned.length >= 10 && cleaned.length <= 15;
}

export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const cleaned = phone.replace(/[^0-9+]/g, '');
  if (cleaned.length < 10) return null;
  return cleaned;
}

export function extractPercentage(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/(\d+(?:\.\d+)?)\s*%/);
  const value = match?.[1];
  if (!value) return null;
  return parseFloat(value);
}

export function capitalizeWords(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function truncateText(text: string | null | undefined, maxLength: number): string | null {
  if (!text) return null;
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

export function removeDuplicates<T>(array: T[] | null | undefined): T[] {
  if (!array) return [];
  return Array.from(new Set(array));
}

export function sortByName<T extends { name?: string; title?: string }>(
  array: T[] | null | undefined
): T[] {
  if (!array) return [];
  return [...array].sort((a, b) => {
    const nameA = (a.name || a.title || '').toLowerCase();
    const nameB = (b.name || b.title || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}
