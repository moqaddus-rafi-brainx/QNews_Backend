const express = require('express');
const router = express.Router();
const { summarizeVideo, upload, summarizeVideo2,summarizeVideo3 } = require('../controllers/videoAnalysisController');

/**
 * @route POST /api/v2/analyze-video
 * @desc Analyze and summarize a video file
 * @access Public
 */
router.post('/analyze-video', upload.single('video'), summarizeVideo2);
router.post('/analyze-video2', upload.single('video'), summarizeVideo2);

module.exports = router; 