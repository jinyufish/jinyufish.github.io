export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  try {
    const difyResp = await fetch('https://api.dify.ai/v1/workflows/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DIFY_SUGGEST_API_KEY}`,
      },
      body: JSON.stringify({
        inputs:        body.inputs ?? {},
        response_mode: 'blocking',
        user:          body.user   ?? 'visitor',
      }),
    });

    const data = await difyResp.json();
    return res.status(difyResp.status).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
