const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();
const { callWithRetry, processBatchWithRateLimit } = require('../utils/callWithRetry');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


const delayBetweenFrames = (ms = 300) => new Promise(res => setTimeout(res, ms));


/**
 * Generates a unique filename for temporary files
 * @returns {string} Unique filename
 */
function generateUniqueFilename() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Analyzes video labels using OpenAI to determine the main topic/idea of the video
 * @param {Array} labels - Array of label objects from video analysis
 * @returns {Promise<string>} The main topic/idea of the video
 */
async function analyzeVideoLabels(labels) {
  try {
    // Extract all label descriptions
    const labelDescriptions = labels.map(label => label.description).join(', ');

    // Create prompt for OpenAI
    const prompt = `Based on the following video labels/descriptions, what is the main topic or main idea of this video? 
    Labels: ${labelDescriptions}
    Please provide a concise summary of the main topic.`;

    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a video content analyzer. Your task is to determine the main topic or theme of a video based on its visual labels and descriptions."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        max_tokens: 150,
        temperature: 0.7
      })
    );

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error in visual analysis:', error);
    throw new Error('Failed to analyze video labels');
  }
}

/**
 * Merges transcripts that are close in time (within 8 seconds)
 * @param {Array} transcripts - Array of transcript objects
 * @returns {Array} Array of merged transcript groups
 */
function mergeCloseTranscripts(transcripts) {
  if (!transcripts || transcripts.length === 0) return [];
  
  // Sort transcripts by start time
  const sortedTranscripts = [...transcripts].sort((a, b) => 
    parseFloat(a.startTime) - parseFloat(b.startTime)
  );
  
  const mergedGroups = [];
  let currentGroup = [sortedTranscripts[0]];
  
  for (let i = 1; i < sortedTranscripts.length; i++) {
    const current = sortedTranscripts[i];
    const lastInGroup = currentGroup[currentGroup.length - 1];
    
    // Check if current transcript is within 8 seconds of the last transcript in the group
    const timeGap = parseFloat(current.startTime) - parseFloat(lastInGroup.endTime);
    
    if (timeGap <= 3) {
      // Merge into current group
      currentGroup.push(current);
    } else {
      // Start new group
      mergedGroups.push(currentGroup);
      currentGroup = [current];
    }
  }
  
  // Add the last group
  if (currentGroup.length > 0) {
    mergedGroups.push(currentGroup);
  }
  
  return mergedGroups;
}


/**
 * Extracts frames from all shots in a single FFmpeg command
 * @param {Buffer} videoBuffer - The video file buffer
 * @param {Array} shots - Array of shot objects with startTime and endTime
 * @returns {Promise<Map<string, string[]>>} Map of shot timestamps to frame arrays
 */
