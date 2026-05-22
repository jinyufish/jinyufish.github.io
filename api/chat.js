export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  // Forward to Dify — key stays server-side in env var
  const difyResp = await fetch('https://api.dify.ai/v1/chat-messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DIFY_CHAT_API_KEY}`,
    },
    body: JSON.stringify({
      query:           body.query,
      inputs:          body.inputs          ?? {},
      response_mode:   'streaming',
      conversation_id: body.conversation_id ?? '',
      user:            body.user            ?? 'visitor',
    }),
  });

  if (!difyResp.ok) {
    const err = await difyResp.text();
    return new Response(err, { status: difyResp.status });
  }

  // Pipe the SSE stream straight back to the browser
  return new Response(difyResp.body, {
    status: 200,
    headers: {
      'Content-Type':       'text/event-stream',
      'Cache-Control':      'no-cache, no-transform',
      'X-Accel-Buffering':  'no',
      'Transfer-Encoding':  'chunked',
    },
  });
}
