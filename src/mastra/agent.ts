declare const require: {
	(moduleName: string): any;
};

declare const process: any;

const { Agent } = require('@mastra/core/agent');
import { mastraTools } from '#src/mastra/tools.ts';

const enabledTools = mastraTools;
const groqApiKey = process.env.GROQ_API_KEY?.trim();
const groqModelInput = process.env.GROQ_MODEL?.trim();
const groqModel = groqApiKey
	? normalizeModelId(groqModelInput || 'groq/allam-2-7b', 'groq')
	: undefined;
const openaiModelInput = process.env.OPENAI_MODEL?.trim();
const openaiModel = !groqApiKey
	? normalizeModelId(openaiModelInput, 'openai')
	: undefined;
const agentModel = groqModel || openaiModel || 'groq/allam-2-7b';

function normalizeModelId(modelId: string | undefined, provider: string): string | undefined {
	if (!modelId) return undefined;
	if (modelId.includes('/')) return modelId;
	if (provider === 'groq') {
		if (modelId === 'compound' || modelId === 'compound-mini') return `groq/${modelId}`;
		return `groq/${modelId}`;
	}
	return `${provider}/${modelId}`;
}

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
		model: agentModel,
		temperature: 0.0,
		enabledTools,
		tools: enabledTools,
	});
} catch (error) {
	throw new Error(`Failed to initialize taraAgent: ${error instanceof Error ? error.message : String(error)}`);
}

export { taraAgent };