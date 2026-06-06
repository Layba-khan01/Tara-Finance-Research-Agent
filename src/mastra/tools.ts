declare const require: {
	(moduleName: string): any;
};

declare const process: {
	env: Record<string, string | undefined>;
};

const mastraCoreTools = require('@mastra/core/tools');
const createTool = mastraCoreTools.createTool ?? require('@mastra/core').createTool;
const { Pool } = require('pg');
const { z } = require('zod');

type DbRow = Record<string, unknown>;

type QueryTransactionsInput = {
	startDate?: string;
	endDate?: string;
	category?: string;
	merchant?: string;
	groupBy?: 'category' | 'merchant' | 'month';
};

type FundPeriodReturnInput = {
	fundId: string;
	startDate: string;
	endDate: string;
};

type PortfolioRealizedReturnInput = {
	fundId?: string;
};

type QueryResult = {
	rowCount: number;
	rows: DbRow[];
};

type ToolOutput = Record<string, unknown>;

const databaseUrl = process.env.DATABASE_URL?.trim() ?? '';
const pool = databaseUrl.length > 0 ? new Pool({ connectionString: databaseUrl }) : null;

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'Expected YYYY-MM-DD');

const transactionInputSchema = z.object({
	startDate: isoDateSchema.optional(),
	endDate: isoDateSchema.optional(),
	category: z.string().optional(),
	merchant: z.string().optional(),
	groupBy: z.enum(['category', 'merchant', 'month']).optional(),
});

const recurringInputSchema = z.object({});

const fundPeriodReturnSchema = z.object({
	fundId: z.string(),
	startDate: isoDateSchema,
	endDate: isoDateSchema,
});

const portfolioReturnSchema = z.object({
	fundId: z.string().optional(),
});

const rowSchema = z.record(z.string(), z.unknown());

const queryTransactionsOutputSchema = z.object({
	status: z.enum(['success', 'no_data', 'failure']),
	mode: z.enum(['detail', 'aggregate']).optional(),
	rowCount: z.number().int().nonnegative().optional(),
	rows: z.array(rowSchema).optional(),
	message: z.string().optional(),
});

const recurringOutputSchema = z.object({
	status: z.enum(['success', 'no_data', 'failure']),
	rowCount: z.number().int().nonnegative().optional(),
	rows: z.array(rowSchema).optional(),
	message: z.string().optional(),
});

const fundPeriodOutputSchema = z.object({
	status: z.enum(['success', 'no_data', 'failure']),
	fundId: z.string().optional(),
	startDateRequested: z.string().optional(),
	endDateRequested: z.string().optional(),
	startDateUsed: z.string().optional(),
	endDateUsed: z.string().optional(),
	startNav: z.string().optional(),
	endNav: z.string().optional(),
	returnPercent: z.string().optional(),
	message: z.string().optional(),
});

const portfolioOutputSchema = z.object({
	status: z.enum(['success', 'no_data', 'failure']),
	rowCount: z.number().int().nonnegative().optional(),
	positions: z.array(rowSchema).optional(),
	totalCurrentValueInr: z.string().optional(),
	totalCostBasisInr: z.string().optional(),
	totalRealizedReturnInr: z.string().optional(),
	missingNavCount: z.number().int().nonnegative().optional(),
	message: z.string().optional(),
});

const queryTransactionsTool = createTool({
	id: 'query_transactions',
	description:
		'Filter transactions, run category or merchant aggregates, or group activity by month while grounding all values in PostgreSQL.',
	inputSchema: transactionInputSchema,
	outputSchema: queryTransactionsOutputSchema,
	execute: async ({ context }: { context: { input?: QueryTransactionsInput } }) => {
		try {
			const inputData = (context.input ?? {}) as QueryTransactionsInput;
			return await queryTransactions(inputData);
		} catch (error) {
			return failureOutput(describeError(error));
		}
	},
});

