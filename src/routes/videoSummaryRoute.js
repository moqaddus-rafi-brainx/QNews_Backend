const express = require('express');
const router = express.Router();
const { summarizeVideo, upload } = require('../controllers/videoAnalysisController');

/**
 * @route POST /api/v2/analyze-video
 * @desc Analyze and summarize a video file
 * @access Public
 */
router.post('/analyze-video', upload.single('video'), summarizeVideo);

module.exports = router; 