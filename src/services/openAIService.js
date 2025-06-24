
const { OpenAI } = require('openai');
require('dotenv').config();

const {selectMostRelevantShotsWithin30sGreedy} = require('./visualAnalysisService');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});


/**
 * Analyzes the entire content to determine the main topic, news category, and relevance
 * @param {Array} transcripts - Array of transcript objects
 * @returns {Promise<Object>} Main topic and news analysis
 */
async function analyzeMainTopic(transcripts,description) {
  const combinedTranscript = transcripts.map(t => t.transcript).join(' ');
  
  const prompt = `
You are an expert content analyzer.

Your task is to analyze the transcript and provide insights about the video content. However, please keep in mind:
- The transcript may be very short(like few random words), incomplete, or contain minimal/no useful information.
- IMPORTANT: The "is_sufficient" field should be determined ONLY by the given transcript,${description ? `NOT by the description` : ""}. A transcript is considered insufficient if it contains few words, and lacks meaningful information.

Here is the complete transcript of a video:
"${combinedTranscript}"

${description ? `Here is the description about the video:
"${description}"` : ""}

Analyze this content and provide:
1. The main topic or subject being discussed( if detectable )
3. what general news category it belongs to for example: politics/human rights/technology/sports/entertainment/social/natural disaster/economy/environment/war/crime/celebration/(etc...)
4. Is it AI generated or not?
5. Is the transcript sufficient for analysis? (true if transcript contains meaningful information, coherent content; false if transcript is too short containing few random words, or lacks meaningful information)

Return result as JSON with this format:
{
  "main_topic": "Brief description of the main topic",
  "summary": "A short news article of 2-3 sentences",
  "category":"News category",
  "is_ai_generated": true/false,
  "is_sufficient": true/false
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
      category: "other",
      is_sufficient: false
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
      model: "gpt-3.5-turbo",
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
Analyze if this transcript segment is relevant and important to the main topic.

Main topic: "${mainTopicAnalysis.main_topic}"
Segment: "${transcript.transcript}"

Assess relevance and importance. Return JSON:
{
  "is_relevant": true/false,
  "relevanceScore": 0-100(how relevant and important is this segment to the main topic)
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
        relevantGroup.push({
          ...transcript,
          relevanceScore: result.relevanceScore,
        });
      } else {
        irrelevantGroup.push({
          ...transcript,
          relevanceScore: result.relevanceScore,
        });
      }
    } catch (e) {
      console.error("Failed to parse OpenAI response for transcript relevance:", text);
      relevantGroup.push({
        ...transcript,
        relevanceScore: 0
      });
    }
  }

  // Merge close transcripts in relevant group

  const {selectedShots,totalDuration}= selectMostRelevantShotsWithin30sGreedy(relevantGroup);
  
  const mergedGroups = mergeCloseTranscripts(selectedShots);
  
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
    category: mainTopicAnalysis.category,
    is_ai_generated: mainTopicAnalysis.is_ai_generated,
    relevant_content: {
       mergedContent,

    },
    irrelevant_content: {
      transcripts: irrelevantGroup,
      startTime: irrelevantGroup[0]?.startTime || "0",
      endTime: irrelevantGroup[irrelevantGroup.length - 1]?.endTime || "0"
    },
    totalDuration
  };
}



module.exports = {
  analyzeMainTopic,
  groupRelatedTranscripts,
  mergeCloseTranscripts
};
