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

module.exports = {
  annotateVideoWithGoogle
}; 