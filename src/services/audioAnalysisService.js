const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const { OpenAI } = require('openai');
require('dotenv').config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Get duration of video (in seconds) using ffprobe
 * @param {string} videoUrl - URL or local path to the video
 * @returns {Promise<number>} - Duration in seconds
 */
function getVideoDuration(videoUrl) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoUrl, (err, metadata) => {
      if (err) {
        return reject(`Failed to get video metadata: ${err.message}`);
      }
      const duration = metadata.format.duration;
      resolve(duration);
    });
  });
}


/**
 * Extracts a portion of audio from a video buffer using ffmpeg and sends it to OpenAI for analysis.
 * @param {Buffer} videoBuffer - Buffer containing the video data
 * @returns {Promise<Object>} - Object containing detected language and news category
 */
async function extractAudioAndAnalyze(videoBuffer) {
 
  const tempVideoPath = path.join('/tmp', `temp_video_${Date.now()}.mp4`);
  const tempAudioPath = path.join('/tmp', `temp_audio_${Date.now()}.mp3`);

  // Write buffer to temp file
  fs.writeFileSync(tempVideoPath, videoBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(tempVideoPath)
      .inputOptions('-t', '30') // Limit to first 30 seconds
      .audioChannels(1) // Convert to mono
      .audioFrequency(16000) // Reduce sample rate to 16kHz (Whisper requirement)
      .audioBitrate('32k') // Reduce bitrate
      .format('mp3') // Use MP3 format instead of WAV
      .on('end', async () => {
        try {
          // Check if audio file exists and has content
          if (!fs.existsSync(tempAudioPath)) {
            throw new Error('Audio file was not created');
          }
          
          const stats = fs.statSync(tempAudioPath);
          if (stats.size === 0) {
            throw new Error('Audio file is empty');
          }

          // Use OpenAI Whisper API to transcribe
          const transcript = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempAudioPath),
            model: "whisper-1"
          });
         
          // Analyze the transcript to determine news category and language
          const analysis = await analyzeTranscript(transcript.text);
          
          // Clean up temp files
          fs.unlinkSync(tempVideoPath);
          fs.unlinkSync(tempAudioPath);

          resolve(analysis);
        } catch (error) {
          console.error('Error during transcription or analysis:', error);
          // Clean up temp files even if there's an error
          if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
          if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          
          // Return a default response instead of rejecting
          resolve({
            detectedLanguage: "en-US",
            newsCategory: "other"
          });
        }
      })
      .on('error', (err) => {
        console.error('Error during audio extraction:', err);
        // Clean up temp files on error
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        
        // Return a default response instead of rejecting
        resolve({
          detectedLanguage: "en-US",
          newsCategory: "other"
        });
      })
      .save(tempAudioPath);
  });
}

/**
 * Analyzes the transcript using OpenAI to determine news category and language.
 * @param {string} transcript - The transcript text
 * @returns {Promise<Object>} - Object containing detected language and news category
 */
async function analyzeTranscript(transcript) {
  
  const response = await openai.chat.completions.create({
    model: 'gpt-3.5-turbo',  
    messages: [
      {
        role: 'system',
        content: `You are a news content analyzer. Analyze the transcript and determine:
        1. The detected language (e.g., "en-US", "es-ES", etc.)
        2. The category of news ("Politics", "Sports", "Entertainment","Economy","Natural Disaster","Crime","War","Forces","Technology" etc.)
        
        Respond with a JSON object containing:
        {
          "detectedLanguage": string,
          "newsCategory": string
        }`
      },
      {
        role: 'user',
        content: `Analyze this transcript: "${transcript}"`
      }
    ],
    response_format: { type: "json_object" }
  });
  return JSON.parse(response.choices[0].message.content);
}

/**
 * Extracts the starting and ending timestamps for each transcript in the Result array.
 * @param {Array} result - Array of transcript objects with words containing timestamps
 * @returns {Array} - Array of objects with transcript and its timestamps
 */
function getTranscriptTimestamps(result) {
  // Handle null or undefined result
  if (!result || !Array.isArray(result) || result.length === 0) {
    return [];
  }
  
  return result.map(item => {
    const words = item.words;
    if (!words || words.length === 0) {
      return {
        transcript: item.transcript,
        startTime: 0,
        endTime: 0
      };
    }
    const startTime = parseFloat(words[0].startTime);
    const endTime = parseFloat(words[words.length - 1].endTime);
    return {
      transcript: item.transcript,
      languageCode: item.languageCode || 'others',
      startTime,
      endTime
    };
  });
}

module.exports = {
  extractAudioAndAnalyze,
  getTranscriptTimestamps,
  getVideoDuration
}; 