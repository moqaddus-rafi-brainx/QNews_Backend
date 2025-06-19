const Shotstack = require('shotstack-sdk');
const defaultClient = Shotstack.ApiClient.instance;
require('dotenv').config();
defaultClient.authentications['DeveloperKey'].apiKey = process.env.SHOTSTACK_API_KEY;


const editApi = new Shotstack.EditApi();


/**
 * Create a video from specific segments using Shotstack
 * 
 * @param {string} videoSrc - Public video URL
 * @param {Array<{startTime: number, endTime: number}>} segmentsToKeep - Array of segments to keep, each with startTime and endTime in seconds
 * @param {number} totalDuration - Total duration of the original video in seconds
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
   
    return renderId;
  } catch (error) {
    console.error('Render failed:', error.response?.text || error.message);
    throw new Error(`Video rendering failed: ${error.response?.text || error.message}`);
  }
}

module.exports = {
  removeClipFromVideo
}