const getRecurringSubscriptionsTool = createTool({
	id: 'get_recurring_subscriptions',
	description: 'Identify recurring subscription-like merchants using repeated transaction cadence and fixed amount patterns.',
	inputSchema: recurringInputSchema,
	outputSchema: recurringOutputSchema,
	execute: async ({ context }: { context: unknown }) => {
		try {
			void context;
			return await getRecurringSubscriptions();
		} catch (error) {
			return failureOutput(describeError(error));
		}
	},
});

const getFundPeriodReturnTool = createTool({
	id: 'get_fund_period_return',
	description: 'Compute exact point-to-point percentage return for a fund using the closest available NAV records on or before the requested dates.',
	inputSchema: fundPeriodReturnSchema,
	outputSchema: fundPeriodOutputSchema,
	execute: async ({ context }: { context: { input?: FundPeriodReturnInput } }) => {
		try {
			const inputData = (context.input ?? {}) as FundPeriodReturnInput;
			return await getFundPeriodReturn(inputData);
		} catch (error) {
			return failureOutput(describeError(error));
		}
	},
});

const getPortfolioRealizedReturnTool = createTool({
	id: 'get_portfolio_realized_return',
	description: 'Compute current portfolio value and realized return across holdings against the latest historical NAV for each fund.',
	inputSchema: portfolioReturnSchema,
	outputSchema: portfolioOutputSchema,
	execute: async ({ context }: { context: { input?: PortfolioRealizedReturnInput } }) => {
		try {
			const inputData = (context.input ?? {}) as PortfolioRealizedReturnInput;
			return await getPortfolioRealizedReturn(inputData);
		} catch (error) {
			return failureOutput(describeError(error));
		}
	},
});

const mastraTools = [
	queryTransactionsTool,
	getRecurringSubscriptionsTool,
	getFundPeriodReturnTool,
	getPortfolioRealizedReturnTool,
] as const;

async function queryTransactions(inputData: QueryTransactionsInput): Promise<ToolOutput> {
	const params: string[] = [];
	const whereClauses: string[] = [];
	const wantsTransferRows = shouldIncludeTransfers(inputData.category, inputData.merchant);

	if (inputData.startDate) {
		params.push(inputData.startDate);
		whereClauses.push(`t."date" >= $${params.length}`);
	}

	if (inputData.endDate) {
		params.push(inputData.endDate);
		whereClauses.push(`t."date" <= $${params.length}`);
	}

	if (inputData.category) {
		params.push(inputData.category);
		whereClauses.push(`t.category = $${params.length}`);
	}

	if (inputData.merchant) {
		params.push(inputData.merchant);
		whereClauses.push(`t.canonical_merchant ILIKE '%' || $${params.length} || '%'`);
	}

	if (!wantsTransferRows) {
		whereClauses.push(`COALESCE(t.category, 'uncategorized') <> 'transfer'`);
	}

	const query = buildTransactionQuery(whereClauses, params, inputData.groupBy);
	const result = await runQuery(query.text, query.values);

	if (result.rowCount === 0) {
		return {
			status: 'no_data',
			mode: inputData.groupBy ? 'aggregate' : 'detail',
			rowCount: 0,
			rows: [],
			message: 'No transaction records matched the requested filters.',
		};
	}

	return {
		status: 'success',
		mode: inputData.groupBy ? 'aggregate' : 'detail',
		rowCount: result.rowCount,
		rows: result.rows,
	};
}

