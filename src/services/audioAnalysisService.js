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
 * Extracts a portion of audio from a video buffer using ffmpeg and sends it to OpenAI for analysis.
 * @param {Buffer} videoBuffer - Buffer containing the video data
 * @returns {Promise<Object>} - Object containing detected language and news category
 */
async function extractAudioAndAnalyze(videoBuffer) {
 // console.log('Extracting audio from video buffer...');
  const tempVideoPath = path.join('/tmp', `temp_video_${Date.now()}.mp4`);
  const tempAudioPath = path.join('/tmp', `temp_audio_${Date.now()}.wav`);

  // Write buffer to temp file
  fs.writeFileSync(tempVideoPath, videoBuffer);

  return new Promise((resolve, reject) => {
    ffmpeg(tempVideoPath)
      .inputOptions('-t', '30') // Limit to first 30 seconds
      .audioChannels(1) // Convert to mono
      .audioFrequency(16000) // Reduce sample rate
      .audioBitrate('32k') // Reduce bitrate
      .format('wav')
      .on('end', async () => {
       // console.log('Audio extraction complete. Transcribing with OpenAI Whisper...');
        try {
          // Use OpenAI Whisper API to transcribe
          const transcript = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempAudioPath),
            model: "whisper-1"
          });
         // console.log('Transcription complete. Analyzing transcript...');
          
          // Analyze the transcript to determine news category and language
          const analysis = await analyzeTranscript(transcript.text);
         // console.log('Analysis complete:', analysis);

          // Clean up temp files
          fs.unlinkSync(tempVideoPath);
          fs.unlinkSync(tempAudioPath);

          resolve(analysis);
        } catch (error) {
          console.error('Error during transcription or analysis:', error);
          // Clean up temp files even if there's an error
          if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
          if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
          reject(error);
        }
      })
      .on('error', (err) => {
        console.error('Error during audio extraction:', err);
        // Clean up temp files on error
        if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath);
        if (fs.existsSync(tempAudioPath)) fs.unlinkSync(tempAudioPath);
        reject(err);
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
  //console.log('Analyzing transcript for language and news category...');
  const response = await openai.chat.completions.create({
    model: 'gpt-4.1-nano',
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
  getTranscriptTimestamps
}; 