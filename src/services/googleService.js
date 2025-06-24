const { VideoIntelligenceServiceClient } = require('@google-cloud/video-intelligence');
require('dotenv').config();

// Setup Google Cloud client with environment variables
const client = new VideoIntelligenceServiceClient({
  credentials: {
    client_email: process.env.GOOGLE_CLIENT_EMAIL,
    private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n')
  }
});

/**
 * Annotates a video using Google Video Intelligence API
 * @param {Buffer} fileBuffer - The video file buffer
 * @param {string} languageCode - The language code for speech transcription
 * @returns {Promise<Object>} The operation result from Google Video Intelligence
 */
async function annotateVideoWithGoogle(fileBuffer, languageCode) {
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
        languageCode: languageCode,
        enableAutomaticPunctuation: true
      }
    }
  };

  const [operation] = await client.annotateVideo(request);
  const [operationResult] = await operation.promise();
  return operationResult;
}

/**
 * Processes video annotation results and extracts structured data
 * @param {Buffer} fileBuffer - The video file buffer
 * @param {string} detectedLanguage - The detected language from audio analysis
 * @returns {Promise<Object>} Processed annotation results with speech transcripts, labels, and shots
 */
async function processVideoAnnotation(fileBuffer, detectedLanguage) {
  // Use the Google Service for video annotation
  const operationResult = await annotateVideoWithGoogle(fileBuffer, detectedLanguage);
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

  return {
    speechTranscripts,
    labels,
    shots,
    operationResult
  };
}

module.exports = {
  annotateVideoWithGoogle,
  processVideoAnnotation
}; 