async function extractFramesFromShots(videoBuffer, shots) {
  const tmpDir = '/tmp';
  const videoId = generateUniqueFilename();
  const videoPath = path.join(tmpDir, `${videoId}.mp4`);
  const framesDir = path.join(tmpDir, `${videoId}_frames`);

  try {
    // Create frames directory
    await fs.mkdir(framesDir, { recursive: true });
    
    // Write video buffer to temporary file
    await fs.writeFile(videoPath, videoBuffer);

    return new Promise((resolve, reject) => {
      const shotFrames = new Map();
      
      // Safety check
      if (shots.length === 0) {
        throw new Error("No shots provided for frame extraction.");
      }

      console.log(`🎬 Extracting frames for ${shots.length} shots...`);

      // Process each shot individually to ensure exact frame count
      let processedShots = 0;
      const totalShots = shots.length;

      const processShot = async (shot, shotIndex) => {
        const duration = shot.endTime - shot.startTime;
        const frameTimestamps = [];
        
        // Calculate 4 evenly spaced timestamps within the shot
        for (let i = 0; i < 4; i++) {
          const timestamp = shot.startTime + (duration * i / 3); // 0%, 33%, 66%, 100%
          frameTimestamps.push(timestamp);
        }

        console.log(`📸 Shot ${shotIndex}: Extracting frames at timestamps: ${frameTimestamps.map(t => t.toFixed(2)).join(', ')}s`);

        const command = ffmpeg(videoPath)
          .inputOptions([
            '-ss', shot.startTime.toString(),
            '-t', duration.toString()
          ])
          .outputOptions([
            '-y',
            '-f image2',
            '-vcodec mjpeg',
            '-q:v 2',
            '-vf', `fps=1/${duration/4}` // Extract 4 frames over the duration
          ])
          .output(path.join(framesDir, `shot_${shotIndex}_frame_%d.jpg`));

        return new Promise((resolveShot, rejectShot) => {
          command
            .on('start', () => {
              console.log(`🚀 Started extracting frames for shot ${shotIndex}`);
            })
            .on('error', (err) => {
              console.error(`❌ Error extracting frames for shot ${shotIndex}:`, err);
              rejectShot(err);
            })
            .on('end', async () => {
              try {
                // Read frame files for this shot
                const files = await fs.readdir(framesDir);
                const shotFiles = files.filter(f => f.startsWith(`shot_${shotIndex}_frame_`));
                console.log(`📁 Shot ${shotIndex}: Found ${shotFiles.length} frames`);
                
                const frames = await Promise.all(
                  shotFiles.map(async (file) => {
                    const framePath = path.join(framesDir, file);
                    const frameBuffer = await fs.readFile(framePath);
                    return frameBuffer.toString('base64');
                  })
                );
                
                // Ensure we only use exactly 4 frames (take first 4 if more extracted)
                const limitedFrames = frames.slice(0, 4);
                if (frames.length > 4) {
                  console.log(`⚠️ Shot ${shotIndex}: FFmpeg extracted ${frames.length} frames, limiting to 4`);
                }
                
                shotFrames.set(`${shot.startTime}-${shot.endTime}`, limitedFrames);
                processedShots++;
                
                // Clean up shot-specific files
                await Promise.all(
                  shotFiles.map(file => fs.unlink(path.join(framesDir, file)))
                );
                
                resolveShot();
              } catch (error) {
                rejectShot(error);
              }
            })
            .run();
        });
      };

      // Process all shots sequentially to avoid conflicts
      const processAllShots = async () => {
        try {
          for (let i = 0; i < shots.length; i++) {
            await processShot(shots[i], i);
          }
          
          // Cleanup video file
          await fs.unlink(videoPath).catch(() => {});
          await fs.rmdir(framesDir).catch(() => {});
          
          resolve(shotFrames);
        } catch (error) {
          await cleanup();
          reject(error);
        }
      };

      processAllShots();

      async function cleanup() {
        try {
          await fs.unlink(videoPath).catch(() => {});
          const files = await fs.readdir(framesDir);
          await Promise.all(
            files.map(file => fs.unlink(path.join(framesDir, file)))
          );
          await fs.rmdir(framesDir).catch(() => {});
        } catch (error) {
          console.error('Error during cleanup:', error);
        }
      }
    });
  } catch (error) {
    console.error('Error in frame extraction:', error);
    throw error;
  }
}

/**
 * Analyzes a single shot using OpenAI Vision
 * @param {string[]} frames - Array of base64 encoded frames
 * @returns {Promise<string>} Description of what's shown in the shot
 */
