const Shotstack = require('shotstack-sdk');
const defaultClient = Shotstack.ApiClient.instance;
const axios = require('axios');
require('dotenv').config();
defaultClient.authentications['DeveloperKey'].apiKey = process.env.SHOTSTACK_API_KEY;

const editApi = new Shotstack.EditApi();
const { getVideoDuration } = require('./audioAnalysisService');

/**
 * Wait for render to complete by polling the status using direct API calls
 * @param {string} renderId - The render ID to check
 * @param {number} maxWaitTime - Maximum time to wait in milliseconds (default: 5 minutes)
 * @param {number} pollInterval - Polling interval in milliseconds (default: 5 seconds)
 * @returns {Promise<Object>} - The final render response
 */
async function waitForRenderCompletion(renderId, maxWaitTime = 5 * 60 * 1000, pollInterval = 5000) {
  const startTime = Date.now();
  
  while (Date.now() - startTime < maxWaitTime) {
    try {
      // Use axios directly to avoid SDK asset parsing issues
      const response = await axios.get(`https://api.shotstack.io/v1/render/${renderId}`, {
        headers: {
          'x-api-key': process.env.SHOTSTACK_API_KEY,
          'Content-Type': 'application/json'
        }
      });
      
      const status = response.data.response.status;
      
      if (status === 'done') {
        return response.data.response;
      } else if (status === 'failed') {
        throw new Error(`Render ${renderId} failed with status: ${status}`);
      } else if (status === 'cancelled') {
        throw new Error(`Render ${renderId} was cancelled`);
      }
      
      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
    } catch (error) {
      if (error.response?.status === 404) {
        await new Promise(resolve => setTimeout(resolve, pollInterval));
        continue;
      }
      
      console.error(`❌ Error checking render status for ${renderId}:`, error.message);
      throw error;
    }
  }
  
  throw new Error(`Render ${renderId} timed out after ${maxWaitTime / 1000} seconds`);
}

/**
 * Create a video from specific segments using Shotstack
 * 
 * @param {string} videoSrc - Public video URL
 * @param {Array<{startTime: number, endTime: number}>} segmentsToKeep - Array of segments to keep, each with startTime and endTime in seconds
 * @param {number} totalDuration - Total duration of the original video in seconds
 * @returns {Promise<Object>} - The completed render response with video URL
 */
async function removeClipFromVideo(videoSrc, segmentsToKeep, totalDuration) {
  // Validate input parameters
  if (!videoSrc || typeof videoSrc !== 'string') {
    throw new Error("Invalid video source URL");
  }

  if (!Array.isArray(segmentsToKeep) || segmentsToKeep.length === 0) {
    throw new Error("segmentsToKeep must be a non-empty array");
  }

  if (typeof totalDuration !== 'number' || totalDuration <= 0) {
    throw new Error("totalDuration must be a positive number");
  }

  // Sort segments by start time
  segmentsToKeep.sort((a, b) => a.startTime - b.startTime);

  // Validate segments
  for (let i = 0; i < segmentsToKeep.length; i++) {
    const segment = segmentsToKeep[i];
    
    if (typeof segment.startTime !== 'number' || typeof segment.endTime !== 'number') {
      throw new Error(`Invalid segment at index ${i}: startTime and endTime must be numbers`);
    }

    if (segment.startTime < 0 || segment.endTime < 0) {
      throw new Error(`Invalid segment at index ${i}: startTime and endTime must be positive`);
    }

    if (segment.startTime >= segment.endTime) {
      throw new Error(`Invalid segment at index ${i}: startTime must be less than endTime`);
    }


    // Check for overlapping segments
    if (i > 0 && segment.startTime < segmentsToKeep[i-1].endTime) {
      throw new Error(`Invalid segment at index ${i}: segments cannot overlap`);
    }
  }

  const clips = [];
  let outputTime = 0;

  // Process each segment to keep
  for (const segment of segmentsToKeep) {
    const clipLength = segment.endTime - segment.startTime;
    clips.push({
      asset: {
        type: 'video',
        src: videoSrc,
        trim: segment.startTime
      },
      start: outputTime,
      length: clipLength,
      transition: {
        in: "fade",
        out: "fade"
      },
      fit: 'crop'
    });
    outputTime += clipLength;
  }

  const edit = {
    timeline: {
      tracks: [
        {
          clips: clips
        }
      ]
    },
    output: {
      format: 'mp4',
      resolution: "1080"
    }
  };

  try {
    const response = await editApi.postRender(edit);
    const renderId = response.response.id;
    
    // Wait for render to complete
    const completedRender = await waitForRenderCompletion(renderId);
    
    return completedRender;
  } catch (error) {
    console.error('❌ Video trimming failed:', error.response?.text || error.message);
    throw new Error(`Video trimming failed: ${error.response?.text || error.message}`);
  }
}