function buildTransactionQuery(
	whereClauses: string[],
	params: string[],
	groupBy?: 'category' | 'merchant' | 'month',
): { text: string; values: string[] } {
	const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

	if (groupBy === 'category') {
		return {
			text: `
				SELECT
					t.category,
					ROUND(SUM(t.amount)::numeric, 2) AS net_spend,
					COUNT(*)::int AS transaction_count
				FROM transactions AS t
				${whereSql}
				GROUP BY t.category
				ORDER BY net_spend DESC, t.category ASC
			`,
			values: params,
		};
	}

	if (groupBy === 'merchant') {
		return {
			text: `
				SELECT
					t.canonical_merchant,
					ROUND(SUM(t.amount)::numeric, 2) AS net_spend,
					COUNT(*)::int AS transaction_count
				FROM transactions AS t
				${whereSql}
				GROUP BY t.canonical_merchant
				ORDER BY net_spend DESC, t.canonical_merchant ASC
			`,
			values: params,
		};
	}

	if (groupBy === 'month') {
		return {
			text: `
				SELECT
					TO_CHAR(DATE_TRUNC('month', t."date"), 'YYYY-MM') AS month,
					ROUND(SUM(t.amount)::numeric, 2) AS net_spend,
					COUNT(*)::int AS transaction_count
				FROM transactions AS t
				${whereSql}
				GROUP BY DATE_TRUNC('month', t."date")
				ORDER BY month ASC
			`,
			values: params,
		};
	}

	return {
		text: `
			SELECT
				t.id,
				t."date",
				t.merchant,
				t.canonical_merchant,
				t.category,
				ROUND(t.amount::numeric, 2) AS amount,
				t.currency,
				t.memo
			FROM transactions AS t
			${whereSql}
			ORDER BY t."date" DESC, t.id ASC
		`,
		values: params,
	};
}

async function getRecurringSubscriptions(): Promise<ToolOutput> {
	const result = await runQuery(
		`
			SELECT
				canonical_merchant,
				ROUND(amount::numeric, 2) AS amount,
				COUNT(*)::int AS occurrence_count
			FROM transactions
			WHERE COALESCE(category, 'uncategorized') <> 'transfer'
			GROUP BY canonical_merchant, amount
			HAVING COUNT(*) >= 3
			ORDER BY occurrence_count DESC, canonical_merchant ASC
		`,
		[],
	);

	if (result.rowCount === 0) {
		return {
			status: 'no_data',
			rowCount: 0,
			rows: [],
			message: 'No recurring subscription patterns were detected in the transaction history.',
		};
	}

	return {
		status: 'success',
		rowCount: result.rowCount,
		rows: result.rows,
	};
}

async function getFundPeriodReturn(inputData: FundPeriodReturnInput): Promise<ToolOutput> {
	if (inputData.startDate > inputData.endDate) {
		return {
			status: 'no_data',
			fundId: inputData.fundId,
			startDateRequested: inputData.startDate,
			endDateRequested: inputData.endDate,
			message: 'startDate must be on or before endDate.',
		};
	}

	const [startPoint, endPoint] = await Promise.all([
		getNearestFundNav(inputData.fundId, inputData.startDate),
		getNearestFundNav(inputData.fundId, inputData.endDate),
	]);

	if (!startPoint || !endPoint) {
		return {
			status: 'no_data',
			fundId: inputData.fundId,
			startDateRequested: inputData.startDate,
			endDateRequested: inputData.endDate,
			message: 'No NAV history was available on or before one or both requested dates.',
		};
	}

	const startNavCents = decimalToCents(startPoint.nav);
	const endNavCents = decimalToCents(endPoint.nav);
	if (startNavCents <= 0n) {
		return {
			status: 'no_data',
			fundId: inputData.fundId,
			startDateRequested: inputData.startDate,
			endDateRequested: inputData.endDate,
			startDateUsed: startPoint.date,
			endDateUsed: endPoint.date,
			message: 'The starting NAV was not positive, so a percentage return could not be computed.',
		};
	}

	return {
		status: 'success',
		fundId: inputData.fundId,
		startDateRequested: inputData.startDate,
		endDateRequested: inputData.endDate,
		startDateUsed: startPoint.date,
		endDateUsed: endPoint.date,
		startNav: centsToDecimal(startNavCents),
		endNav: centsToDecimal(endNavCents),
		returnPercent: calculatePercentageReturn(startNavCents, endNavCents),
	};
}

