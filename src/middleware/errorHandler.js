function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
}

export default errorHandler;