async function analyzeShot(frames) {
  try {
    if (frames.length === 0) {
      return "No frames could be extracted from this shot.";
    }
    
    console.log(`📸 Analyzing shot with ${frames.length} frames`);
    
    // Process frames in batches to avoid rate limits
    const frameProcessor = async (frame, index) => {
      console.log(`📸 Analyzing frame #${index + 1}/${frames.length}`);
      
      const completion = await callWithRetry(() =>
        openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content: "You are a video content analyzer. Your task is to describe what is shown in this frame from a video shot."
            },
            {
              role: "user",
              content: [
                { type: "text", text: "Please describe what is shown in this frame." },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame}` } }
              ]
            }
          ],
          max_tokens: 100
        })
      );

      return completion.choices[0].message.content.trim();
    };

    // Process frames in small batches with delays to avoid rate limits
    const frameDescriptions = await processBatchWithRateLimit(
      frames, 
      frameProcessor, 
      2, // Process 2 frames at a time
      3000 // 3 second delay between batches
    );
    
    // Combine all frame descriptions into a comprehensive shot description
    const combinedCompletion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content: "You are a video content analyzer. Your task is to create a comprehensive description of a video shot based on multiple frame descriptions."
          },
          {
            role: "user",
            content: `Based on the following descriptions of ${frames.length} frames from the same shot, create a comprehensive description of what is shown in this shot:

${frameDescriptions.join('\n\n')}

Please provide a single, coherent description that captures the main content and any changes or movements shown across these frames.`
          }
        ],
        max_tokens: 100
      })
    );

    return combinedCompletion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error in shot analysis:', error);
    throw new Error('Failed to analyze shot');
  }
}

/**
 * Analyzes all shots in a video
 * @param {Buffer} videoBuffer - The video file buffer
 * @param {Array} shots - Array of shot objects with startTime and endTime
 * @returns {Promise<Array>} Array of shot descriptions
 */
async function analyzeShots(videoBuffer, shots) {
  try {
    // Extract frames for all shots in a single FFmpeg command
    const shotFrames = await extractFramesFromShots(videoBuffer, shots);

    // Process shots in batches to avoid rate limits
    const shotProcessor = async (shot, index) => {
      console.log(`🎬 Analyzing shot ${index + 1}/${shots.length} (${shot.startTime}s - ${shot.endTime}s)`);
      const frames = shotFrames.get(`${shot.startTime}-${shot.endTime}`) || [];
      const description = await analyzeShot(frames);
      return {
        startTime: shot.startTime,
        endTime: shot.endTime,
        description
      };
    };

    // Process shots in small batches with delays
    const shotAnalyses = await processBatchWithRateLimit(
      shots,
      shotProcessor,
      1, // Process 1 shot at a time to be conservative
      2000 // 2 second delay between shots
    );

    return shotAnalyses;
  } catch (error) {
    console.error('Error in shots analysis:', error);
    throw new Error('Failed to analyze shots');
  }
}

/**
 * Analyzes shot descriptions to determine main topic and shot relevance
 * @param {Array} shots - Array of shot objects with descriptions
 * @returns {Promise<Object>} Analysis results with main topic and shot relevance
 */
async function analyzeShotRelevance(shots, decription) {
  try {
    // First, get the main topic from all shot descriptions
    const shotDescriptions = shots.map(shot => shot.description).join('\n');
    
    const mainTopicCompletion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: "You are a video content analyzer. Your task is to determine the main topic or theme of a video based on its description and shots descriptions. Always respond in the exact format specified in the prompt."
          },
          {
            role: "user",
            content: `${decription ? `Here is the description of the video content:\n${decription}\n\n` : ''}Based on the ${decription ? 'above description and the ' : ''}following visual descriptions from different shots in a video, what is the main topic or theme being discussed or shown? Please provide a concise summary.

Shot Descriptions:
${shotDescriptions}

Please provide your response in the following exact format:

Main Topic: [${decription ? 'Extract main topic primarily from the description, supported by visual evidence from shots' : 'Extract main topic from visual descriptions'}]
Summary: [${decription ? 'Combine the description context with visual evidence to create a comprehensive news article' : 'Comprehensive news article based on visual descriptions'}]
Language: [Detected language or 'Unknown' if not detectable]
News Category: [If it is news, specify the category: politics/human rights/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)]

Note: Please maintain this exact format with the labels "Main Topic:", "Summary:", "Language:", and "News Category:" followed by your response.`
          }
        ],
        max_tokens: 300
      })
    );

    const mainTopicResponse = mainTopicCompletion.choices[0].message.content.trim();
    
    // Extract main topic, summary, language, and news status from the response
    const mainTopicMatch = mainTopicResponse.match(/Main Topic:\s*([^\n]+)/);
    const summaryMatch = mainTopicResponse.match(/Summary:\s*([^\n]+)/);
    const languageMatch = mainTopicResponse.match(/Language:\s*([^\n]+)/);
    const newsCategoryMatch = mainTopicResponse.match(/News Category:\s*([^\n]+)/);

    const mainTopic = mainTopicMatch ? mainTopicMatch[1].trim() : '';
    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    const detectedLanguage = languageMatch ? languageMatch[1].trim() : 'Unknown';
    const newsCategory = newsCategoryMatch ? newsCategoryMatch[1].trim() : '';
    
    // Now analyze each shot's relevance to the main topic using batch processing
    const relevanceProcessor = async (shot, index) => {
      console.log(`🔍 Analyzing relevance for shot ${index + 1}/${shots.length}`);
      
      const relevanceCompletion = await callWithRetry(() =>
        openai.chat.completions.create({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a video content analyzer. Your task is to determine can the shot description be relevant or related to the main topic and summary of the video or the previous relevant shots."
            },
            {
              role: "user",
              content: `Main Topic: ${mainTopic} , Summary: ${summary} , Description: ${decription}

Shot Description: ${shot.description}

Please analyze how relevant this shot is to the main topic. Provide:
1. Relevance Score (0-100): How relevant and important is this shot to the main topic or summary of the video?
3. Is Relevant (true/false): Based on the score, is this shot relevant enough to keep?`
            }
          ],
          max_tokens: 150
        })
      );

      const analysis = relevanceCompletion.choices[0].message.content.trim();
      
      // Parse the analysis to extract structured data
      const scoreMatch = analysis.match(/Relevance Score:\s*(\d+)/);
      const isRelevantMatch = analysis.match(/Is Relevant:\s*(true|false)/i);

      return {
        startTime: shot.startTime,
        endTime: shot.endTime,
        description: shot.description,
        relevanceScore: scoreMatch ? parseInt(scoreMatch[1]) : 0,
        isRelevant: isRelevantMatch ? isRelevantMatch[1].toLowerCase() === 'true' : false
      };
    };

    // Process shot relevance analysis in batches
    const relevanceAnalysis = await processBatchWithRateLimit(
      shots,
      relevanceProcessor,
      2, // Process 2 shots at a time
      2500 // 2.5 second delay between batches
    );

    return {
      mainTopic,
      summary,
      detectedLanguage,
      newsCategory,
      shots: relevanceAnalysis
    };
  } catch (error) {
    console.error('Error in shot relevance analysis:', error);
    throw new Error('Failed to analyze shot relevance');
  }
}

/**
 * Separates relevant shots and merges them if they are close in time
 * @param {Array} shots - Array of shot objects with relevance information
 * @returns {Object} Object containing merged relevant shots and irrelevant shots
 */
function separateAndMergeRelevantShots(selectShots,allShots) {
  if (!allShots || allShots.length === 0) {
    return {
      relevantShots: [],
      irrelevantShots: []
    };
  }

  // Separate relevant and irrelevant shots
  //const relevantShots = allShots.filter(shot => shot.isRelevant);
  const relevantShots = selectShots;
  const irrelevantShots = allShots.filter(shot => !shot.isRelevant);

  // Convert relevant shots to transcript-like format for merging
  const shotsForMerging = relevantShots.map(shot => ({
    startTime: shot.startTime,
    endTime: shot.endTime,
    description: shot.description,
    relevanceScore: shot.relevanceScore
  }));

  // Merge close shots
  //console.log('Select Shots:',selectShots);
    const mergedGroups = mergeCloseTranscripts(selectShots);

  // Convert merged groups back to shot format
  const mergedRelevantShots = mergedGroups.map(group => {
    // Find the shot with highest relevance score in the group
    const bestShot = group.reduce((best, current) => 
      current.relevanceScore > best.relevanceScore ? current : best
    );

    return {
      startTime: group[0].startTime,
      endTime: group[group.length - 1].endTime,
      description: bestShot.description,
      relevanceScore: bestShot.relevanceScore,
      isRelevant: true,
      mergedShots: group.length
    };
  });

  return {
    relevantShots: mergedRelevantShots,
    irrelevantShots: irrelevantShots
  };
}

/**
 * Selects the most relevant shots (up to 30s total) using OpenAI
 * @param {Array} shots - Array of shot objects: {startTime, endTime, description, relevanceScore}
 * @returns {Promise<Array>} - Array of selected shots
 */
async function selectMostRelevantShotsWithin30s(shots) {
  try {
    // Filter only relevant shots
    const relevantInputShots = shots.filter(shot => shot.isRelevant);
    console.log('Relevant Input Shots:',relevantInputShots);
    if (relevantInputShots.length === 0) {
      return [];
    }
    // Prepare a summary of all relevant shots for the prompt
    const shotList = relevantInputShots.map((shot, idx) => {
      const duration = (shot.endTime - shot.startTime).toFixed(2);
      return `Shot ${idx + 1}: [${shot.startTime}s - ${shot.endTime}s]\nDescription: ${shot.description}\nRelevance Score: ${shot.relevanceScore}`;
    }).join('\n\n');

    const prompt = `
You are a video editor. You are given a list of video shots, each with a start time, end time, duration, description, and relevance score (0-100). Your task is to select the combination of shots that are the most relevant (highest total relevance score), but the total duration of all selected shots must be near 30 seconds. Prefer shots with higher relevance scores and more informative descriptions. Return the selected shots as a list of their indices (starting from 1), in the order they should appear.

Shots:
${shotList}

Please respond with a JSON array of the selected shot indices, in order. Example: [2, 4, 5]

Important: Before providing the array:
1. Calculate the total duration of your selected shots
2. Ensure it should be near 30 seconds
3. Prioritize shots with higher relevance scores
4. Try to maintain narrative coherence in the selection order
`;

    const completion = await callWithRetry(() =>
      openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          { role: "system", content: "You are a helpful assistant for video editing." },
          { role: "user", content: prompt }
        ],
        max_tokens: 100,
        temperature: 0.2
      })
    );

    // Parse the response
    const match = completion.choices[0].message.content.match(/\[.*\]/);
    console.log('Completion:',completion.choices[0].message.content);
    console.log('Match:',match);
    let selectedIndices = [];
    if (match) {
      try {
        selectedIndices = JSON.parse(match[0]);
      } catch (e) {
        console.error("Failed to parse OpenAI response:", completion.choices[0].message.content);
        return [];
      }
    }

    // Get the selected shots and verify total duration
    const selectedShots = selectedIndices.map(idx => relevantInputShots[idx - 1]).filter(Boolean);
    const totalDuration = selectedShots.reduce((sum, shot) => 
      sum + (shot.endTime - shot.startTime), 0
    );

    if (totalDuration > 32) {
      console.warn(`Selected shots exceed 30s (${totalDuration.toFixed(2)}s), adjusting selection...`);
      // If we exceed 30s, take shots until we hit the limit
      const adjustedShots = [];
      let currentDuration = 0;
      for (const shot of selectedShots) {
        const shotDuration = shot.endTime - shot.startTime;
        if (currentDuration + shotDuration <= 30) {
          adjustedShots.push(shot);
          currentDuration += shotDuration;
        } else {
          break;
        }
      }
      return adjustedShots;
    }

    if(totalDuration>60){
      const lastShot = selectedShots[selectedShots.length - 1];
      const excessDuration = totalDuration - 60;
      lastShot.endTime = lastShot.endTime - excessDuration;
      totalDuration = 60; // Recalculate totalDuration after modification
    }

    return selectedShots;
  } catch (error) {
    console.error('Error in selecting relevant shots:', error);
    throw new Error('Failed to select relevant shots');
  }
}

/**
 * Selects the most relevant shots (up to 30s total) using a greedy algorithm.
 * @param {Array} shots - Array of shot objects: {startTime, endTime, description, relevanceScore, isRelevant}
 * @returns {Array} - Array of selected shots
 */
function selectMostRelevantShotsWithin30sGreedy(shots) {
  // 1. Filter relevant shots based on either isRelevant or relevance_type
  const relevantShots = shots.filter(shot => {
    // If isRelevant field exists, use it
    if ('isRelevant' in shot) {
      return shot.isRelevant;
    }
    // Otherwise, use relevance_type
    return shot.relevance_type !== "irrelevant";
  });

  if (relevantShots.length === 0) {
    return { selectedShots: [], totalDuration: 0 };
  }

  // 2. Sort by relevanceScore descending
  relevantShots.sort((a, b) => b.relevanceScore - a.relevanceScore);

  // 3. Select shots until total duration >= 30s
  const selectedShots = [];
  selectedShots.push(relevantShots[0]);
  let totalDuration = relevantShots[0].endTime - relevantShots[0].startTime;
  for(const shot of relevantShots){
    if(shot===relevantShots[0]) continue;
    let shotDuration = shot.endTime - shot.startTime;
    if(totalDuration<25 && totalDuration+shotDuration>=35){
      const remainingDuration = 30 - totalDuration;
      shot.endTime = shot.startTime + remainingDuration;
      selectedShots.push(shot);
      shotDuration = shot.endTime - shot.startTime;
      totalDuration+=shotDuration;
    }
    if(totalDuration>=25) break;

    selectedShots.push(shot);
    shotDuration = shot.endTime - shot.startTime;
    totalDuration+=shotDuration;
  }
  if(totalDuration>60){
    const lastShot = selectedShots[selectedShots.length - 1];
    const excessDuration = totalDuration - 60;
    lastShot.endTime = lastShot.endTime - excessDuration;
    totalDuration = 60; // Recalculate totalDuration after modification
  }

  console.log('Selected Shots:',selectedShots);
  console.log('Total Duration:',totalDuration);

  return { selectedShots, totalDuration };
}



module.exports = {
  analyzeVideoLabels,
  analyzeShots,
  extractFramesFromShots,
  analyzeShotRelevance,
  separateAndMergeRelevantShots,
  selectMostRelevantShotsWithin30s,
  selectMostRelevantShotsWithin30sGreedy
}; 