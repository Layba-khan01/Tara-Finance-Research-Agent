declare const require: {
	(moduleName: string): any;
};

declare const process: {
	env: Record<string, string | undefined>;
	cwd(): string;
	exit(code?: number): never;
};

type JsonRecord = Record<string, unknown>;

type TransactionInput = JsonRecord & {
	id: string;
	date: string;
	merchant: string;
	canonical_merchant?: string;
	category?: string;
	amount: number | string;
	currency?: string;
	memo?: string;
};

type FundInput = JsonRecord & {
	id: string;
	name: string;
	category?: string;
	nav_history?: unknown;
	nav?: unknown;
};

type HoldingInput = JsonRecord & {
	id?: string;
	fund_id: string;
	fund_name?: string;
	units: number | string;
	purchase_date: string;
	purchase_nav: number | string;
};

type NormalizedTransaction = {
	id: string;
	date: string;
	merchant: string;
	canonicalMerchant: string;
	category: string;
	amount: string;
	currency: string;
	memo: string;
};

type NormalizedFund = {
	id: string;
	name: string;
	category: string;
};

type NormalizedFundNav = {
	fundId: string;
	date: string;
	nav: string;
};

type NormalizedHolding = {
	id: string;
	fundId: string;
	fundName: string;
	units: string;
	purchaseDate: string;
	purchaseNav: string;
};

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const ARTIFACT_PREFIX_PATTERN = /^(?:UPI|NEFT|IMPS|RTGS|ACH|NACH|ECS)[\s:/\-_.]*/i;
const ARTIFACT_TOKEN_PATTERN = /\b(?:UPI|NEFT|IMPS|RTGS|ACH|NACH|ECS|TXN|TXID|UTR|RRN|REF|ORDER|ORD|PAY|PAYMENT|INVOICE|INV)\b/gi;
const TERMINAL_HASH_PATTERN = /(?:[\s:/\-_.]+[A-Z0-9]{8,})+$/i;

async function main(): Promise<void> {
	const dataDir = resolveDataDir();
	const databaseUrl = resolveDatabaseUrl();
	const transactions = normalizeTransactions(loadTransactions(dataDir));
	const fundsBundle = normalizeFunds(loadFunds(dataDir));
	const holdings = normalizeHoldings(loadHoldings(dataDir), fundsBundle.funds);
	const pool = new Pool({ connectionString: databaseUrl });
	const client = await pool.connect();

	try {
		await client.query('BEGIN');
		await client.query('TRUNCATE TABLE fund_nav, holdings, transactions, funds RESTART IDENTITY CASCADE');

		for (const fund of fundsBundle.funds) {
			await client.query(
				`
					INSERT INTO funds (id, name, category)
					VALUES ($1, $2, $3)
					ON CONFLICT (id) DO UPDATE
					SET name = EXCLUDED.name,
						category = EXCLUDED.category
				`,
				[fund.id, fund.name, fund.category],
			);

			for (const navRow of fundsBundle.fundNavRows.filter((row) => row.fundId === fund.id)) {
				await client.query(
					`
						INSERT INTO fund_nav (fund_id, "date", nav)
						VALUES ($1, $2, $3)
						ON CONFLICT (fund_id, "date") DO UPDATE
						SET nav = EXCLUDED.nav
					`,
					[fund.id, navRow.date, navRow.nav],
				);
			}
		}

		for (const transaction of transactions) {
			await client.query(
				`
					INSERT INTO transactions (
						id,
						"date",
						merchant,
						canonical_merchant,
						category,
						amount,
						currency,
						memo
					)
					VALUES ($1, $2, $3, $4, $5, $6::numeric, $7, $8)
					ON CONFLICT (id) DO UPDATE
					SET "date" = EXCLUDED."date",
						merchant = EXCLUDED.merchant,
						canonical_merchant = EXCLUDED.canonical_merchant,
						category = EXCLUDED.category,
						amount = EXCLUDED.amount,
						currency = EXCLUDED.currency,
						memo = EXCLUDED.memo
				`,
				[
					transaction.id,
					transaction.date,
					transaction.merchant,
					transaction.canonicalMerchant,
					transaction.category,
					transaction.amount,
					transaction.currency,
					transaction.memo,
				],
			);
		}

		for (const holding of holdings) {
			await client.query(
				`
					INSERT INTO holdings (
						id,
						fund_id,
						fund_name,
						units,
						purchase_date,
						purchase_nav
					)
					VALUES ($1, $2, $3, $4::numeric, $5, $6::numeric)
					ON CONFLICT (id) DO UPDATE
					SET fund_id = EXCLUDED.fund_id,
						fund_name = EXCLUDED.fund_name,
						units = EXCLUDED.units,
						purchase_date = EXCLUDED.purchase_date,
						purchase_nav = EXCLUDED.purchase_nav
				`,
				[
					holding.id,
					holding.fundId,
					holding.fundName,
					holding.units,
					holding.purchaseDate,
					holding.purchaseNav,
				],
			);
		}

		await client.query('COMMIT');
		console.log(`Ingested ${transactions.length} transactions, ${fundsBundle.funds.length} funds, ${fundsBundle.navCount} NAV points, and ${holdings.length} holdings from ${dataDir}.`);
	} catch (error) {
		try {
			await client.query('ROLLBACK');
		} catch (rollbackError) {
			throw new Error(`Ingestion failed and rollback also failed: ${describeError(rollbackError)}. Original error: ${describeError(error)}`);
		}
		throw error instanceof Error ? error : new Error(String(error));
	} finally {
		client.release();
		await pool.end();
	}
}

