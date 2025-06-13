const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const path = require('path');
const multer = require('multer');
const { LANGUAGE_NAMES } = require('../constants/languages');
const { extractAudioAndAnalyze, getTranscriptTimestamps } = require('../services/audioAnalysisService');
const { groupRelatedTranscripts } = require('../services/openAIService');
const uploadVideoToCloudinary = require('../services/cloudinaryUpload');
const { removeClipFromVideo } = require('../services/videoTrimmingService');
require('dotenv').config();

// Setup Google Cloud client with environment variables
const client = new VideoIntelligenceServiceClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }
});

// Configure multer for in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Analyzes a video file and returns comprehensive analysis results
 * @param {Buffer} fileBuffer - The video file buffer
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeVideo(fileBuffer) {
  try {
    // Analyze audio first
    const audioAnalysis = await extractAudioAndAnalyze(fileBuffer);
   // console.log('Audio Analysis:', audioAnalysis);

    const request = {
      inputContent: fileBuffer.toString('base64'),
      features: [
        'SPEECH_TRANSCRIPTION',
        'LABEL_DETECTION',
        'SHOT_CHANGE_DETECTION',
        //'TEXT_DETECTION'
      ],
      videoContext: {
        speechTranscriptionConfig: {
          languageCode: audioAnalysis.detectedLanguage,
          enableAutomaticPunctuation: true
        }
      }
    };

    const [operation] = await client.annotateVideo(request);
    const [operationResult] = await operation.promise();
    let annotationResults;
    let segmentLabelAnnotations;
    let shotAnnotations;
    
    // Safely check if speechTranscriptions exists and is not empty
    const hasTranscriptions0 = operationResult.annotationResults[0]?.speechTranscriptions?.length > 0;
    const hasTranscriptions1 = operationResult.annotationResults[1]?.speechTranscriptions?.length > 0;

    if(hasTranscriptions0) {
      annotationResults = operationResult.annotationResults[0];
      segmentLabelAnnotations = operationResult.annotationResults[1]?.segmentLabelAnnotations || [];
      shotAnnotations = operationResult.annotationResults[1]?.shotAnnotations || [];
    }
    else if(hasTranscriptions1) {
      annotationResults = operationResult.annotationResults[1];
      segmentLabelAnnotations = operationResult.annotationResults[0]?.segmentLabelAnnotations || [];
      shotAnnotations = operationResult.annotationResults[0]?.shotAnnotations || [];
    }
    else {
      // Handle case where no transcriptions are found
      annotationResults = { speechTranscriptions: [] };
      segmentLabelAnnotations = [];
      shotAnnotations = [];
    }

    const speechTranscripts = annotationResults.speechTranscriptions.map(t => {
      return t.alternatives[0] && {
        transcript: t.alternatives[0].transcript,
        confidence: t.alternatives[0].confidence,
        languageCode: t.languageCode || 'unknown',
        words: t.alternatives[0].words.map(w => ({
          word: w.word,
          startTime: parseFloat(w.startTime.seconds || 0) + parseFloat(w.startTime.nanos) * 1e-9,
          endTime: parseFloat(w.endTime.seconds || 0) + parseFloat(w.endTime.nanos) * 1e-9
        }))
      };
    }).filter(Boolean);

    const labels = (segmentLabelAnnotations || []).map(label => ({
      description: label.entity.description,
      categories: (label.categoryEntities || []).map(cat => cat.description),
      segments: label.segments.map(seg => ({
        startTime: parseFloat(seg.segment.startTimeOffset.seconds || 0) + parseFloat(seg.segment.startTimeOffset.nanos) * 1e-9,
        endTime: parseFloat(seg.segment.endTimeOffset.seconds || 0) + parseFloat(seg.segment.endTimeOffset.nanos) * 1e-9
      }))
    }));

    const shots = (shotAnnotations || []).map(shot => ({
      startTime: parseFloat(shot.startTimeOffset.seconds || 0) + parseFloat(shot.startTimeOffset.nanos) * 1e-9,
      endTime: parseFloat(shot.endTimeOffset.seconds || 0) + parseFloat(shot.endTimeOffset.nanos) * 1e-9
    }));

    const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
    const groupedTranscripts = await groupRelatedTranscripts(transcriptTimestamps, fileBuffer);
    //console.log('Grouped Transcripts:', groupedTranscripts);
    return {
      languageDetails: {
        confidence: annotationResults.speechTranscriptions[0]?.alternatives[0]?.confidence || 0
      },
      Language: LANGUAGE_NAMES[(speechTranscripts[0]?.languageCode || '').toLowerCase()] || 'Unknown',
      LanguageCode: speechTranscripts[0]?.languageCode,
      labels,
      shots,
      groupedTranscripts,
      operationResult
    };

  } catch (error) {
    console.error('Error in video analysis:', error);
    throw error;
  }
}

/**
 * Processes a video file, analyzes it, and returns the clipped video URL
 * @param {Buffer} fileBuffer - The video file buffer
 * @returns {Promise<Object>} Analysis results with clipped video URL
 */
async function processVideo(fileBuffer) {
  try {
    const analysisResults = await analyzeVideo(fileBuffer);

    // Extract segments from relevant_content
    const segmentsToKeep = [];

    // Add merged segments
    if (analysisResults.groupedTranscripts.relevant_content.merged_segments) {
      analysisResults.groupedTranscripts.relevant_content.merged_segments.forEach(segment => {
        segmentsToKeep.push({
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    }

    // Add unmerged segments
    if (analysisResults.groupedTranscripts.relevant_content.unmerged_segments) {
      analysisResults.groupedTranscripts.relevant_content.unmerged_segments.forEach(segment => {
        segmentsToKeep.push({
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    }

    //console.log('Segments to keep:', segmentsToKeep);

    // Upload video to Cloudinary
    const videoUrl = await uploadVideoToCloudinary(fileBuffer);
    //console.log('Video uploaded to Cloudinary:', videoUrl);

    let clippedVideoUrl;
    
    // Only proceed with video clipping if there are segments to keep
    if (segmentsToKeep.length > 0) {
      // Get the total duration from the last shot or use a default
      const totalDuration = analysisResults.shots[analysisResults.shots.length - 1]?.endTime || 70;

      // Call removeClipFromVideo with the segments
      const renderId = await removeClipFromVideo(videoUrl, segmentsToKeep, totalDuration);
      //console.log('Render ID:', renderId);
      const ownerId = process.env.OWNER_ID;
      clippedVideoUrl = `https://shotstack-api-v1-output.s3-ap-southeast-2.amazonaws.com/${ownerId}/${renderId}.mp4`;
    } else {
      // If no segments to keep, use the original video URL
      clippedVideoUrl = videoUrl;
    }

    return {
      ...analysisResults,
      clippedVideoUrl
    };
  } catch (error) {
    console.error('Error in video processing:', error);
    throw error;
  }
}

/**
 * Handles the video upload and processing request
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function handleVideoUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const results = await processVideo(req.file.buffer);
    res.json(results);

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video' });
  }
}

module.exports = {
  analyzeVideo,
  processVideo,
  handleVideoUpload,
  upload
};
