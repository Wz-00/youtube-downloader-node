const express = require('express');
const videoControllers = require('../app/controllers/videoControllers');

const router = express.Router();

router.get('/', videoControllers.getVideos);
router.post('/', videoControllers.downloadVideo);

module.exports = router;
