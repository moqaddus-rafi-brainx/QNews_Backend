const { TwelveLabs } = require("twelvelabs-js");
const OpenAI = require('openai');
const axios = require('axios');
require('dotenv').config();

// Import the parseOpenAIResponse function
const { parseOpenAIResponse } = require('./openAIService');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// 1. Initialize the client
const client = new TwelveLabs({ apiKey: process.env.TWELVELABS_API_KEY });

// Function to create an index and return the ID
const createIndex = async () => {

    const models = [
        {
        name: "pegasus1.2",
        options: ["visual", "audio"],
        },
        {
            name: "marengo2.7",
            options: ["visual", "audio"], // speech and transcripts
        }
    ];
    const index = await client.index.create({
        name: "video-index-2",
        models: models,
    });
    console.log(
        `A new index has been created: id=${index.id} name=${index.name} models=${JSON.stringify(index.models)}`,
    );
    return index.id;
};

    async function getSpeechSegments(videoId) {
    const response = await axios.post(
      `https://api.twelvelabs.io/v1/search/video/${videoId}`,
      {
        query: '*',
        filters: {
          modality: ['speech'],
        },
        model: "marengo2.7",
      },
      {
        headers: {
          'x-api-key': process.env.TWELVELABS_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );
  
    return response.data.results.map(item => ({
      text: item.text,
      start: item.start,
      end: item.end,
    }));
  }

// 3. Upload a video
const uploadVideoToTwelveLabs = async (fileBufferOrUrl) => {
    // Check if INDEX_ID is set, if not create an index
    let indexId = process.env.INDEX_ID;
    if (!indexId) {
        console.log('INDEX_ID not found in environment variables. Creating a new index...');
        indexId = await createIndex();
        console.log(`Please add INDEX_ID=${indexId} to your .env file for future use.`);
    }
    
    const task = await client.task.create({
        indexId: indexId,
        url: fileBufferOrUrl,
    });
    console.log(`Task id=${task.id} Video id=${task.videoId}`);
    // 4. Monitor the indexing process
    await task.waitForDone(500, (task) => {
        console.log(`  Status=${task.status}`);
    });
    if (task.status !== "ready") {
        throw new Error(`Indexing failed with status ${task.status}`);
    }
    console.log(`The unique identifier of your video is ${task.videoId}`);
    return task.videoId;
}

const getVideoDetails = async (videoId, description) => {
    const summary = await client.summarize(videoId, "summary", `Summarize this video into 4-5 lines of news article, ${description ? " keeping in mind the description of the video: " + description : ""}`);
    const result = await client.analyze(
        videoId,
        `For this video, provide the following information in Json format:
        -Main topic of the video(1 line).
        -Language being spoken in the video e.g. for English give "en-US", for hindi give "hi-IN", etc.
        -News category of the video.

        Providing description of the video for context: ${description}

        
        Important:ALWAYS Return the result in the EXACT JSON format:
         {
         mainTopic: "text",
         language: "en-US" or "Unknown",
         category: "text"
         }
`,
        0.4,
    );
    
    // Define fallback structure
    const fallbackStructure = {
        mainTopic: "Unknown topic",
        language: "Unknown",
        category: "other"
    };
    
    // Parse the result.data safely
    let parsedDetails = fallbackStructure;
    
    if (result.data) {
        try {
            parsedDetails = parseOpenAIResponse(result.data, fallbackStructure);
        } catch (parseError) {
            console.error('Error parsing video details JSON:', parseError);
            console.error('Raw details data:', result.data);
            // Keep default values
        }
    }
    
    return { details: parsedDetails, summary: summary.summary };
}

const getVideoHighlights = async (videoId,description) => {
    const highlights = await client.summarize(videoId, "highlight", `In context of this description: ${description}, extract all highlights from this video that contain most important visual information.
        IMPORTANT: Skip or remove irrelevant visual scenes from highlights time stamps like credits, logos(EFE logo), etc.
        NOTE: Each highlight should be atleast 5 seconds long and at most 15-20 seconds long.
        NOTE: Duration of all higlights should add up to AT LEAST 25 seconds.
        `);
    
for (const highlight of highlights.highlights) {
    console.log(
    `Highlight: ${highlight.highlight}, start: ${highlight.start}, end: ${highlight.end}`,
    );
}

return {
    highlights: highlights.highlights
}
}

const getVideoTranscript2 = async (videoId, description) => {
    const result = await client.analyze(
        videoId,
        `For this video, provide the following information in Json format: 
        1.The transcript segments of the video with punctuation marks and timestamps for each segment in seconds ONLY IF the whole transcript gives meaningful information about the video content, otherwise return empty array [].
        2.Importance score (1-100) (How important this segment is to be kept in the summarized version of the video).
        3.Does the video contain a visible speaker or is it a voiceover? Respond with true if a person is visibly speaking (i.e., their lip movements match the audio), otherwise respond with false.
        4.Language code for the language of the video like "en-US" or "Unknown" if not detected.
        IMPORTANT: the language code MUST be in the same format.
        IMPORTANT:Return the result in EXACT JSON format:
         {
         transcripts:[{transcript: 'text', startTime: number in seconds, endTime: number in seconds}] or []
         }
        `,
        0.4,
    );
    
    console.log(`Result ID: ${result.id}`);
    console.log(`Generated text: ${result.data}`);
    if (result.usage !== undefined) {
        console.log(`Output tokens: ${result.usage.outputTokens}`)
    };

    // Define fallback structure
    const fallbackStructure = {
        transcripts: []
    };
    
    try {
        return parseOpenAIResponse(result.data, fallbackStructure);
    } catch (error) {
        console.error('Failed to parse AI response:', error.message);
        console.error('Raw response data:', result.data);
        return fallbackStructure;
    }
}

const getVideoTranscript = async (videoId, description) => {
    const result = await client.analyze(
        videoId,
        `For this video, provide the following information in Json format: 
        1.The transcript segments of the video with punctuation marks and timestamps for each segment in seconds ONLY IF the whole transcript gives meaningful information about the video content, otherwise return empty array [].
        NOTE:
          - Do NOT include segments that are too short (less than 5 words) or meaningless.
          - If no meaningful transcript exists, return empty array [].
        2.Importance score (1-100) (How important this segment is to be kept in the summarized version of the video).
        3.Does the video contain a visible speaker or is it a voiceover? Respond with true if a person is visibly speaking (i.e., their lip movements match the audio), otherwise respond with false.
        4.Language code for the language of the video like "en-US" or "Unknown" if not detected.
        5.English translation of each transcript segment.
        IMPORTANT: the language code MUST be in the same format.
        Return the result in EXACT JSON format:
         {
         is_speaker: true/false, 
         transcripts:[{transcript: 'text',
         english_translation: 'text', 
         startTime: number in seconds,
         endTime: number in seconds,
          importanceScore: number}
          ] or []
         language: "en-US" or "Unknown"
         }
`,
        0.4,
    );
    
    console.log(`Result ID: ${result.id}`);
    console.log(`Generated text: ${result.data}`);
    if (result.usage !== undefined) {
        console.log(`Output tokens: ${result.usage.outputTokens}`)
    };
    
    // Define fallback structure
    const fallbackStructure = {
        is_speaker: false,
        transcripts: [],
        language: "Unknown"
    };
    
    try {
        return parseOpenAIResponse(result.data, fallbackStructure);
    } catch (error) {
        console.error('Failed to parse AI response:', error.message);
        console.error('Raw response data:', result.data);
        return fallbackStructure;
    }
}

const getImportantTrancriptChunks = async (videoId,description) => {
    const result = await client.analyze(
        videoId,
        `For this video, provide the Important Transcript Chunks for summarizing video.
        In context of this description: ${description}, provide the important transcript chunks for summarizing video.
         NOTE: 
         The chunks should be complete sentences.
         IMPORTANT: Note the time when first word of the transcript chunk is spoken(startTime)
         IMPORTANT: Note the time when last word of the transcript chunk is spoken(endTime)
        
        Return the result in JSON format:
         {
         important_transcripts:[
         {
         transcript: 'text',
         english_translation: 'text', 
         startTime: number, 
         endTime: number
         }]
         }`,
        0.2,
      );
      console.log(`Result ID: ${result.id}`);
      console.log(`Generated text: ${result.data}`);
      if (result.usage !== undefined) {
          console.log(`Output tokens: ${result.usage.outputTokens}`)
      };
      
      // Parse the JSON string response to return actual object
      try {
          const parsedData = JSON.parse(result.data);
          return parsedData;
      } catch (error) {
          console.error('Error parsing JSON response:', error);
          console.error('Raw response data:', result.data);
          // Try to clean up common JSON issues
          try {
              const cleanedData = result.data
                  .replace(/\n/g, ' ')
                  .replace(/\r/g, '')
                  .replace(/(\d+)s/g, '$1') // Remove 's' suffix from numbers
                  .replace(/''/g, '"') // Replace double single quotes with double quotes
                  .replace(/'/g, '"') // Replace single quotes with double quotes
                  .replace(/\.\./g, '.') // Replace double dots with single dot
                  .replace(/\s+/g, ' ') // Normalize whitespace
                  .trim();
              const parsedData = JSON.parse(cleanedData);
              return parsedData;
          } catch (secondError) {
              console.error('Failed to parse even after cleaning:', secondError);
              return { error: 'Failed to parse JSON response', rawData: result.data };
          }
      }
}





const selectMostImportantHighlights = (highlights) => {
    // 1. Filter relevant shots based on either isRelevant or relevance_type
    const selectedHighlights = [];
  
    if (highlights.length === 0) {
      return { selectedHighlights: [], totalDuration: 0 };
    }

    selectedHighlights.push(highlights[0]);
    let totalDuration = highlights[0].end - highlights[0].start;

    for(const highlight of highlights){
      if(highlight===highlights[0]) continue;

      let highlightDuration = highlight.end - highlight.start;
      if(highlightDuration<=2) continue;
      
      if(totalDuration<25 && totalDuration+highlightDuration>=40 ){
        const remainingDuration = totalDuration+highlightDuration-40;
        highlight.end = highlight.end - remainingDuration;
        selectedHighlights.push(highlight);
        highlightDuration = highlight.end - highlight.start;
        totalDuration+=highlightDuration;   
      }
      if(totalDuration>=25) break;
  
      selectedHighlights.push(highlight);
      highlightDuration = highlight.end - highlight.start;
      totalDuration+=highlightDuration;
    }
  
    return { selectedHighlights, totalDuration };
  }
  
  const selectTranscriptsByImportance = (transcripts) => {
    if (!transcripts || transcripts.length === 0) {
        return { selectedTranscripts: [], totalDuration: 0 };
    }

    // Sort transcripts by importance score in descending order
    const sortedTranscripts = [...transcripts].sort((a, b) => {
        const scoreA = a.importanceScore || 0;
        const scoreB = b.importanceScore || 0;
        return scoreB - scoreA;
    });

    const selectedTranscripts = [];
    let totalDuration = 0;

    // Always add the first transcript (highest importance score)
    const firstTranscript = sortedTranscripts[0];
    const firstDuration = firstTranscript.endTime - firstTranscript.startTime;
    selectedTranscripts.push(firstTranscript);
    totalDuration += firstDuration;

    // Add remaining transcripts until total duration exceeds 30 seconds
    for (let i = 1; i < sortedTranscripts.length; i++) {
        const transcript = sortedTranscripts[i];
        const duration = transcript.endTime - transcript.startTime;
        
        // If adding this transcript would exceed 30 seconds, stop
        if (totalDuration<25 && totalDuration + duration < 50) {
            selectedTranscripts.push(transcript);
            totalDuration += duration;
            
        }
        if(totalDuration>=25) break;
        
        
    }

    return { selectedTranscripts, totalDuration };
};

async function generateVoiceOverForVideo(isTranscript,description,contentData,segmentsToKeep, duration,videoId) {
    let contentType = '';
    if(isTranscript){
      contentType = 'Transcript';
      
    }
    else{
      contentType = 'Summary';
    }
    const targetWordCount = Math.floor(duration * 2.5);
    const result = await client.analyze(
        videoId,
        `Analyzing the video, give a summarized voiceover script for the summarized version of this video that when converted to audio is no more than ${duration} seconds long.
        Focus mainly on the video description and transcript if its provided and do not include too much of scene descriptions.
        ${description?"Here is the description of the video: "+description:""}
        ${isTranscript?"Here is the transcript for the selected parts of the video: "+contentData:"Here are the selected highlights of the video: "+ contentData}
        Here are the segments that will make summarized version of the video: ${segmentsToKeep}
        IMPORTANT:The script must be almost ${targetWordCount} words with is the estimated word count for the script.
        NOTE: Respond ONLY with the script, do not include any other text or explanation.`,
        0.2,
    );

    return result.data;
  
    //const targetWordCount = Math.floor(duration * 2.3);
    
    
//     const prompt = `You are a professional transcript generator for voiceovers on summarized videos. Write a compelling, natural-sounding voiceover script summarizing the video content.
  
//   Video Description: ${description}
//   ${contentType}: ${contentData}
  
//   IMPORTANT: The script must be EXACTLY ${targetWordCount} words (give or take 5 words). Focus mainly on the Video Description and transcript if its provided and do not include scene descriptions if its visual description.
//   The total voiceover should be suitable for a video of about ${duration} seconds.
  
//   Respond ONLY with the script, do not include any other text or explanation.`;
  
//     const completion = await openai.chat.completions.create({
//       model: "gpt-4",
//       messages: [
//         { role: "system", content: "You are a helpful assistant for video voiceover generation." },
//         { role: "user", content: prompt }
//       ],
//       max_tokens: 350,
//       temperature: 0.7
//     });
    
//     return completion.choices[0].message.content.trim();
  }
  


module.exports = {
    uploadVideoToTwelveLabs,
    createIndex,
    getVideoHighlights,
    getVideoDetails,
    getVideoTranscript,
    getImportantTrancriptChunks,
    selectMostImportantHighlights,
    generateVoiceOverForVideo,
    getSpeechSegments,
    selectTranscriptsByImportance,
    getVideoTranscript2
}