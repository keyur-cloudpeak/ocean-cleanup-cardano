function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
}

export default errorHandler;
