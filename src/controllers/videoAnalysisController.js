const path = require('path');
const multer = require('multer');
const { LANGUAGE_NAMES } = require('../constants/languages');
const { extractAudioAndAnalyze, getTranscriptTimestamps } = require('../services/audioAnalysisService');
const { groupRelatedTranscripts,analyzeMainTopic } = require('../services/openAIService');
const { analyzeVideoLabels, analyzeShots ,analyzeShotRelevance,separateAndMergeRelevantShots,selectMostRelevantShotsWithin30sGreedy} = require('../services/visualAnalysisService');
const { uploadVideoToCloudinary } = require('../services/cloudinaryUpload');
const { removeClipFromVideo,overlayAudioOnVideo } = require('../services/videoTrimmingService');
const { annotateVideoWithGoogle, processVideoAnnotation } = require('../services/googleService');
const { generateVoiceOver, convertTextToSpeech } = require('../services/voiceOverGenerationService');
require('dotenv').config();

// Configure multer for in-memory storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

/**
 * Handles the complete video upload, analysis, and processing workflow
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function summarizeVideo(req, res) {
 
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const description = req.body.summary || null;
    const fileBuffer = req.file.buffer;

    // Step 1: Analyze audio first
    const audioAnalysis = await extractAudioAndAnalyze(fileBuffer);
    

    // Step 2: Process video annotation using the Google service
    const { speechTranscripts, labels, shots, operationResult } = await processVideoAnnotation(fileBuffer, audioAnalysis.detectedLanguage);

    // Step 3: Analyze main topic using transcripts
    const mainTopicUsingTranscripts = await analyzeMainTopic(speechTranscripts, description);

    let language = null;
    let mainTopic = null;
    let summary = null;
    let relevantContent = null;
    let irrelevantContent = null;
    let category = null;
    let audioDuration = null;

    // Step 4: Process based on transcript sufficiency
    if (mainTopicUsingTranscripts.main_topic === "Transcript is too short to determine the main topic" || mainTopicUsingTranscripts.is_sufficient === false) {
      
      // Analyze video labels using OpenAI
      const mainTopicUsingLabels = await analyzeVideoLabels(labels);
      
      // Analyze each shot using OpenAI Vision
      const shotAnalyses = await analyzeShots(fileBuffer, shots);
      const shotRelevance = await analyzeShotRelevance(shotAnalyses, description);
      const { selectedShots, totalDuration } = await selectMostRelevantShotsWithin30sGreedy(shotRelevance.shots);
      
      audioDuration = totalDuration;
      language = shotRelevance.detectedLanguage;
      mainTopic = shotRelevance.mainTopic;
      summary = shotRelevance.summary;
      category = shotRelevance.newsCategory;
      
      const mergedShots = separateAndMergeRelevantShots(selectedShots, shotRelevance.shots);
      relevantContent = mergedShots.relevantShots;
      irrelevantContent = mergedShots.irrelevantShots;
    } else {
      
      const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
      const groupedTranscripts = await groupRelatedTranscripts(transcriptTimestamps, fileBuffer, shots, mainTopicUsingTranscripts);
    
      
      mainTopic = groupedTranscripts.main_topic;
      summary = groupedTranscripts.summary;
      category = groupedTranscripts.category;
      audioDuration = groupedTranscripts.totalDuration;
      language = LANGUAGE_NAMES[(speechTranscripts[0]?.languageCode || '').toLowerCase()] || 'Unknown';
      relevantContent = groupedTranscripts.relevant_content.mergedContent;
      irrelevantContent = groupedTranscripts.irrelevant_content;
    }

    // Step 5: Video processing and clipping
    const segmentsToKeep = [];

    // Add merged segments
    if (relevantContent) {
      relevantContent.forEach(segment => {
        segmentsToKeep.push({
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    }

    let clippedVideoUrl = "";
    let videoWithAudioUrl = "";

    // Only proceed with video clipping if there are segments to keep
    if (segmentsToKeep.length > 0) {
      // Get the total duration from the last shot or use a default
      const totalDuration = shots[shots.length - 1]?.endTime || 70;

      // Upload video to Cloudinary
      const videoUrl = await uploadVideoToCloudinary(fileBuffer);

      // Call removeClipFromVideo with the segments
      const renderId = await removeClipFromVideo(videoUrl, segmentsToKeep, totalDuration);
      clippedVideoUrl = renderId.url;

      // Generate voice over and overlay it on the video
      const voiceOver = await generateVoiceOver(summary, relevantContent, audioDuration);
      const audioUrl = await convertTextToSpeech(voiceOver, language);
      const videoWithAudioId = await overlayAudioOnVideo(clippedVideoUrl, audioUrl, audioDuration);
      videoWithAudioUrl = videoWithAudioId.url;
    }

    // Step 6: Return comprehensive results
    const results = {
      language,
      mainTopic,
      summary,
      category,
      relevantContent,
      irrelevantContent,
      audioDuration,
      shots,
      operationResult,
      clippedVideoUrl,
      videoWithAudioUrl
    };

    res.json(results);

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}

module.exports = {
  summarizeVideo,
  upload
};
