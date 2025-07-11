const express = require('express');
const router = express.Router();
const { summarizeVideo, upload, summarizeVideo2,summarizeVideo3,summarizeVideo4,summarizeVideo5,testingUsingPunctuationAndDiffModel } = require('../controllers/videoAnalysisController');
const { getSignedUrl } = require('../controllers/signedUrlController');

/**
 * @route POST /api/v2/analyze-video
 * @desc Analyze and summarize a video url
 * @access Public
 */
router.post('/analyze-video', summarizeVideo2);
router.post('/analyze-video2',upload.single('video'), summarizeVideo5);

/**
 * @route POST /api/v2/get-signed-url
 * @desc Generate signed URL for Google Cloud Storage upload
 * @access Public
 */
router.post('/get-signed-url', getSignedUrl);

module.exports = router; 