/**
 * Overlay audio on a video using Shotstack
 * 
 * @param {string} videoSrc - Public video URL
 * @param {string} audioSrc - Public audio URL (MP3, WAV, etc.)
 * @param {number} duration - Duration of the audio in seconds
 * @param {number} videoDuration - Duration of the video in seconds
 * @param {number} audioStartTime - When to start playing the audio (default: 0)
 * @param {number} audioVolume - Audio volume level (0.0 to 1.0, default: 1.0)
 * @returns {Promise<Object>} - The completed render response with video URL
 */
async function overlayAudioOnVideo(videoSrc, audioSrc, duration, videoDuration, audioStartTime = 0.5, audioVolume = 1.0) {
  // Validate input parameters
  const audioDuration=await getVideoDuration(audioSrc);
  console.log(audioDuration);
  if (!videoSrc || typeof videoSrc !== 'string') {
    throw new Error("Invalid video source URL");
  }

  if (!audioSrc || typeof audioSrc !== 'string') {
    throw new Error("Invalid audio source URL");
  }

  if (typeof videoDuration !== 'number' || videoDuration <= 0) {
    throw new Error("videoDuration must be a positive number");
  }

  if (typeof audioDuration !== 'number' || audioDuration <= 0) {
    throw new Error("duration must be a positive number");
  }

  if (typeof audioStartTime !== 'number' || audioStartTime < 0) {
    throw new Error("audioStartTime must be a non-negative number");
  }

  if (typeof audioVolume !== 'number' || audioVolume < 0 || audioVolume > 1) {
    throw new Error("audioVolume must be between 0.0 and 1.0");
  }

  // Calculate audio speed adjustment if needed
  let audioSpeed = 1.0;
  const availableAudioTime = videoDuration - audioStartTime;
  
  if (audioDuration > availableAudioTime) {
    audioSpeed = audioDuration / availableAudioTime;
    console.log(`Audio duration (${audioDuration}s) is longer than available video time (${availableAudioTime}s)`);
    console.log(`Adjusting audio speed to ${audioSpeed.toFixed(2)}x`);
  } else {
    console.log(`Audio duration (${audioDuration}s) fits within available video time (${availableAudioTime}s)`);
  }

  const edit = {
    timeline: {
      tracks: [
        {
          clips: [
            {
              asset: {
                type: 'video',
                src: videoSrc,
                volume: 0
              },
              start: 0,
              length: videoDuration,
              fit: 'crop'
            }
          ]
        },
        {
          clips: [
            {
              asset: {
                type: 'audio',
                src: audioSrc,
                volume: audioVolume,
                speed: audioSpeed !== 1.0 ? audioSpeed : undefined
              },
              start: audioStartTime,
              length: availableAudioTime
            }
          ]
        }
      ]
    },
    output: {
      format: 'mp4',
      resolution: 'sd'
    }
  };

  try {
    console.log('Applying audio overlay with speed adjustment...');
    const response = await editApi.postRender(edit);
    const renderId = response.response.id;
    
    // Wait for render to complete
    const completedRender = await waitForRenderCompletion(renderId);
    
    return completedRender;
  } catch (error) {
    console.error('❌ Audio overlay failed:', error.response?.text || error.message);
    throw new Error(`Audio overlay failed: ${error.response?.text || error.message}`);
  }
}

/**
 * Divides text into equal chunks based on duration
 * @param {string} text - Text to divide
 * @param {number} duration - Duration in seconds
 * @param {number} maxChunks - Maximum number of chunks to create
 * @returns {Array} Array of text chunks with timing
 */
