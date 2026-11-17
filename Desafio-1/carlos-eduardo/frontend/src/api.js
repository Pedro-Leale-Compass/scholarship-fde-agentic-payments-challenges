let apiUrl = '';

export function configureApi(url) {
  apiUrl = url.replace(/\/+$/, '');
}

async function getErrorMessage(response) {
  try {
    const body = await response.json();
    return body.message || `A API retornou HTTP ${response.status}.`;
  } catch {
    return `A API retornou HTTP ${response.status}.`;
  }
}

export async function getHistory(token) {
  const response = await fetch(`${apiUrl}/conversations`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }
  return response.json();
}

export async function sendMessage(message, token, onResponse) {
  const response = await fetch(`${apiUrl}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message }),
  });
  if (
    !response.ok &&
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    throw new Error(await getErrorMessage(response));
  }
  if (!response.body) {
    throw new Error('A resposta da API não contém um fluxo de dados.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let failure = null;

  const consumeEvent = (rawEvent) => {
    const data = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) return;

    const event = JSON.parse(data);
    if (event.response) onResponse(event.response);
    if (event.error) failure = event.error;
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    buffer = buffer.replace(/\r\n/g, '\n');
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    events.forEach(consumeEvent);
    if (done) break;
  }

  if (buffer.trim()) consumeEvent(buffer);
  if (!response.ok || failure) {
    throw new Error(
      typeof failure === 'string'
        ? failure
        : await getErrorMessage(response),
    );
  }
}
