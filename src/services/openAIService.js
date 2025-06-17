// npm install openai dotenv
const { OpenAI } = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
require('dotenv').config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Extracts frames from video buffer for a specific timestamp
 * @param {Buffer} videoBuffer - Video file buffer
 * @param {number} startTime - Start time in seconds
 * @param {number} endTime - End time in seconds
 * @param {number} frameRate - Number of frames to extract per second
 * @returns {Promise<Array>} Array of frame buffers
 */
async function extractFramesForTimestamp(videoBuffer, startTime, endTime, frameRate = 1) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const tempDir = '/tmp';
    
    const outputPattern = path.join(tempDir, `frame_${startTime}_%d.jpg`);

    // Create a temporary file to store the video buffer
    const tempVideoPath = path.join(tempDir, `temp_video_${Date.now()}.mp4`);
    fs.writeFileSync(tempVideoPath, videoBuffer);

    ffmpeg(tempVideoPath)
      .setStartTime(startTime)
      .setDuration(endTime - startTime)
      .fps(frameRate)
      .on('end', async () => {
        try {
          // Read all frames from temp directory
          const files = fs.readdirSync(tempDir)
            .filter(file => file.startsWith(`frame_${startTime}_`))
            .sort((a, b) => {
              const numA = parseInt(a.split('_').pop());
              const numB = parseInt(b.split('_').pop());
              return numA - numB;
            });

          // Read each frame file
          for (const file of files) {
            const framePath = path.join(tempDir, file);
            const frameBuffer = fs.readFileSync(framePath);
            frames.push(frameBuffer);
            // Clean up the file
            fs.unlinkSync(framePath);
          }

          // Clean up the temporary video file
          fs.unlinkSync(tempVideoPath);

          resolve(frames);
        } catch (error) {
          // Clean up the temporary video file in case of error
          if (fs.existsSync(tempVideoPath)) {
            fs.unlinkSync(tempVideoPath);
          }
          reject(error);
        }
      })
      .on('error', (err) => {
        // Clean up the temporary video file in case of error
        if (fs.existsSync(tempVideoPath)) {
          fs.unlinkSync(tempVideoPath);
        }
        reject(err);
      })
      .save(outputPattern);
  });
}

/**
 * Analyzes transcript and visual metadata using OpenAI
 * @param {Object} data - Includes transcript, labels, shots
 * @returns {Promise<Object>} Analysis result
 */

//Not using this one.
async function analyzeWithOpenAI(data) {
  const { speechTranscripts, labels, shots } = data;

  const combinedTranscript = speechTranscripts
    .map(t => t.transcript)
    .filter(Boolean)
    .join(' ');

  const labelDescriptions = labels.map(label => {
    return `Label: ${label.description}, Timestamps: ${label.segments.map(s => `${s.startTime}s-${s.endTime}s`).join(', ')}`;
  }).join('\n');

  const shotTimestamps = shots.map(s => `${s.startTime}s - ${s.endTime}s`).join(', ');

  const prompt = `
You are an expert multimedia content analyst.

Here is a video transcript:
"${combinedTranscript}"

Visual labels with timestamps:
${labelDescriptions}

Shot timestamps (scene changes):
${shotTimestamps}

Based on the above data, answer these questions:

1. Is this video news-related? (yes or no)
2. What is the general news category? Choose from: politics, sports, entertainment, social, natural disaster, economy, environment, other
3. Provide a 2-3 line summary of the news.
4. Provide the timestamp(s) of the segment where the main news is discussed (e.g., ["12s-55s", "1:00-1:30"]).
5. Based on the transcript and scene changes, does the voice seem like a voiceover (narration only), or is the speaker likely visible in the video?

Return result as JSON with this format:

{
  "is_news_related": true,
  "news_category": "Politics",
  "summary": "The speaker discusses recent government reforms and opposition reactions.",
  "relevant_timestamps": ["10s-45s"],
  "voice_type": "voiceover" // or "speaker visible"
}
`;

  const response = await openai.createChatCompletion({
    model: "gpt-4",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4
  });

  const text = response.data.choices[0].message.content;

  try {
    const jsonStart = text.indexOf('{');
    return JSON.parse(text.slice(jsonStart));
  } catch (e) {
    console.error("Failed to parse OpenAI response:", text);
    throw new Error("Invalid JSON format from OpenAI");
  }
}

/**
 * Analyzes individual transcripts to determine if they are news-related and their category
 * @param {Array} transcripts - Array of transcript objects with timestamps
 * @returns {Promise<Array>} Array of analysis results for each transcript
 * Not using this one.
 */
