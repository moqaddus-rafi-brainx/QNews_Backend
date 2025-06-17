const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
const path = require('path');
const multer = require('multer');
const { LANGUAGE_NAMES } = require('../constants/languages');
const { extractAudioAndAnalyze, getTranscriptTimestamps } = require('../services/audioAnalysisService');
const { groupRelatedTranscripts,analyzeMainTopic } = require('../services/openAIService');
const { analyzeVideoLabels, analyzeShots ,analyzeShotRelevance,separateAndMergeRelevantShots} = require('../services/visualAnalysisService');
const uploadVideoToCloudinary = require('../services/cloudinaryUpload');
const { removeClipFromVideo } = require('../services/videoTrimmingService');
const { annotateVideoWithGoogle } = require('../services/googleService');
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
async function analyzeVideo(fileBuffer,decription) {
  try {
    // Analyze audio first
    const audioAnalysis = await extractAudioAndAnalyze(fileBuffer);
    //console.log('Audio Analysis:', audioAnalysis);

    // Use the new Google Service for video annotation
    const operationResult = await annotateVideoWithGoogle(fileBuffer, audioAnalysis.detectedLanguage);
    let annotationResults;
    let segmentLabelAnnotations;
    let shotAnnotations;
    //console.log('Operation Result:',operationResult);
    // Safely check if speechTranscriptions exists and is not empty
    const hasTranscriptions0 = operationResult.annotationResults[0]?.speechTranscriptions?.length > 0;
    const hasTranscriptions1 = operationResult.annotationResults[1]?.speechTranscriptions?.length > 0;

    if(hasTranscriptions0) {
      annotationResults = operationResult.annotationResults[0];
      segmentLabelAnnotations = operationResult.annotationResults[1]?.segmentLabelAnnotations || [];
      shotAnnotations = operationResult.annotationResults[1]?.shotAnnotations || [];
      //console.log('Shot Annotations:',shotAnnotations);
    }
    else if(hasTranscriptions1) {
      annotationResults = operationResult.annotationResults[1];
      segmentLabelAnnotations = operationResult.annotationResults[0]?.segmentLabelAnnotations || [];
      shotAnnotations = operationResult.annotationResults[0]?.shotAnnotations || [];
      
      //console.log('Shot Annotations:',shotAnnotations);
    }
    else {
      // Handle case where no transcriptions are found
      annotationResults = { speechTranscriptions: [] };
      segmentLabelAnnotations =
  operationResult.annotationResults[0]?.segmentLabelAnnotations?.length
    ? operationResult.annotationResults[0].segmentLabelAnnotations
    : operationResult.annotationResults[1]?.segmentLabelAnnotations || [];

  shotAnnotations =
  operationResult.annotationResults[0]?.shotAnnotations?.length
    ? operationResult.annotationResults[0].shotAnnotations
    : operationResult.annotationResults[1]?.shotAnnotations || [];
      
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

    let mainTopicUsingLabels = null;
    let shotAnalyses = null;
    let shotRelevance = null;
    let mergedShots = null;
    let language = null;
    let mainTopic = null;
    let summary = null;
    let relevantContent = null;
    let irrelevantContent = null;
    let isNews = null;
    let category = null;
    const mainTopicUsingTranscripts = await analyzeMainTopic(speechTranscripts);

    //Analyze video labels using OpenAI
        //mainTopicUsingLabels = await analyzeVideoLabels(labels);
        // Analyze each shot using OpenAI Vision
        //console.log('Analyzing shots:',shots);
       // shotAnalyses = await analyzeShots(fileBuffer, shots);
       // shotRelevance= await analyzeShotRelevance(shotAnalyses);

      // Analyze video labels using OpenAI
     //    mainTopicUsingLabels = await analyzeVideoLabels(labels);
        //  // Analyze each shot using OpenAI Vision
        //  shotAnalyses = await analyzeShots(fileBuffer, shots);
        //  shotRelevance= await analyzeShotRelevance(shotAnalyses);
        //  mergedShots=separateAndMergeRelevantShots(shotRelevance);

     if (!mainTopicUsingTranscripts.is_news || mainTopicUsingTranscripts.main_topic === "Transcript is too short to determine the main topic")
     {
       // Analyze video labels using OpenAI
         mainTopicUsingLabels = await analyzeVideoLabels(labels);
         // Analyze each shot using OpenAI Vision
         shotAnalyses = await analyzeShots(fileBuffer, shots);
         shotRelevance= await analyzeShotRelevance(shotAnalyses,decription);
         language=shotRelevance.detectedLanguage;
         mainTopic=shotRelevance.mainTopic;
         summary=shotRelevance.summary;
         isNews=shotRelevance.isNewsVideo;
         category=shotRelevance.newsCategory;
        //  console.log('Category:',category);
        //  console.log('Is News:',isNews);
        //  console.log('Shot Relevance:',shotRelevance);
         
         mergedShots=separateAndMergeRelevantShots(shotRelevance.shots);
         relevantContent=mergedShots.relevantShots;
         irrelevantContent=mergedShots.irrelevantShots;
     }
     else
     {
      const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
      const groupedTranscripts = await groupRelatedTranscripts(transcriptTimestamps, fileBuffer, shots,mainTopicUsingTranscripts);
      //console.log('Grouped Transcripts:', groupedTranscripts);
      mainTopic=groupedTranscripts.main_topic;
      summary=groupedTranscripts.summary;
      isNews=groupedTranscripts.is_news;
      category=groupedTranscripts.category;
      language=LANGUAGE_NAMES[(speechTranscripts[0]?.languageCode || '').toLowerCase()] || 'Unknown';
      relevantContent=groupedTranscripts.relevant_content.mergedContent;
      irrelevantContent=groupedTranscripts.irrelevant_content;

      
     }
     isNews=true;
    

   

    
    return {
      
      language,
      mainTopic,
      summary,
      isNews,
      category,
      relevantContent,
      irrelevantContent,
      shots,
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
async function processVideo(fileBuffer,decription) {
  try {
    const analysisResults = await analyzeVideo(fileBuffer,decription);

    // Extract segments from relevant_content
    const segmentsToKeep = [];

   // Add merged segments
    if (analysisResults.relevantContent) {
      analysisResults.relevantContent.forEach(segment => {
        segmentsToKeep.push({
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    }

    console.log('Segments to keep:', segmentsToKeep);


    let clippedVideoUrl;
    
    //Only proceed with video clipping if there are segments to keep
    if (segmentsToKeep.length > 0) {
      // Get the total duration from the last shot or use a default
      const totalDuration = analysisResults.shots[analysisResults.shots.length - 1]?.endTime || 70;

      // Upload video to Cloudinary
    const videoUrl = await uploadVideoToCloudinary(fileBuffer);
    //console.log('Video uploaded to Cloudinary:', videoUrl);

      // Call removeClipFromVideo with the segments
      const renderId = await removeClipFromVideo(videoUrl, segmentsToKeep, totalDuration);
      //console.log('Render ID:', renderId);
      const ownerId = process.env.OWNER_ID;
      clippedVideoUrl = `https://shotstack-api-v1-output.s3-ap-southeast-2.amazonaws.com/${ownerId}/${renderId}.mp4`;
    } else {
      // If no segments to keep, use the original video URL
      clippedVideoUrl = "";
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
  console.log('handleVideoUpload');
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

   // const decription=`Ahmedabad, Jun 12 (EFE).- A passenger plane operated by Air India, carrying an estimated 200 people, crashed Thursday near the airport in Ahmedabad, a city in the western Indian state of Gujarat.\n\n \"Flight AI171, operating Ahmedabad–London Gatwick, was involved in an incident today, 12 June 2025. At this moment, we are ascertaining the details and will share further updates at the earliest\", Air India said in a statement. `
    const decription="";
    const results = await processVideo(req.file.buffer,decription);
    res.json(results);

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}

module.exports = {
  analyzeVideo,
  processVideo,
  handleVideoUpload,
  upload
};