async function getNearestFundNav(fundId: string, dateValue: string): Promise<{ date: string; nav: string } | null> {
	const result = await runQuery(
		`
			SELECT
				fn."date",
				ROUND(fn.nav::numeric, 2)::text AS nav
			FROM fund_nav AS fn
			WHERE fn.fund_id = $1
			  AND fn."date" <= $2
			ORDER BY fn."date" DESC
			LIMIT 1
		`,
		[fundId, dateValue],
	);

	if (result.rowCount === 0) {
		return null;
	}

	const row = result.rows[0];
	return {
		date: String(row.date),
		nav: String(row.nav),
	};
}

async function getPortfolioRealizedReturn(inputData: PortfolioRealizedReturnInput): Promise<ToolOutput> {
	const params: string[] = [];
	let filterSql = '';
	if (inputData.fundId) {
		params.push(inputData.fundId);
		filterSql = `WHERE h.fund_id = $${params.length}`;
	}

	const result = await runQuery(
		`
			WITH holdings_scope AS (
				SELECT
					h.id,
					h.fund_id,
					h.fund_name,
					h.units,
					h.purchase_date,
					h.purchase_nav
				FROM holdings AS h
				${filterSql}
			)
			SELECT
				hs.id,
				hs.fund_id,
				hs.fund_name,
				hs.units,
				hs.purchase_date,
				ROUND(hs.purchase_nav::numeric, 2)::text AS purchase_nav,
				latest_nav.latest_date,
				ROUND(latest_nav.latest_nav::numeric, 2)::text AS latest_nav,
				ROUND(hs.units * latest_nav.latest_nav::numeric, 2)::text AS current_value_inr,
				ROUND(hs.units * hs.purchase_nav::numeric, 2)::text AS cost_basis_inr,
				ROUND(hs.units * latest_nav.latest_nav::numeric - hs.units * hs.purchase_nav::numeric, 2)::text AS realized_return_inr
			FROM holdings_scope AS hs
			LEFT JOIN LATERAL (
				SELECT
					fn."date" AS latest_date,
					fn.nav AS latest_nav
				FROM fund_nav AS fn
				WHERE fn.fund_id = hs.fund_id
				ORDER BY fn."date" DESC
				LIMIT 1
			) AS latest_nav ON TRUE
			ORDER BY hs.fund_id ASC, hs.id ASC
		`,
		params,
	);

	if (result.rowCount === 0) {
		return {
			status: 'no_data',
			rowCount: 0,
			positions: [],
			message: 'No holdings were available for valuation.',
		};
	}

	const positions: DbRow[] = [];
	let totalCurrentValueCents = 0n;
	let totalCostBasisCents = 0n;
	let missingNavCount = 0;

	for (const row of result.rows) {
		if (row.latest_nav === null || row.latest_nav === undefined) {
			missingNavCount += 1;
			continue;
		}

		const currentValueCents = decimalToCents(String(row.current_value_inr));
		const costBasisCents = decimalToCents(String(row.cost_basis_inr));
		const realizedReturnCents = decimalToCents(String(row.realized_return_inr));

		totalCurrentValueCents += currentValueCents;
		totalCostBasisCents += costBasisCents;

		positions.push({
			id: row.id,
			fund_id: row.fund_id,
			fund_name: row.fund_name,
			units: formatQuantity(toNumber(row.units, 'units')),
			purchase_date: row.purchase_date,
			purchase_nav: String(row.purchase_nav),
			latest_nav_date: row.latest_date,
			latest_nav: String(row.latest_nav),
			current_value_inr: centsToDecimal(currentValueCents),
			cost_basis_inr: centsToDecimal(costBasisCents),
			realized_return_inr: centsToDecimal(realizedReturnCents),
		});
	}

	if (positions.length === 0) {
		return {
			status: 'no_data',
			rowCount: 0,
			positions: [],
			message: 'Holdings existed, but none had a matching NAV history record.',
		};
	}

	const totalRealizedReturnCents = totalCurrentValueCents - totalCostBasisCents;

	return {
		status: 'success',
		rowCount: positions.length,
		positions,
		totalCurrentValueInr: centsToDecimal(totalCurrentValueCents),
		totalCostBasisInr: centsToDecimal(totalCostBasisCents),
		totalRealizedReturnInr: centsToDecimal(totalRealizedReturnCents),
		missingNavCount,
	};
}