function resolveDataDir(): string {
	const configured = process.env.DATA_DIR;
	if (!configured || configured.trim().length === 0) {
		throw new Error('DATA_DIR is required. Set process.env.DATA_DIR to the directory containing transactions.json, funds.json, and holdings.json.');
	}

	const resolved = path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
	if (!fs.existsSync(resolved)) {
		throw new Error(`DATA_DIR does not exist: ${resolved}`);
	}

	if (!fs.statSync(resolved).isDirectory()) {
		throw new Error(`DATA_DIR must point to a directory: ${resolved}`);
	}

	return resolved;
}

function resolveDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl || databaseUrl.trim().length === 0) {
		throw new Error('DATABASE_URL is required for ingestion.');
	}

	return databaseUrl.trim();
}

function loadTransactions(dataDir: string): TransactionInput[] {
	return readJsonArray<TransactionInput>(path.join(dataDir, 'transactions.json'), 'transactions');
}

function loadFunds(dataDir: string): FundInput[] {
	return readJsonArray<FundInput>(path.join(dataDir, 'funds.json'), 'funds');
}

function loadHoldings(dataDir: string): HoldingInput[] {
	return readJsonArray<HoldingInput>(path.join(dataDir, 'holdings.json'), 'holdings');
}

function readJsonArray<T extends JsonRecord>(filePath: string, label: string): T[] {
	if (!fs.existsSync(filePath)) {
		throw new Error(`Missing required ${label} file: ${filePath}`);
	}

	let rawText: string;
	try {
		rawText = fs.readFileSync(filePath, 'utf8');
	} catch (error) {
		throw new Error(`Failed to read ${label} file ${filePath}: ${describeError(error)}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		throw new Error(`Invalid JSON in ${label} file ${filePath}: ${describeError(error)}`);
	}

	if (!Array.isArray(parsed)) {
		throw new Error(`Expected ${label} file ${filePath} to contain a JSON array.`);
	}

	return parsed as T[];
}

function normalizeTransactions(transactions: TransactionInput[]): NormalizedTransaction[] {
	const seenIds = new Set<string>();
	return transactions.map((transaction, index) => {
		const id = coerceRequiredText(transaction.id, `transactions[${index}].id`);
		if (seenIds.has(id)) {
			throw new Error(`Duplicate transaction id detected: ${id}`);
		}
		seenIds.add(id);

		const merchant = normalizeWhitespace(coerceRequiredText(transaction.merchant, `transactions[${index}].merchant`));
		return {
			id,
			date: coerceDate(transaction.date, `transactions[${index}].date`),
			merchant,
			canonicalMerchant: canonicalizeMerchant(merchant),
			category: normalizeCategory(transaction.category),
			amount: coerceMoney(transaction.amount, `transactions[${index}].amount`).toFixed(2),
			currency: normalizeCurrency(transaction.currency, `transactions[${index}].currency`),
			memo: normalizeNullableText(transaction.memo),
		};
	});
}

function normalizeFunds(rawFunds: FundInput[]): { funds: NormalizedFund[]; fundNavRows: NormalizedFundNav[]; navCount: number } {
	const funds: NormalizedFund[] = [];
	const fundNavRows: NormalizedFundNav[] = [];
	let navCount = 0;
	const seenIds = new Set<string>();
	const seenNames = new Set<string>();

	for (const [index, rawFund] of rawFunds.entries()) {
		const id = coerceRequiredText(rawFund.id, `funds[${index}].id`);
		const name = normalizeWhitespace(coerceRequiredText(rawFund.name, `funds[${index}].name`));
		const category = normalizeCategory(rawFund.category);

		if (seenIds.has(id)) {
			throw new Error(`Duplicate fund id detected in funds.json: ${id}`);
		}
		if (seenNames.has(name.toUpperCase())) {
			throw new Error(`Duplicate fund name detected after normalization: ${name}`);
		}

		seenIds.add(id);
		seenNames.add(name.toUpperCase());
		funds.push({ id, name, category });

		const rows = extractFundNavRows(rawFund, id, `funds[${index}]`);
		fundNavRows.push(...rows);
		navCount += rows.length;
	}

	return { funds, fundNavRows, navCount };
}

function extractFundNavRows(fund: FundInput, fundId: string, context: string): NormalizedFundNav[] {
	const sources: unknown[] = [];
	if (fund.nav_history !== undefined && fund.nav_history !== null) {
		sources.push(fund.nav_history);
	}
	if (fund.nav !== undefined && fund.nav !== null) {
		sources.push(fund.nav);
	}

	const rows: NormalizedFundNav[] = [];
	for (const [sourceIndex, source] of sources.entries()) {
		rows.push(...normalizeFundNavSource(source, fundId, `${context}.nav_source[${sourceIndex}]`));
	}

	return rows;
}

function normalizeFundNavSource(source: unknown, fundId: string, context: string): NormalizedFundNav[] {
	if (source === null || source === undefined) {
		return [];
	}

	if (Array.isArray(source)) {
		return source.flatMap((entry, index) => normalizeFundNavEntry(entry, fundId, `${context}[${index}]`));
	}

	if (isPlainObject(source)) {
		for (const key of ['history', 'nav_history', 'data', 'entries'] as const) {
			const nestedValue = source[key];
			if (Array.isArray(nestedValue) || isPlainObject(nestedValue)) {
				const nestedRows = normalizeFundNavSource(nestedValue, fundId, `${context}.${key}`);
				if (nestedRows.length > 0) {
					return nestedRows;
				}
			}
		}

		if (isDateNavRecord(source)) {
			return [normalizeFundNavEntry(source, fundId, context)];
		}

		const rows: NormalizedFundNav[] = [];
		for (const [maybeDate, maybeNav] of Object.entries(source)) {
			if (isDateLike(maybeDate)) {
				rows.push({
					fundId,
					date: coerceDate(maybeDate, `${context}.${maybeDate}`),
					nav: coerceMoney(maybeNav, `${context}.${maybeDate}.nav`).toFixed(6),
				});
			}
		}

		if (rows.length > 0) {
			return rows;
		}
	}

	throw new Error(`Unsupported NAV history shape at ${context}. Expected an object keyed by dates or an array of { date, nav } entries.`);
}

function normalizeFundNavEntry(entry: unknown, fundId: string, context: string): NormalizedFundNav {
	if (Array.isArray(entry) && entry.length >= 2) {
		return {
			fundId,
			date: coerceDate(entry[0], `${context}.date`),
			nav: coerceMoney(entry[1], `${context}.nav`).toFixed(6),
		};
	}

	if (isDateNavRecord(entry)) {
		return {
			fundId,
			date: coerceDate(entry.date, `${context}.date`),
			nav: coerceMoney(entry.nav, `${context}.nav`).toFixed(6),
		};
	}

	throw new Error(`Invalid NAV entry at ${context}. Expected { date, nav } or [date, nav].`);
}

function normalizeHoldings(holdings: HoldingInput[], funds: NormalizedFund[]): NormalizedHolding[] {
	const fundById = new Map(funds.map((fund) => [fund.id, fund] as const));
	const seenHoldingIds = new Set<string>();

	return holdings.map((holding, index) => {
		const id = coerceHoldingId(holding, index);
		if (seenHoldingIds.has(id)) {
			throw new Error(`Duplicate holding id detected: ${id}`);
		}
		seenHoldingIds.add(id);

		const fundId = coerceRequiredText(holding.fund_id, `holdings[${index}].fund_id`);
		const matchedFund = fundById.get(fundId);
		if (!matchedFund) {
			throw new Error(`No fund mapping found for holdings[${index}].fund_id: ${fundId}`);
		}

		return {
			id,
			fundId,
			fundName: normalizeWhitespace(coerceOptionalText(holding.fund_name, `holdings[${index}].fund_name`) || matchedFund.name),
			units: coerceMoney(holding.units, `holdings[${index}].units`).toFixed(6),
			purchaseDate: coerceDate(holding.purchase_date, `holdings[${index}].purchase_date`),
			purchaseNav: coerceMoney(holding.purchase_nav, `holdings[${index}].purchase_nav`).toFixed(6),
		};
	});
}

function canonicalizeMerchant(merchant: string): string {
	let cleaned = normalizeWhitespace(merchant).toUpperCase();
	if (!cleaned) {
		return 'uncategorized';
	}

	cleaned = cleaned
		.replace(ARTIFACT_PREFIX_PATTERN, ' ')
		.replace(/\(([^)]*)\)/g, ' $1 ')
		.replace(/\[[^\]]*\]/g, ' ')
		.replace(/\{[^}]*\}/g, ' ')
		.replace(ARTIFACT_TOKEN_PATTERN, ' ')
		.replace(TERMINAL_HASH_PATTERN, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();

	const tokens = cleaned
		.split(' ')
		.map((token: string) => smartTitleCaseToken(token))
		.filter((token: string) => token.length > 0 && !isNoiseToken(token));

	return tokens.length > 0 ? tokens.join(' ') : 'uncategorized';
}

function normalizeWhitespace(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

function coerceHoldingId(holding: HoldingInput, index: number): string {
	const provided = coerceOptionalText(holding.id, `holdings[${index}].id`).trim();
	if (provided) {
		return provided;
	}

	return `${coerceRequiredText(holding.fund_id, `holdings[${index}].fund_id`)}:${coerceDate(holding.purchase_date, `holdings[${index}].purchase_date`)}:${coerceMoney(holding.purchase_nav, `holdings[${index}].purchase_nav`).toFixed(6)}`;
}

function normalizeCategory(category: unknown): string {
	const normalized = normalizeNullableText(category);
	return normalized ? normalized.toLowerCase() : 'uncategorized';
}

function normalizeCurrency(currency: unknown, context: string): string {
	const value = coerceOptionalText(currency, context);
	if (!value || value.trim().length === 0) {
		throw new Error(`${context} is required.`);
	}

	const normalized = value.trim().toUpperCase();
	if (!/^[A-Z]{3}$/.test(normalized)) {
		throw new Error(`${context} must be a 3-letter ISO currency code. Received: ${value}`);
	}

	return normalized;
}

function normalizeNullableText(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}

	return String(value).replace(/\s+/g, ' ').trim();
}

function coerceRequiredText(value: unknown, context: string): string {
	const normalized = normalizeNullableText(value);
	if (!normalized) {
		throw new Error(`${context} is required.`);
	}

	return normalized;
}

function coerceOptionalText(value: unknown, context: string): string {
	if (value === null || value === undefined) {
		return '';
	}

	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	throw new Error(`${context} must be a string when provided.`);
}

function coerceMoney(value: unknown, context: string): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	throw new Error(`${context} must be a finite number.`);
}

function coerceDate(value: unknown, context: string): string {
	const raw = coerceRequiredText(value, context);
	const parsed = new Date(raw);
	if (Number.isNaN(parsed.getTime())) {
		throw new Error(`${context} must be a valid date. Received: ${raw}`);
	}

	return parsed.toISOString().slice(0, 10);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateNavRecord(value: unknown): value is { date: unknown; nav: unknown } {
	return isPlainObject(value) && 'date' in value && 'nav' in value;
}

function isDateLike(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isNoiseToken(token: string): boolean {
	if (!token) {
		return true;
	}

	if (/^\d{8,}$/.test(token)) {
		return true;
	}

	if (/^[A-Z0-9]{12,}$/.test(token) && /\d/.test(token) && /[A-Z]/.test(token) && !/-/.test(token)) {
		return true;
	}

	return false;
}

function smartTitleCaseToken(token: string): string {
	if (!token) {
		return '';
	}

	if (/^[A-Z0-9&'\-]+$/.test(token) && /\d/.test(token) && token.includes('-')) {
		return token
			.split('-')
			.map((part) => {
				if (/^[A-Z]+$/.test(part)) {
					return part.charAt(0) + part.slice(1).toLowerCase();
				}
				return part;
			})
			.join('-');
	}

	if (/^[A-Z]+$/.test(token)) {
		return token.charAt(0) + token.slice(1).toLowerCase();
	}

	return token;
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

void main().catch((error) => {
	console.error(describeError(error));
	process.exit(1);
});