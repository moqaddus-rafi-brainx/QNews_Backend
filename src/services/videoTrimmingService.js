const Shotstack = require('shotstack-sdk');
const defaultClient = Shotstack.ApiClient.instance;
const axios = require('axios');
require('dotenv').config();
defaultClient.authentications['DeveloperKey'].apiKey = process.env.SHOTSTACK_API_KEY;

const editApi = new Shotstack.EditApi();

// ... existing code ...

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
      
      console.log(`🔄 Render ${renderId} status: ${status}`);
      
      if (status === 'done') {
        console.log(`✅ Render ${renderId} completed successfully!`);
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
        console.log(`⏳ Render ${renderId} not found yet, waiting...`);
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

    if (segment.endTime > totalDuration) {
      //throw new Error(`Invalid segment at index ${i}: endTime cannot be greater than total duration`);
      segment.endTime=totalDuration;
      console.log('Adjusted segment at index',i,': endTime cannot be greater than total duration');
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
      fit: 'crop'
    });
    outputTime += clipLength;
  }

  //console.log('Clips:', JSON.stringify(clips, null, 2));

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
      resolution: 'sd'
    }
  };

  //console.log('Edit object:', JSON.stringify(edit, null, 2));

  try {
    const response = await editApi.postRender(edit);
    const renderId = response.response.id;
    console.log('✅ Video trimming render started with ID:', renderId);
    
    // Wait for render to complete
    const completedRender = await waitForRenderCompletion(renderId);
    console.log('✅ Video trimming completed! URL:', completedRender.url);
    
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
 * @param {number} videoDuration - Duration of the video in seconds
 * @param {number} audioStartTime - When to start playing the audio (default: 0)
 * @param {number} audioVolume - Audio volume level (0.0 to 1.0, default: 1.0)
 * @returns {Promise<Object>} - The completed render response with video URL
 */
async function overlayAudioOnVideo(videoSrc, audioSrc, videoDuration, audioStartTime = 0, audioVolume = 1.0) {
  // Validate input parameters
  if (!videoSrc || typeof videoSrc !== 'string') {
    throw new Error("Invalid video source URL");
  }

  if (!audioSrc || typeof audioSrc !== 'string') {
    throw new Error("Invalid audio source URL");
  }

  if (typeof videoDuration !== 'number' || videoDuration <= 0) {
    throw new Error("videoDuration must be a positive number");
  }

  if (typeof audioStartTime !== 'number' || audioStartTime < 0) {
    throw new Error("audioStartTime must be a non-negative number");
  }

  if (typeof audioVolume !== 'number' || audioVolume < 0 || audioVolume > 1) {
    throw new Error("audioVolume must be between 0.0 and 1.0");
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
                volume: audioVolume
              },
              start: audioStartTime,
              length: videoDuration - audioStartTime
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
    const response = await editApi.postRender(edit);
    const renderId = response.response.id;
    console.log('✅ Audio overlay render started with ID:', renderId);
    
    // Wait for render to complete
    const completedRender = await waitForRenderCompletion(renderId);
    console.log('✅ Audio overlay completed! URL:', completedRender.url);
    
    return completedRender;
  } catch (error) {
    console.error('❌ Audio overlay failed:', error.response?.text || error.message);
    throw new Error(`Audio overlay failed: ${error.response?.text || error.message}`);
  }
}

module.exports = {
  removeClipFromVideo,
  overlayAudioOnVideo
}