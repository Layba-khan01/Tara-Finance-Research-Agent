declare const require: any;
declare const process: any;
declare const Buffer: any;

require('dotenv/config');
const http: any = require('http');
const fs: any = require('fs/promises');
const path: any = require('path');
const { URL } = require('url');
import { taraAgent } from '#src/mastra/agent.ts';

const frontendRoot = path.join(process.cwd(), 'frontend');
const port = parseInt(process.env.PORT ?? '3000', 10);

const mimeTypes: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'application/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml; charset=utf-8',
	'.ico': 'image/x-icon',
};

async function readRequestBody(req: any): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: any[] = [];
		req.on('data', (chunk: any) => chunks.push(chunk));
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function jsonResponse(res: any, status: number, body: unknown) {
	res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
	res.end(JSON.stringify(body, null, 2));
}

function notFound(res: any) {
	res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
	res.end('Not found');
}

function badRequest(res: any, message: string) {
	jsonResponse(res, 400, { error: message });
}

function internalError(res: any, error: unknown) {
	console.error(error);
	jsonResponse(res, 500, { error: 'Internal server error' });
}

async function serveStaticFile(res: any, filePath: string) {
	try {
		const data = await fs.readFile(filePath);
		const ext = path.extname(filePath).toLowerCase();
		const contentType = mimeTypes[ext] ?? 'application/octet-stream';
		res.writeHead(200, { 'Content-Type': contentType });
		res.end(data);
	} catch (error) {
		if ((error as { code?: string }).code === 'ENOENT') {
			notFound(res);
			return;
		}
		internalError(res, error);
	}
}

function extractAssistantText(output: any): string {
	if (!output) return '';
	if (typeof output.text === 'string' && output.text.trim().length > 0) {
		return output.text.trim();
	}
	if (typeof output?.result?.text === 'string' && output.result.text.trim().length > 0) {
		return output.result.text.trim();
	}
	return JSON.stringify(output, null, 2);
}

async function handleApiChat(req: any, res: any) {
	if (req.method !== 'POST') {
		res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain; charset=utf-8' });
		res.end('Method Not Allowed');
		return;
	}

	let bodyText: string;
	try {
		bodyText = await readRequestBody(req);
	} catch (error) {
		badRequest(res, 'Failed to read request body');
		return;
	}

	let body: unknown;
	try {
		body = bodyText ? JSON.parse(bodyText) : {};
	} catch {
		badRequest(res, 'Invalid JSON body');
		return;
	}

	const payload = body as { prompt?: string; messages?: Array<{ role: string; content: string }> };
	const messages = Array.isArray(payload.messages)
		? payload.messages
		: payload.prompt
		? [{ role: 'user', content: payload.prompt }]
		: [];

	if (messages.length === 0) {
		badRequest(res, 'No prompt or messages provided');
		return;
	}

	try {
		const result = await taraAgent.generate(messages);
		const assistant = extractAssistantText(result);
		jsonResponse(res, 200, { assistant, result });
	} catch (error) {
		internalError(res, error);
	}
}

async function requestHandler(req: any, res: any) {
	const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
	if (url.pathname === '/api/chat') {
		await handleApiChat(req, res);
		return;
	}

	const rawPath = url.pathname === '/' ? '/index.html' : url.pathname;
	const filePath = path.join(frontendRoot, decodeURIComponent(rawPath));
	if (!filePath.startsWith(frontendRoot)) {
		notFound(res);
		return;
	}

	await serveStaticFile(res, filePath);
}

const server = http.createServer(requestHandler);
server.on('error', (error: any) => {
	if (error?.code === 'EADDRINUSE') {
		console.error(`Port ${port} is already in use. Set a different port with PORT or stop the process currently using ${port}.`);
		process.exit(1);
	}
	console.error('Server error:', error);
	process.exit(1);
});
server.listen(port, () => {
	console.log(`Tara frontend server is running at http://localhost:${port}`);
});
