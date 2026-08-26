import { env } from '../config/env.js';

const MODEL = 'gpt-4o-mini';

export async function analyzeWasteImage({ base64, mimeType, location }) {
  if (!env.openAiApiKey) {
    const error = new Error('AI analysis is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openAiApiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are an environmental cleanup image analysis AI. Analyze this cleanup image. Return JSON with exactly these keys: category (plastic, glass, metal, organic, mixed, or other), itemCount (integer), estimatedKg (number), description (short string), disposalMethod (one of Recycled, Landfill, or Hazardous waste service), shorelineType (one of Sandy beach, Rocky shore, Mangrove, Urban outfall, or Riverbank), tideState (one of Low tide, Mid tide, or High tide). Choose the safest suitable disposal method based on the visible waste. Always choose Recycled, Landfill, or Hazardous waste service; when unclear, choose Recycled. Identify the shoreline type from the visible environment. Always choose one supported shoreline type; when the image is unclear, choose the closest likely estimate instead of Unknown. Estimate the tide state from the visible waterline, exposed shore, and water coverage. Always choose Low tide, Mid tide, or High tide; when the image is unclear, choose the closest likely estimate instead of Unknown. Do not guess a precise location. The phone location is: ${location || 'not provided'}.`
          },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}`, detail: 'low' } }
        ]
      }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data?.error?.message || 'AI analysis failed');
    error.statusCode = response.status;
    throw error;
  }

  const text = data?.choices?.[0]?.message?.content || '{}';
  const result = JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
  return {
    category: String(result.category || 'other').toLowerCase(),
    itemCount: Math.max(0, Number(result.itemCount) || 0),
    estimatedKg: Math.max(0, Number(result.estimatedKg) || 0),
    description: String(result.description || 'No description available.'),
    disposalMethod: ['Recycled', 'Landfill', 'Hazardous waste service'].includes(result.disposalMethod) ? result.disposalMethod : 'Recycled',
    shorelineType: ['Sandy beach', 'Rocky shore', 'Mangrove', 'Urban outfall', 'Riverbank'].includes(result.shorelineType) ? result.shorelineType : 'Sandy beach',
    tideState: ['Low tide', 'Mid tide', 'High tide'].includes(result.tideState) ? result.tideState : 'Mid tide',
    location: location || 'Location not provided'
  };
}