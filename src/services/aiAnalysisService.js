import { env } from '../config/env.js';

const MODEL = 'gpt-4o-mini';

const ANALYSIS_SCHEMA = {
  name: 'litter_analysis',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'isLitter',
      'trashType',
      'material',
      'priority',
      'confidence',
      'estimatedWeightKg',
      'environmentalImpact'
    ],
    properties: {
      isLitter: {
        type: 'boolean',
        description: 'True only if the photo actually shows litter or waste.'
      },
      trashType: {
        type: 'string',
        description: "The specific object, e.g. 'Plastic Water Bottle'."
      },
      material: {
        type: 'string',
        description: "Primary material, e.g. 'PET Plastic', 'Glass'."
      },
      priority: {
        type: 'string',
        enum: ['Low', 'Medium', 'High'],
        description: 'Cleanup urgency based on hazard and environmental harm.'
      },
      confidence: {
        type: 'integer',
        description: 'Confidence in this identification, 0-100.'
      },
      estimatedWeightKg: {
        type: 'number',
        description: 'Rough conservative eyeball estimate of visible litter mass in kilograms. Use 0 when isLitter is false.'
      },
      environmentalImpact: {
        type: 'string',
        description: 'One or two plain sentences describing the harm, or why the image is not litter.'
      }
    }
  }
};

const SYSTEM_PROMPT = `
You identify litter in photographs for BlueMind, an ocean-cleanup reporting app. Community members photograph litter they find so that cleanup crews can prioritise it.

Judge only what is visible. Do not speculate about objects you cannot see.

If the photo does not show litter or waste (a selfie, a screenshot, a clean beach, an indoor scene), set isLitter to false, set confidence to your confidence that it is NOT litter, set estimatedWeightKg to 0, and use environmentalImpact to explain why it is not litter.

Set priority by how much harm the item does if left in place:
- High: sharp, toxic, or entangling. Glass, syringes, fishing line, batteries, chemical containers, large debris.
- Medium: persistent plastics and metals that break down into microplastics. Bottles, bags, wrappers, cans.
- Low: small or readily biodegradable items. Paper, cardboard, food waste.

On weight: you are eyeballing a photograph, so you cannot measure mass. Give a deliberately rough, conservative approximation and lean low when unsure. Judge scale from surrounding references where you can. Never imply the figure is exact, and never invent precision such as 0.4372 — one or two decimal places is the most you should ever give.
`.trim();

export async function analyzeWasteImage({ base64, mimeType, location }) {
  if (!env.openaiApiKey) {
    const error = new Error('AI analysis is not configured');
    error.statusCode = 503;
    throw error;
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.openaiApiKey}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      response_format: { type: 'json_schema', json_schema: ANALYSIS_SCHEMA },
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, {
        role: 'user',
        content: [
          { type: 'text', text: `Analyze this image. The phone location is: ${location || 'not provided'}.` },
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
  const result = JSON.parse(text);
  const estimatedWeightKg = Math.max(0, Number(result.estimatedWeightKg) || 0);
  return {
    isLitter: Boolean(result.isLitter),
    trashType: String(result.trashType || 'Unknown'),
    material: String(result.material || 'Unknown'),
    priority: result.priority,
    confidence: Math.min(100, Math.max(0, Number(result.confidence) || 0)),
    estimatedWeightKg,
    environmentalImpact: String(result.environmentalImpact || 'No environmental impact description available.'),
    category: String(result.material || 'other').toLowerCase(),
    itemCount: result.isLitter ? 1 : 0,
    estimatedKg: estimatedWeightKg,
    description: String(result.environmentalImpact || 'No description available.'),
    disposalMethod: 'Recycled',
    shorelineType: ['Sandy beach', 'Rocky shore', 'Mangrove', 'Urban outfall', 'Riverbank'].includes(result.shorelineType) ? result.shorelineType : 'Sandy beach',
    tideState: ['Low tide', 'Mid tide', 'High tide'].includes(result.tideState) ? result.tideState : 'Mid tide',
    location: location || 'Location not provided'
  };
}