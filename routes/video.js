const express = require('express');
const { postVideoInfo } = require('../app/controllers/videoInfo');
const { postDownload, getJobStatus } = require('../app/controllers/videoDownload');
const { serveDownload } = require('../app/controllers/fileController');

const router = express.Router();
router.post('/info', postVideoInfo);
router.post('/download', postDownload);
router.get('/job/:id', getJobStatus);

// route to stream/download the saved files
// NOTE: this serves files from public/downloads via controlled res.download
router.get('/downloads/:filename', serveDownload);

module.exports = router;