async function analyzeTranscriptsIndividually(transcripts) {
  const results = [];

  for (const transcript of transcripts) {
    const prompt = `
You are an expert news content analyzer.

Here is a transcript segment:
"${transcript.transcript}"

Based on this transcript, answer these questions:

1. Is this a News? (yes or no)
2. What is the news category? Choose from: politics, sports, entertainment, social, natural disaster, economy, environment, war, crime, celebration, other

Return result as JSON with this format:
{
  "is_news": true/false,
  "category": "Politics",
  "timestamp": "${transcript.startTime}s-${transcript.endTime}s"
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4
    });

    const text = response.choices[0].message.content;

    try {
      const jsonStart = text.indexOf('{');
      const result = JSON.parse(text.slice(jsonStart));
      results.push({
        ...result,
        transcript: transcript.transcript,
        languageCode: transcript.languageCode
      });
    } catch (e) {
      console.error("Failed to parse OpenAI response for transcript:", text);
      results.push({
        is_news: false,
        category: "unknown",
        transcript: transcript.transcript,
        timestamp: `${transcript.startTime}s-${transcript.endTime}s`,
        error: "Failed to parse response"
      });
    }
  }

  return results;
}

/**
 * Analyzes the entire content to determine the main topic, news category, and relevance
 * @param {Array} transcripts - Array of transcript objects
 * @returns {Promise<Object>} Main topic and news analysis
 */
async function analyzeMainTopic(transcripts) {
  const combinedTranscript = transcripts.map(t => t.transcript).join(' ');
  
  const prompt = `
You are an expert content analyzer.

Your task is to analyze the transcript and provide insights about the video content. However, please keep in mind:
- The transcript may be very short, incomplete, or contain minimal/no useful information.
- If the transcript does not provide enough meaningful content to determine the topic, category, or news value, state that clearly in your response as "Transcript is too short to determine the main topic".

Here is the complete transcript of a video:
"${combinedTranscript}"

Analyze this content and provide:
1. The main topic or subject being discussed( if detectable )
2. Whether this is news content
3. If it is news, what general news category it belongs to for example: politics/human rights/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)
4. Is it AI generated or not?

Return result as JSON with this format:
{
  "main_topic": "Brief description of the main topic",
  "summary": "2-3 sentence summary of the content",
  "is_news": true/false,
  "category": "politics/human rights/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)",
  "is_ai_generated": true/false
  }
`;

  const response = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.4
  });

  const text = response.choices[0].message.content;
  
  try {
    const jsonStart = text.indexOf('{');
    return JSON.parse(text.slice(jsonStart));
  } catch (e) {
    console.error("Failed to parse OpenAI response for main topic:", text);
    return {
      main_topic: "Unknown topic",
      summary: "Failed to analyze main topic",
      is_news: false,
      category: "other"
    };
  }
}

/**
 * Analyzes a transcript segment and its corresponding image frames to determine if it's a voiceover or has a visible speaker
 * @param {Object} transcript - Transcript object with transcript and timestamps
 * @param {Array} frames - Array of image frames corresponding to the transcript timestamp
 * @returns {Promise<Object>} Voice type analysis
 */
async function analyzeVoiceTypeWithFrames(transcript, frames) {
  try {
    // Convert frames to base64 strings if they aren't already
    const frameDescriptions = frames.map(frame => {
      // If frame is a base64 string, use it directly
      if (typeof frame === 'string' && frame.startsWith('data:image')) {
        return frame;
      }
      // If frame is a buffer or other format, convert to base64
      return `data:image/jpeg;base64,${frame.toString('base64')}`;
    });

    const prompt = `
You are an expert content analyzer. Analyze this transcript segment to determine if it's a voiceover (narration) or if the speaker is visible in the video.

Transcript segment:
"${transcript.transcript}"

Timestamp: ${transcript.startTime}s - ${transcript.endTime}s

Consider these factors:
1. The language and style of speech (formal narration vs. conversational)
2. The content type (news reporting, documentary narration, interview, etc.)
3. The presence of first-person references or direct address
4. The tone and delivery style

Return result as JSON with this format:
{
  "voice_type": "voiceover" or "speaker_visible",
  "confidence": "high" or "medium" or "low",
  "explanation": "Brief explanation of why this is likely a voiceover or visible speaker"
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 300
    });

    const text = response.choices[0].message.content;
    
    try {
      const jsonStart = text.indexOf('{');
      const result = JSON.parse(text.slice(jsonStart));
      return result;
    } catch (e) {
      console.error("Failed to parse OpenAI response for voice type:", text);
      return {
        voice_type: "unknown",
        confidence: "low",
        explanation: "Failed to analyze voice type"
      };
    }
  } catch (error) {
    console.error("Error in analyzeVoiceTypeWithFrames:", error);
    return {
      voice_type: "unknown",
      confidence: "low",
      explanation: "Error processing analysis"
    };
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
    
    if (timeGap <= 8) {
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
 * Groups transcripts into relevant (main topic) and irrelevant content
 * @param {Array} transcripts - Array of transcript objects with transcript, language, startTime, endTime
 * @param {Buffer} videoBuffer - Video file buffer
 * @returns {Promise<Object>} Object containing relevant and irrelevant groups
 */
async function groupRelatedTranscripts(transcripts, videoBuffer,shots,mainTopic) {
  const relevantGroup = [];
  const irrelevantGroup = [];

  // First, analyze the entire content to understand the main topic and news category
  const mainTopicAnalysis = mainTopic;
  
  for (const transcript of transcripts) {
    const prompt = `
You are an expert content analyzer. Determine if this transcript segment is relevant to the main topic of the video.

Main topic of the video:
"${mainTopicAnalysis.main_topic}"

Transcript segment to analyze:
"${transcript.transcript}"

Determine if this segment:
1. Is directly related to the main topic
2. Provides relevant context or background information
3. Is part of the main discussion
4. Or if it's irrelevant content (like advertisements, unrelated segments, etc.)

Return result as JSON with this format:
{
  "is_relevant": true/false,
  "relevance_type": "main_topic" or "context" or "irrelevant",
  "explanation": "Brief explanation of why it is relevant or irrelevant"
}
`;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-nano",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4
    });

    const text = response.choices[0].message.content;
    
    try {
      const jsonStart = text.indexOf('{');
      const result = JSON.parse(text.slice(jsonStart));
      
      if (result.is_relevant) {
        try {
          // Extract frames for this transcript's timestamp
          const frames = await extractFramesForTimestamp(
            videoBuffer,
            parseFloat(transcript.startTime),
            parseFloat(transcript.endTime)
          );
          
          // Analyze voice type with frames
          const voiceAnalysis = await analyzeVoiceTypeWithFrames(transcript, frames);
          //console.log("voiceAnalysis:", voiceAnalysis);
          
          relevantGroup.push({
            ...transcript,
            relevance_type: result.relevance_type,
            relevance_explanation: result.explanation,
            visual_analysis: voiceAnalysis
          });
        } catch (error) {
          console.error(`Error processing frames for transcript at ${transcript.startTime}-${transcript.endTime}:`, error);
          relevantGroup.push({
            ...transcript,
            relevance_type: result.relevance_type,
            relevance_explanation: result.explanation,
            visual_analysis: {
              voice_type: "unknown",
              confidence: "low",
              explanation: "Error processing frames",
              visual_analysis: "Error processing visual content"
            }
          });
        }
      } else {
        irrelevantGroup.push({
          ...transcript,
          relevance_type: result.relevance_type,
          relevance_explanation: result.explanation
        });
      }
    } catch (e) {
      console.error("Failed to parse OpenAI response for transcript relevance:", text);
      relevantGroup.push({
        ...transcript,
        relevance_type: "unknown",
        relevance_explanation: "Error analyzing relevance"
      });
    }
  }

  // Merge close transcripts in relevant group
  const mergedGroups = mergeCloseTranscripts(relevantGroup);
 // const adjustedTranscripts = adjustTranscriptTimestampsWithShots(relevantGroup, shots);
  
  // Create merged and unmerged content sections
  const mergedContent = mergedGroups.map(group => ({
    transcripts: group,
    startTime: group[0].startTime,
    endTime: group[group.length - 1].endTime
  }));

  const unmergedContent = relevantGroup.filter(transcript => 
    !mergedGroups.some(group => group.includes(transcript))
  ).map(transcript => ({
    transcripts: [transcript],
    startTime: transcript.startTime,
    endTime: transcript.endTime
  }));

  return {
    main_topic: mainTopicAnalysis.main_topic,
    summary: mainTopicAnalysis.summary,
    is_news: mainTopicAnalysis.is_news,
    category: mainTopicAnalysis.category,
    is_ai_generated: mainTopicAnalysis.is_ai_generated,
    //adjusted_transcripts: adjustedTranscripts,
    relevant_content: {
       mergedContent,
      //unmerged_segments: unmergedContent
    },
    irrelevant_content: {
      transcripts: irrelevantGroup,
      startTime: irrelevantGroup[0]?.startTime || "0",
      endTime: irrelevantGroup[irrelevantGroup.length - 1]?.endTime || "0"
    }
  };
}

