// api/tts.js
export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text } = req.body;
  if (!text) {
    return res.status(400).json({ error: 'Missing text' });
  }

  const apiKey = process.env.DEEPGRAM_API_KEY; // Set this in Vercel dashboard
  if (!apiKey) {
    return res.status(500).json({ error: 'Deepgram API key not configured' });
  }

  try {
    const response = await fetch('https://api.deepgram.com/v1/speak?model=aura-asteria-en&encoding=mp3', {
      method: 'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Deepgram error:', error);
      return res.status(response.status).json({ error: 'TTS failed' });
    }

    // Stream the audio back to the client
    res.setHeader('Content-Type', 'audio/mpeg');
    const audioBuffer = await response.arrayBuffer();
    res.send(Buffer.from(audioBuffer));
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}