function divideTextIntoChunks(text, duration, maxChunks = 3) {
  if (!text || duration <= 0) {
    return [];
  }

  // Split text into words
  const words = text.trim().split(/\s+/);
  const totalWords = words.length;
  
  if (totalWords === 0) {
    return [];
  }

  // Calculate optimal number of chunks (max 3 chunks, min 1)
  const optimalChunks = Math.min(maxChunks, Math.max(1, Math.ceil(totalWords / 8)));
  const wordsPerChunk = Math.ceil(totalWords / optimalChunks);
  const chunkDuration = duration / optimalChunks;

  const chunks = [];
  
  for (let i = 0; i < optimalChunks; i++) {
    const startWordIndex = i * wordsPerChunk;
    const endWordIndex = Math.min(startWordIndex + wordsPerChunk, totalWords);
    const chunkWords = words.slice(startWordIndex, endWordIndex);
    
    if (chunkWords.length > 0) {
      chunks.push({
        text: chunkWords.join(' '),
        startTime: i * chunkDuration,
        endTime: (i + 1) * chunkDuration
      });
    }
  }

  return chunks;
}

/**
 * Applies subtitles to video using Shotstack with mergedGroups structure
 * @param {string} videoSrc - Public video URL
 * @param {Array} mergedGroups - Array of transcript groups from mergedGroups structure
 * @param {string} subtitleLanguage - Language for subtitles (default: 'en')
 * @returns {Promise<Object>} - The completed render response with video URL
 */
async function applySubtitlesWithShotstack(videoSrc, mergedGroups, totalDuration, subtitleLanguage = 'en') {
  // Validate input parameters
  if (!videoSrc || typeof videoSrc !== 'string') {
    throw new Error("Invalid video source URL");
  }

  if (!Array.isArray(mergedGroups) || mergedGroups.length === 0) {
    throw new Error("mergedGroups must be a non-empty array");
  }

  // Extract all transcripts and create subtitle clips
  const subtitleClips = [];
  let currentTime = 0;

  for (const group of mergedGroups) {
    if (!Array.isArray(group) || group.length === 0) {
      continue;
    }

    // Process each transcript in the group
    for (const transcript of group) {
      if (!transcript.transcript || !transcript.english_translation || 
          typeof transcript.startTime !== 'number' || typeof transcript.endTime !== 'number') {
        continue;
      }

      const duration = transcript.endTime - transcript.startTime;
      const textToUse = subtitleLanguage === 'en' ? transcript.english_translation : transcript.transcript;
      
      // Divide text into chunks based on duration
      const textChunks = divideTextIntoChunks(textToUse, duration);
      
      // Create subtitle clips for each chunk
      for (const chunk of textChunks) {
        subtitleClips.push({
          asset: {
            type: 'title',
            text: chunk.text,
            style: 'minimal',
            color: '#FFFFFF',
            size: 'medium',
            background: '#000000',
            position: 'bottom'
          },
          start: currentTime + chunk.startTime,
          length: chunk.endTime - chunk.startTime
        });
      }
    }

    // Update current time to the end of this group
    if (group.length > 0) {
      const lastTranscript = group[group.length - 1];
      currentTime = lastTranscript.endTime;
    }
  }

  if (subtitleClips.length === 0) {
    throw new Error("No valid subtitle clips generated");
  }

  const edit = {
    timeline: {
      tracks: [
        {
          clips: [
            {
              asset: {
                type: 'video',
                src: videoSrc
              },
              start: 0,
              length: totalDuration,
              fit: 'crop'
            }
          ]
        },
        {
          clips: subtitleClips
        }
      ]
    },
    output: {
      format: 'mp4',
      resolution: 'sd'
    }
  };

  try {
    console.log('Applying subtitles with Shotstack...');
    console.log('Total subtitle clips:', subtitleClips.length);
    console.log('Video duration:', totalDuration);
    console.log('Subtitle language:', subtitleLanguage);
    
    const response = await editApi.postRender(edit);
    const renderId = response.response.id;
    
    // Wait for render to complete
    const completedRender = await waitForRenderCompletion(renderId);
    
    console.log('Subtitles applied successfully');  
    return completedRender;
  } catch (error) {
    console.error('❌ Subtitle application failed:', error.response?.text || error.message);
    throw new Error(`Subtitle application failed: ${error.response?.text || error.message}`);
  }
}

module.exports = {
  removeClipFromVideo,
  overlayAudioOnVideo,
  applySubtitlesWithShotstack
}