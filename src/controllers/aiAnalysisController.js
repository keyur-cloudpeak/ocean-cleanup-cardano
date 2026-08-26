import { analyzeWasteImage } from '../services/aiAnalysisService.js';

export async function analyze(req, res) {
  const { image, mimeType = 'image/jpeg', location } = req.body || {};
  if (!image) return res.status(400).json({ ok: false, message: 'An image is required' });

  try {
    const analysis = await analyzeWasteImage({ base64: image.replace(/^data:[^;]+;base64,/, ''), mimeType, location });
    res.json({ ok: true, analysis });
  } catch (error) {
    console.error('AI image analysis failed:', error.message);
    res.status(error.statusCode || 500).json({ ok: false, message: error.message || 'AI analysis failed' });
  }
}