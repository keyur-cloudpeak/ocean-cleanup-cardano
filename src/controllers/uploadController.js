function upload(req, res) {
  res.status(201).json({
    ok: true,
    message: 'Upload endpoint ready',
    payload: req.body
  });
}

export default { upload };
