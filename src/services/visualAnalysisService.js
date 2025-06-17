const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { mergeCloseTranscripts } = require('./openAIService');
require('dotenv').config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

    const completion = await openai.chat.completions.create({
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
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Error in visual analysis:', error);
    throw new Error('Failed to analyze video labels');
  }
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
      
      // Create filter complex string for all shots
      const filterComplex = shots.map((shot, index) => {
        const duration = shot.endTime - shot.startTime;
        const fps = 5 / duration; // Calculate fps to get exactly 5 frames
        return `[0:v]trim=start=${shot.startTime}:end=${shot.endTime},setpts=PTS-STARTPTS,fps=${fps}[v${index}]`;
      }).join(';');

      const command = ffmpeg(videoPath)
        .complexFilter(filterComplex)
        .outputOptions([
          '-y', // Force overwrite output files
          '-f image2', // Force image2 format
          '-vcodec mjpeg', // Use MJPEG codec
          '-q:v 2' // Set quality
        ]);

        // Safety check
if (shots.length === 0) {
    throw new Error("No shots provided for frame extraction.");
  }

  //console.log(`Extracting 5 frames for each of the ${shots.length} shots`);

  

      // Add output for each shot
      shots.forEach((shot, index) => {
        const outputPath = path.join(framesDir, `shot_${index}_frame_%d.jpg`);
        command.addOutput(outputPath)
          .addOutputOptions([`-map [v${index}]`]);
      });

      command
        .on('start', (commandLine) => {
          //console.log('Started FFmpeg with command:', commandLine);
        })
        .on('error', (err) => {
          console.error('Error during FFmpeg processing:', err);
          cleanup();
          reject(err);
        })
        .on('end', async () => {
          try {
            // Read all frame files
            const files = await fs.readdir(framesDir);
            
            // Group frames by shot
            for (let i = 0; i < shots.length; i++) {
              const shotFiles = files.filter(f => f.startsWith(`shot_${i}_frame_`));
              const frames = await Promise.all(
                shotFiles.map(async (file) => {
                  const framePath = path.join(framesDir, file);
                  const frameBuffer = await fs.readFile(framePath);
                  return frameBuffer.toString('base64');
                })
              );
              shotFrames.set(`${shots[i].startTime}-${shots[i].endTime}`, frames);
            }

            // Cleanup
            await cleanup();
            resolve(shotFrames);
          } catch (error) {
            await cleanup();
            reject(error);
          }
        })
        .run();

      async function cleanup() {
        try {
          // Remove video file
          await fs.unlink(videoPath).catch(() => {});
          
          // Remove frames directory and its contents
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
    
    // Use all frames for analysis
    const frameDescriptions = await Promise.all(frames.map(async (frame) => {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o", // Using the correct vision model
        messages: [
          {
            role: "system",
            content: "You are a video content analyzer. Your task is to describe what is shown in this frame from a video shot."
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Please describe what is shown in this frame. Focus on the main subjects, actions, and setting."
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${frame}`
                }
              }
            ]
          }
        ],
        max_tokens: 150
      });
      return completion.choices[0].message.content.trim();
    }));

    // Combine all frame descriptions into a comprehensive shot description
    const combinedCompletion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a video content analyzer. Your task is to create a comprehensive description of a video shot based on multiple frame descriptions."
        },
        {
          role: "user",
          content: `Based on the following descriptions of 5 frames from the same shot, create a comprehensive description of what is shown in this shot:

${frameDescriptions.join('\n\n')}

Please provide a single, coherent description that captures the main content and any changes or movements shown across these frames.`
        }
      ],
      max_tokens: 200
    });

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

    // Analyze each shot
    const shotAnalyses = await Promise.all(
      shots.map(async (shot) => {
        const frames = shotFrames.get(`${shot.startTime}-${shot.endTime}`) || [];
        const description = await analyzeShot(frames);
        return {
          startTime: shot.startTime,
          endTime: shot.endTime,
          description
        };
      })
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
    
    const mainTopicCompletion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
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
Summary: [${decription ? 'Combine the description context with visual evidence to create a comprehensive summary' : 'Summary based on visual descriptions'}]
Language: [Detected language or 'Unknown' if not detectable]
Is News Video: [true/false] - ${decription ? 'Based on the description and visual evidence, determine if this is a news event.' : 'Determine if the described visuals could potentially belong to a news-related video, even if there is no audio, captions, or clear news formatting.'} Consider events such as protest, war, disasters, political activities, emergencies, social events, public speeches, broadcast etc.
News Category: [If it is news, specify the category: politics/human rights/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)]

Note: Please maintain this exact format with the labels "Main Topic:", "Summary:", "Language:", "Is News Video:", and "News Category:" followed by your response. For "Is News Video:", respond with only "true" or "false".`
        }
      ],
      max_tokens: 300
    });

    const mainTopicResponse = mainTopicCompletion.choices[0].message.content.trim();
    
    // Extract main topic, summary, language, and news status from the response
    const mainTopicMatch = mainTopicResponse.match(/Main Topic:\s*([^\n]+)/);
    const summaryMatch = mainTopicResponse.match(/Summary:\s*([^\n]+)/);
    const languageMatch = mainTopicResponse.match(/Language:\s*([^\n]+)/);
    const isNewsMatch = mainTopicResponse.match(/Is News Video:\s*(true|false)/i);
    const newsCategoryMatch = mainTopicResponse.match(/News Category:\s*([^\n]+)/);

    const mainTopic = mainTopicMatch ? mainTopicMatch[1].trim() : '';
    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    const detectedLanguage = languageMatch ? languageMatch[1].trim() : 'Unknown';
    const isNewsVideo = isNewsMatch ? isNewsMatch[1].toLowerCase() === 'true' : false;
    const newsCategory = newsCategoryMatch ? newsCategoryMatch[1].trim() : '';
    // Now analyze each shot's relevance to the main topic
    const relevanceAnalysis = await Promise.all(
      shots.map(async (shot) => {
        const relevanceCompletion = await openai.chat.completions.create({
          model: "gpt-3.5-turbo",
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
1. Relevance Score (0-100): How closely related is this shot to the main topic or summary of the video?
2. Relevance Explanation: Brief explanation of why this shot is or isn't relevant
3. Is Relevant (true/false): Based on the score, is this shot relevant enough to keep?`
            }
          ],
          max_tokens: 150
        });

        const analysis = relevanceCompletion.choices[0].message.content.trim();
        
        // Parse the analysis to extract structured data
        const scoreMatch = analysis.match(/Relevance Score:\s*(\d+)/);
        const explanationMatch = analysis.match(/Relevance Explanation:\s*([^\n]+)/);
        const isRelevantMatch = analysis.match(/Is Relevant:\s*(true|false)/i);

        return {
          startTime: shot.startTime,
          endTime: shot.endTime,
          description: shot.description,
          relevanceScore: scoreMatch ? parseInt(scoreMatch[1]) : 0,
          relevanceExplanation: explanationMatch ? explanationMatch[1].trim() : '',
          isRelevant: isRelevantMatch ? isRelevantMatch[1].toLowerCase() === 'true' : false
        };
      })
    );

    return {
      mainTopic,
      summary,
      detectedLanguage,
      isNewsVideo,
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
function separateAndMergeRelevantShots(shots) {
  if (!shots || shots.length === 0) {
    return {
      relevantShots: [],
      irrelevantShots: []
    };
  }

  // Separate relevant and irrelevant shots
  const relevantShots = shots.filter(shot => shot.isRelevant);
  const irrelevantShots = shots.filter(shot => !shot.isRelevant);

  // Convert relevant shots to transcript-like format for merging
  const shotsForMerging = relevantShots.map(shot => ({
    startTime: shot.startTime,
    endTime: shot.endTime,
    description: shot.description,
    relevanceScore: shot.relevanceScore,
    relevanceExplanation: shot.relevanceExplanation
  }));

  // Merge close shots
  const mergedGroups = mergeCloseTranscripts(shotsForMerging);

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
      relevanceExplanation: bestShot.relevanceExplanation,
      isRelevant: true,
      mergedShots: group.length
    };
  });

  return {
    relevantShots: mergedRelevantShots,
    irrelevantShots: irrelevantShots
  };
}



module.exports = {
  analyzeVideoLabels,
  analyzeShots,
  extractFramesFromShots,
  analyzeShotRelevance,
  separateAndMergeRelevantShots
}; 