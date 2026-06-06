import { taraAgent } from '#src/mastra/agent.ts';

declare const process: {
	exit(code?: number): never;
};

type TestVector = {
	id: string;
	turns: string[];
	expectNoData?: boolean;
	expectMoneyFormatting?: boolean;
};

type SuiteResult = {
	id: string;
	passed: boolean;
	reason?: string;
};

const testVectors: TestVector[] = [
	{
		id: 'tx-summary-month',
		turns: ['Summarize spending by month for the current period.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'tx-category',
		turns: ['Show category spending for the last 90 days.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'tx-merchant',
		turns: ['Find spending for SWIGGY across all history.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'tx-transfers',
		turns: ['Show transfer activity only for the last month.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'subscriptions',
		turns: ['Identify recurring subscriptions in my transaction history.'],
		expectNoData: true,
	},
	{
		id: 'fund-return',
		turns: ['Compute the return for fund fund_73b1a2 from 2024-01-01 to 2024-12-31.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'fund-return-invalid',
		turns: ['Compute the return for fund fund_73b1a2 from 2024-12-31 to 2024-01-01.'],
		expectNoData: true,
	},
	{
		id: 'portfolio-all',
		turns: ['Show my portfolio realized return.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'portfolio-fund',
		turns: ['Show realized return for fund fund_73b1a2.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'multi-turn-budget',
		turns: ['What did I spend on food?', 'Now narrow that to the last 30 days.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'multi-turn-investment',
		turns: ['What is the fund performance for my largest fund?', 'Use the closest historical NAV values.'],
		expectMoneyFormatting: true,
	},
	{
		id: 'no-data-probe',
		turns: ['Look up a category that has no transactions and tell me the balance.'],
		expectNoData: true,
	},
];

async function main(): Promise<void> {
	const results: SuiteResult[] = [];

	for (const vector of testVectors) {
		try {
			const responseText = await runVector(vector);
			const passed = validateResponse(responseText, vector);
			results.push({
				id: vector.id,
				passed,
				reason: passed ? undefined : buildFailureReason(responseText, vector),
			});
		} catch (error) {
			results.push({
				id: vector.id,
				passed: false,
				reason: describeError(error),
			});
		}
	}

	const passedCount = results.filter((result) => result.passed).length;
	const failedCount = results.length - passedCount;

	for (const result of results) {
		if (result.passed) {
			console.log(`PASS ${result.id}`);
		} else {
			console.log(`FAIL ${result.id}: ${result.reason ?? 'unknown failure'}`);
		}
	}

	console.log(`TOTAL passed=${passedCount} failed=${failedCount}`);
	if (failedCount > 0) {
		process.exit(1);
	}
}

async function runVector(vector: TestVector): Promise<string> {
	let history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
	let lastResponseText = '';

	for (const turn of vector.turns) {
		history = [...history, { role: 'user', content: turn }];
		const response = await taraAgent.generate({ messages: history });
		lastResponseText = extractResponseText(response);
		history = [...history, { role: 'assistant', content: lastResponseText }];
	}

	return lastResponseText;
}

function extractResponseText(response: unknown): string {
	if (typeof response === 'string') {
		return response;
	}

	if (response && typeof response === 'object' && 'text' in response) {
		return String((response as { text?: unknown }).text ?? '');
	}

	return '';
}

function validateResponse(responseText: string, vector: TestVector): boolean {
	const normalized = responseText.toLowerCase();
	if (vector.expectNoData) {
		return normalized.includes('no data available');
	}

	if (vector.expectMoneyFormatting) {
		return hasTwoDecimalFormatting(responseText);
	}

	return responseText.trim().length > 0;
}

function hasTwoDecimalFormatting(text: string): boolean {
	const moneyPatterns = [
		/\b-?\d+\.\d{2}\b/g,
		/₹\s*-?\d+\.\d{2}\b/g,
		/\b-?\d+\.\d{2}%\b/g,
	];

	for (const pattern of moneyPatterns) {
		const matches = text.match(pattern);
		if (matches && matches.some((value) => !/^₹?\s?-?\d+\.\d{2}%?$/.test(value))) {
			return false;
		}
	}

	return /\d+\.\d{2}/.test(text) || text.toLowerCase().includes('no data available');
}

function buildFailureReason(responseText: string, vector: TestVector): string {
	if (vector.expectNoData && !responseText.toLowerCase().includes('no data available')) {
		return 'missing no data available phrase';
	}

	if (vector.expectMoneyFormatting && !hasTwoDecimalFormatting(responseText)) {
		return 'money formatting is not exactly 2 decimals';
	}

	return 'validation failed';
}

function describeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

void main().catch((error) => {
	console.log(`FAIL suite: ${describeError(error)}`);
	process.exit(1);
});