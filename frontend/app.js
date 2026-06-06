const conversationEl = document.getElementById('conversation');
const promptForm = document.getElementById('promptForm');
const promptInput = document.getElementById('promptInput');
const statusEl = document.getElementById('status');

const conversation = [];

function renderConversation() {
	conversationEl.innerHTML = conversation
		.map((entry) => `
		<div class="message ${entry.role}">
			<span class="role">${entry.role === 'user' ? 'You' : 'Tara'}</span>
			<div>${entry.content}</div>
		</div>
		`)
		.join('');
	conversationEl.scrollTop = conversationEl.scrollHeight;
}

function setStatus(text) {
	statusEl.textContent = text;
}

async function sendPrompt(prompt) {
	setStatus('Sending...');
	const payload = { messages: conversation.concat({ role: 'user', content: prompt }) };

	try {
		const response = await fetch('/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		});
		if (!response.ok) {
			const errorData = await response.json().catch(() => null);
			throw new Error(errorData?.error ?? 'Agent request failed');
		}
		const data = await response.json();
		conversation.push({ role: 'assistant', content: data.assistant || 'No response.' });
		renderConversation();
		setStatus('Response received');
	} catch (error) {
		conversation.push({ role: 'assistant', content: `Error: ${error.message}` });
		renderConversation();
		setStatus('Error sending request');
	}
}

promptForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	const prompt = promptInput.value.trim();
	if (!prompt) return;
	conversation.push({ role: 'user', content: prompt });
	renderConversation();
	promptInput.value = '';
	await sendPrompt(prompt);
});

renderConversation();