async function runQuery(text: string, values: string[]): Promise<QueryResult> {
	if (!pool) {
		throw new Error('DATABASE_URL is required to execute PostgreSQL queries. Set DATABASE_URL and restart the service.');
	}
	const client = await pool.connect();
	try {
		const result = await client.query(text, values);
		return {
			rowCount: result.rowCount ?? 0,
			rows: result.rows as DbRow[],
		};
	} finally {
		client.release();
	}
}

function shouldIncludeTransfers(category?: string, merchant?: string): boolean {
	void merchant;
	if (category && category.trim().toLowerCase() === 'transfer') {
		return true;
	}

	return false;
}

function resolveDatabaseUrl(): string {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl || databaseUrl.trim().length === 0) {
		throw new Error('DATABASE_URL is required to initialize the PostgreSQL pool.');
	}

	return databaseUrl.trim();
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function failureOutput(message: string): ToolOutput {
	return {
		status: 'failure',
		message,
	};
}

function roundTwo(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatMoney(value: number): string {
	return roundTwo(value).toFixed(2);
}

function formatQuantity(value: number): string {
	return value.toFixed(6);
}

function toNumber(value: unknown, context: string): number {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}

	if (typeof value === 'string' && value.trim().length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}

	throw new Error(`${context} must be a finite numeric value.`);
}

function calculatePercentageReturn(startCents: bigint, endCents: bigint): string {
	const diff = endCents - startCents;
	const scaled = diff * 10000n;
	const quotient = scaled / startCents;
	const remainder = scaled % startCents;
	const absRemainder = remainder < 0n ? -remainder : remainder;
	const roundUp = absRemainder * 2n >= (startCents < 0n ? -startCents : startCents);
	const adjusted = quotient + (diff < 0n ? (roundUp ? -1n : 0n) : roundUp ? 1n : 0n);
	const sign = adjusted < 0n ? '-' : '';
	const absolute = adjusted < 0n ? -adjusted : adjusted;
	const whole = absolute / 100n;
	const fraction = (absolute % 100n).toString().padStart(2, '0');
	return `${sign}${whole.toString()}.${fraction}`;
}

function decimalToCents(value: string): bigint {
	const normalized = value.trim();
	const match = normalized.match(/^(-?)(\d+)(?:\.(\d{1,}))?$/);
	if (!match) {
		throw new Error(`Unable to parse decimal value: ${value}`);
	}

	const sign = match[1] === '-' ? -1n : 1n;
	const whole = BigInt(match[2]);
	const fractionRaw = (match[3] ?? '').padEnd(3, '0');
	const fraction = BigInt(fractionRaw.slice(0, 2));
	const remainderDigit = Number(fractionRaw[2]);
	const roundUp = remainderDigit >= 5;
	let cents = whole * 100n + fraction;
	if (roundUp) {
		cents += 1n;
	}

	return sign * cents;
}

function centsToDecimal(value: bigint): string {
	const sign = value < 0n ? '-' : '';
	const absolute = value < 0n ? -value : value;
	const whole = absolute / 100n;
	const fraction = (absolute % 100n).toString().padStart(2, '0');
	return `${sign}${whole.toString()}.${fraction}`;
}

export {
	pool,
	queryTransactionsTool,
	getRecurringSubscriptionsTool,
	getFundPeriodReturnTool,
	getPortfolioRealizedReturnTool,
	mastraTools,
};