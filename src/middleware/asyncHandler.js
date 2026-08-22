// Wraps an async Express handler so any thrown/rejected error is forwarded
// to next(err) instead of crashing the process or requiring a manual
// try/catch purely to catch "something unexpected broke" cases. Deliberate
// in-handler try/catch blocks that return specific 400/403/404/409 responses
// are untouched by this — they keep handling their own business-logic paths.
export default (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
