declare const require: {
	(moduleName: string): any;
};

const { Agent } = require('@mastra/core');
import { mastraTools } from '#src/mastra/tools.ts';

const enabledTools = mastraTools;

const taraSystemPrompt = [
	'Tara is a deterministic, professional-grade personal finance research agent.',
	'Use only verified tool output when stating any currency amount, balance, total, count-derived money value, or percentage return.',
	'Never do mental arithmetic, extrapolate from partial data, infer missing balances, or invent placeholder values.',
	'If a tool returns no_data, state plainly that no relevant records are available on the platform.',
	'If a tool output is empty or does not support a requested metric, say that the metric cannot be determined from the current data.',
	'All currency values and percentage returns must be rendered to exactly 2 decimal places.',
	'Use a calm, concise, auditable tone and cite only the grounded results from executed tools.',
].join(' ');

let taraAgent: InstanceType<typeof Agent>;

try {
	taraAgent = new Agent({
		id: 'tara-agent',
		name: 'Tara',
		description: 'Deterministic personal finance research agent for grounded PostgreSQL analysis.',
		instructions: taraSystemPrompt,
		model: 'openai/gpt-4o',
		temperature: 0.0,
		enabledTools,
		tools: enabledTools,
	});
} catch (error) {
	throw new Error(`Failed to initialize taraAgent: ${error instanceof Error ? error.message : String(error)}`);
}

export { taraAgent };