/**
 * Adjusts transcript timestamps to align with shot boundaries
 * @param {Array} transcripts - Array of transcript objects with startTime and endTime
 * @param {Array} shots - Array of shot objects with startTime and endTime
 * @returns {Array} Array of transcripts with adjusted timestamps
 */
function adjustTranscriptTimestampsWithShots(transcripts, shots) {
  return transcripts.map(transcript => {
    const transcriptStart = parseFloat(transcript.startTime);
    const transcriptEnd = parseFloat(transcript.endTime);
    
    // Find the shot that contains the transcript start time
    const startShot = shots.find(shot => 
      parseFloat(shot.startTime) <= transcriptStart && 
      parseFloat(shot.endTime) >= transcriptStart
    );
    
    // Find the shot that contains the transcript end time
    const endShot = shots.find(shot => 
      parseFloat(shot.startTime) <= transcriptEnd && 
      parseFloat(shot.endTime) >= transcriptEnd
    );
    
    // Create a new transcript object with adjusted timestamps
    return {
      ...transcript,
      startTime: startShot ? startShot.startTime.toString() : transcript.startTime,
      endTime: endShot ? endShot.endTime.toString() : transcript.endTime
    };
  });
}

module.exports = {
  analyzeMainTopic,
  analyzeWithOpenAI,
  analyzeTranscriptsIndividually,
  groupRelatedTranscripts,
  adjustTranscriptTimestampsWithShots,
  mergeCloseTranscripts
};
