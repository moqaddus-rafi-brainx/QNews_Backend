const path = require('path');
const multer = require('multer');
const { LANGUAGE_NAMES } = require('../constants/languages');
const { extractAudioAndAnalyze, getTranscriptTimestamps,getVideoDuration } = require('../services/audioAnalysisService');
const { groupRelatedTranscripts,analyzeMainTopic,createHighlightChunksByDuration,mergeCloseTranscripts,createSubtitleChunks,applyPunctuationToTranscripts,divideTranscriptsIntoSentencesWithAI,analyzeSentenceImportance,extractLastWordTimestamps,analyzeSentencesForNewsWorthiness,createMeaningfulChunks } = require('../services/openAIService');
const { analyzeVideoLabels, analyzeShots ,analyzeShotRelevance,separateAndMergeRelevantShots,selectMostRelevantShotsWithin30sGreedy} = require('../services/visualAnalysisService');
const { uploadVideoToCloudinary } = require('../services/cloudinaryUpload');
const { removeClipFromVideo,overlayAudioOnVideo,applySubtitlesWithShotstack } = require('../services/videoTrimmingService');
const { annotateVideoWithGoogle, processVideoAnnotation } = require('../services/googleService');
const { generateVoiceOver, convertTextToSpeech } = require('../services/voiceOverGenerationService');
const { processVideoWithSubtitles, generateSRTFromTranscripts,generateSRTFromChunks,processVideoWithChunkedSubtitles } = require('../services/subtitleGenerationService');
const { uploadVideoToTwelveLabs } = require('../services/twelveLabsService');
const { getVideoHighlights,getVideoDetails, getVideoTranscript,getVideoTranscript2, getImportantTrancriptChunks,selectMostImportantHighlights,generateVoiceOverForVideo,getSpeechSegments,createIndex,selectTranscriptsByImportance,getVideoHighlights2 } = require('../services/twelveLabsService');

const { generateReadSignedUrl } = require('../services/googleStorageService');

require('dotenv').config();

// Configure multer for in-memory storage
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

/**
 * Handles the complete video upload, analysis, and processing workflow
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
async function summarizeVideo(req, res) {
 
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const description = req.body.summary || null;
    const fileBuffer = req.file.buffer;

    // Step 1: Analyze audio first
    const audioAnalysis = await extractAudioAndAnalyze(fileBuffer);
    

    // Step 2: Process video annotation using the Google service
    const { speechTranscripts, labels, shots, operationResult } = await processVideoAnnotation(fileBuffer, audioAnalysis.detectedLanguage);

    // Step 3: Analyze main topic using transcripts
    const mainTopicUsingTranscripts = await analyzeMainTopic(speechTranscripts, description);

    let language = null;
    let mainTopic = null;
    let summary = null;
    let relevantContent = null;
    let irrelevantContent = null;
    let category = null;
    let audioDuration = null;
    let speakerPresent = false;
    // Step 4: Process based on transcript sufficiency
    if (mainTopicUsingTranscripts.main_topic === "Transcript is too short to determine the main topic" || mainTopicUsingTranscripts.is_sufficient === false) {
      
      // Analyze video labels using OpenAI
      const mainTopicUsingLabels = await analyzeVideoLabels(labels);
      
      // Analyze each shot using OpenAI Vision
      const shotAnalyses = await analyzeShots(fileBuffer, shots);
      const shotRelevance = await analyzeShotRelevance(shotAnalyses, description);
      const { selectedShots, totalDuration } = await selectMostRelevantShotsWithin30sGreedy(shotRelevance.shots);
      
      audioDuration = totalDuration;
      language = shotRelevance.detectedLanguage;
      mainTopic = shotRelevance.mainTopic;
      summary = shotRelevance.summary;
      category = shotRelevance.newsCategory;
      
      const mergedShots = separateAndMergeRelevantShots(selectedShots, shotRelevance.shots);
      relevantContent = mergedShots.relevantShots;
      irrelevantContent = mergedShots.irrelevantShots;
    } else {
      
      const transcriptTimestamps = speechTranscripts && speechTranscripts.length > 0 ? getTranscriptTimestamps(speechTranscripts) : [];
      const groupedTranscripts = await groupRelatedTranscripts(transcriptTimestamps,speechTranscripts, fileBuffer, shots, mainTopicUsingTranscripts);
    
      
      mainTopic = groupedTranscripts.main_topic;
      summary = groupedTranscripts.summary;
      category = groupedTranscripts.category;
      audioDuration = groupedTranscripts.totalDuration;
      language = LANGUAGE_NAMES[(speechTranscripts[0]?.languageCode || '').toLowerCase()] || 'Unknown';
      relevantContent = groupedTranscripts.relevant_content.mergedContent;
      irrelevantContent = groupedTranscripts.irrelevant_content;
      speakerPresent = groupedTranscripts.speaker_present;
    }

    // Step 5: Video processing and clipping
    const segmentsToKeep = [];

    // Add merged segments
    if (relevantContent) {
      relevantContent.forEach(segment => {
        segmentsToKeep.push({
          startTime: segment.startTime,
          endTime: segment.endTime
        });
      });
    }

    let clippedVideoUrl = "";
    let videoWithAudioUrl = "";

    // Only proceed with video clipping if there are segments to keep
    if (segmentsToKeep.length > 0) {
      // Get the total duration from the last shot or use a default
      const totalDuration = shots[shots.length - 1]?.endTime || 70;

      // Upload video to Cloudinary
      const videoUrl = await uploadVideoToCloudinary(fileBuffer);


      // Generate voice over and overlay it on the video
      if(!speakerPresent){
        // Call removeClipFromVideo with the segments
        const renderId = await removeClipFromVideo(videoUrl, segmentsToKeep, totalDuration);
        clippedVideoUrl = renderId.url;
        const voiceOver = await generateVoiceOver(summary, description,relevantContent, audioDuration);
        const {audioUrl, duration} = await convertTextToSpeech(voiceOver, language);
        const videoWithAudioId = await overlayAudioOnVideo(clippedVideoUrl, audioUrl, duration, audioDuration);
        videoWithAudioUrl = videoWithAudioId.url;
      }
      else{
        //Clipping first then add subtitles so that a smaller video is saved in /tmp for ffmpeg to apply subtitles. 
        // Call removeClipFromVideo with the segments
      const renderId = await removeClipFromVideo(videoUrl, segmentsToKeep, totalDuration);
      clippedVideoUrl = renderId.url;
      //using openai to get srt file content using transcript+timestamps
        
      const subtitleResult = await processVideoWithSubtitles(clippedVideoUrl,relevantContent);
      
      if (!subtitleResult.success) {
        throw new Error(`Failed to process video with subtitles: ${subtitleResult.error}`);
      }
      
      const { cloudinaryUrl } = subtitleResult;
      
      if (!cloudinaryUrl) {
        throw new Error('No cloudinary URL returned from subtitle processing');
      }

        videoWithAudioUrl = cloudinaryUrl;
     
      }
      
    }

    // Step 6: Return comprehensive results
    const results = {
      language,
      mainTopic,
      summary,
      category,
      relevantContent,
      irrelevantContent,
      audioDuration,
      shots,
      operationResult,
      clippedVideoUrl,
      videoWithAudioUrl,
      speakerPresent
    };

    res.json(results);

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}

async function summarizeVideo2(req, res) {
  try {
   
    const description = req.body.summary || null;
    const url=req.body.videoUrl;
    console.log(url);
  
    const videoId = await uploadVideoToTwelveLabs(url);
    console.log(videoId);
    const result = await getVideoTranscript(videoId,description);
    const transcripts=result.transcripts;
    const language=result.language;
    const {summary,details} = await getVideoDetails(videoId,description);
    console.log(summary);
    console.log(details);
    
    // Parse details if it's a string, or provide fallback values
    let parsedDetails = {
      mainTopic: "Unknown topic",
      language: "Unknown",
      category: "other"
    };
    
    if (details) {
      try {
        // If details is a string, try to parse it as JSON
        if (typeof details === 'string') {
          parsedDetails = JSON.parse(details);
        } else if (typeof details === 'object') {
          parsedDetails = details;
        }
      } catch (parseError) {
        console.error('Failed to parse details:', parseError);
        // Keep default values
      }
    }

    let videoDetails=null;
    let selectedHighlights=null;
    let clippedVideoUrl=null;
    let videoWithAudioUrl=null;
    let mergedGroups=null;
    let segmentsToKeep = [];
    
      //Speaker present,no need to apply voiceover
      if(result.is_speaker){
       
        
        for (const transcript of transcripts){
          transcript.endTime=transcript.endTime+1;
        }


         const selectedTranscripts=await selectTranscriptsByImportance(transcripts);
         console.log(selectedTranscripts);
         mergedGroups = mergeCloseTranscripts(selectedTranscripts.selectedTranscripts);
         
         // Convert mergedGroups to segmentsToKeep array
         for (const group of mergedGroups) {
           if (group && group.length > 0) {
             // Get the start time from the first transcript in the group
             const startTime = group[0].startTime;
             // Get the end time from the last transcript in the group
             const endTime = group[group.length - 1].endTime;
             
             segmentsToKeep.push({
               startTime: startTime,
               endTime: endTime
             });
           }
         }
         console.log('segmentsToKeep:', segmentsToKeep);
         
         // Validate segments before trimming
         if (segmentsToKeep.length === 0) {
           console.warn('No segments to keep, skipping video trimming');
           clippedVideoUrl = url; // Use original video
         } else {
           // Validate segment timing
           const totalDuration = Math.max(...segmentsToKeep.map(s => s.endTime));
           console.log('Total duration from segments:', totalDuration);
           console.log('Selected transcripts total duration:', selectedTranscripts.totalDuration);
           
           try {
             const renderId = await removeClipFromVideo(url, segmentsToKeep, selectedTranscripts.totalDuration);
             clippedVideoUrl = renderId.url;
             console.log('Video trimming successful:', clippedVideoUrl);
           } catch (trimError) {
             console.error('Video trimming failed, using original video:', trimError.message);
             clippedVideoUrl = url; // Fallback to original video
           }
         }
         
         const subtitleResult = await processVideoWithSubtitles(clippedVideoUrl,mergedGroups);
         
         if (!subtitleResult.success) {
          throw new Error(`Failed to process video with subtitles: ${subtitleResult.error}`);
        }
        
        const { cloudinaryUrl } = subtitleResult;
        videoWithAudioUrl=cloudinaryUrl;
      

      }
      else{

        videoDetails = await getVideoHighlights(videoId,description);
        console.log(videoDetails.highlights);
        const result = selectMostImportantHighlights(videoDetails.highlights);
        console.log(result);
        selectedHighlights = result.selectedHighlights;
       
        for(const highlight of selectedHighlights){
          segmentsToKeep.push({
            startTime: highlight.start,
            endTime: highlight.end
          });
        }
        console.log(segmentsToKeep);
        
        // Validate segments before trimming
        if (segmentsToKeep.length === 0) {
          console.warn('No segments to keep, skipping video trimming');
          clippedVideoUrl = url; // Use original video
        } else {
          // Validate segment timing
          const totalDuration = Math.max(...segmentsToKeep.map(s => s.endTime));
          console.log('Total duration from segments:', totalDuration);
          console.log('Selected highlights total duration:', result.totalDuration);
          
          try {
            const renderId = await removeClipFromVideo(url, segmentsToKeep, result.totalDuration);
            clippedVideoUrl = renderId.url;
            console.log('Video trimming successful:', clippedVideoUrl);
          } catch (trimError) {
            console.error('Video trimming failed, using original video:', trimError.message);
            clippedVideoUrl = url; // Fallback to original video
          }
        }
        
        let voiceOver=null;
        if(transcripts.length>0){
          const transcriptTexts = [];
      
      // Iterate through each item in the array
      transcripts.forEach(item => {
            if (item.transcript) {
              transcriptTexts.push(item.transcript);
            }
        })
        const contentDescription = transcriptTexts.join('\n');
        voiceOver = await generateVoiceOverForVideo(true, description,contentDescription,segmentsToKeep, result.totalDuration,videoId);
          
        }
        else{
          const highlightText = [];
      
      // Iterate through each item in the array
        selectedHighlights.forEach(item => {
              highlightText.push(item.highlightSummary);
        })
        const contentDescription = highlightText.join('\n');
          voiceOver = await generateVoiceOverForVideo(false, description,contentDescription,segmentsToKeep, result.totalDuration,videoId);
        }
          const {audioUrl,duration} = await convertTextToSpeech(voiceOver);
          const videoWithAudioId = await overlayAudioOnVideo(clippedVideoUrl, audioUrl,duration, result.totalDuration);
          videoWithAudioUrl = videoWithAudioId.url;

      }
    


   
   //const importantChunks = await getImportantTrancriptChunks("685e3ea9da8b16ab27aeb33b");
    res.json({
      language:parsedDetails.language=="Unknown"?language:parsedDetails.language,
      mainTopic:parsedDetails.mainTopic,
      category:parsedDetails.category,
      summary,
      originalVideoUrl: url,
      videoWithAudioUrl,
      segmentsToKeep,
      mergedGroups,
      selectedHighlights
    });

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}




async function summarizeVideo5(req, res) {
  try {
   
    const filePath = req.body.filePath;
    const description = req.body.summary || null;
    const gsUri=`gs://${process.env.GOOGLE_STORAGE_BUCKET}/${filePath}`;
    console.log(gsUri);
    // Generate signed URL for reading the video file
    const signedUrlResult = await generateReadSignedUrl(filePath, 60); // 60 minutes expiration
    
    if (!signedUrlResult.success) {
      return res.status(400).json({ 
        error: 'Failed to generate signed URL for video access',
        details: signedUrlResult.error 
      });
    }
    
    const url = signedUrlResult.signedUrl; // Use the signed URL for secure access
    console.log('Generated signed URL for video access:', url);
    console.log('Description:', description);
    
   //const videoId="6873f06b49df73a703b23659";
    const [videoDuration,videoId] = await Promise.all([
     
      getVideoDuration(url),
      uploadVideoToTwelveLabs(url)
    ]);
    console.log(videoId);
    const result = await getVideoTranscript(videoId, description);
    const otherDetails = await getVideoDetails(videoId, description);
    const transcripts = result.transcripts;
    const language = result.language;
    const {summary, details} = otherDetails;
    console.log(summary);
    console.log(details);
    
    // Parse details if it's a string, or provide fallback values
    let parsedDetails = {
      mainTopic: "Unknown topic",
      language: "Unknown",
      category: "other"
    };
    
    if (details) {
      try {
        // If details is a string, try to parse it as JSON
        if (typeof details === 'string') {
          parsedDetails = JSON.parse(details);
        } else if (typeof details === 'object') {
          parsedDetails = details;
        }
      } catch (parseError) {
        console.error('Failed to parse details:', parseError);
        // Keep default values
      }
    }

    let videoDetails=null;
    let selectedHighlights=null;
    let clippedVideoUrl=null;
    let videoWithAudioUrl=null;
    let mergedGroups=null;
    let segmentsToKeep = [];
    let sentences=null;
    let speechTranscripts=null;
    let subtitleChunks=null;
    let newsWorthiness=null;
    let importantSentences=[];
    let meaningfulChunks=null;
    let processedChunks = [];
    console.log(videoDuration);
    if(videoDuration>180){
      if(result.is_speaker){
        //Speaker present,no need to apply voiceover
        const { speechTranscripts: googleSpeechTranscripts, labels, shots, operationResult } = await processVideoAnnotation(gsUri,language);
      speechTranscripts = googleSpeechTranscripts;
      if (!speechTranscripts || speechTranscripts.length === 0) {
        console.warn('No speech transcripts found in video from Google API, trying to use TwelveLabs transcripts');
        
        // Try to use TwelveLabs transcripts as fallback
        if (transcripts && transcripts.length > 0) {
          console.log('Using TwelveLabs transcripts as fallback');
          speechTranscripts = transcripts;
        } else {
          console.warn('No speech transcripts found from either Google API or TwelveLabs');
          // Set default values and skip transcript processing
          sentences = [];
          mergedGroups = [];
          segmentsToKeep = [];
          clippedVideoUrl = url; // Use original video
          videoWithAudioUrl = url;
        }
      }
      if (speechTranscripts && speechTranscripts.length > 0) {
        const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
        const punctuatedTranscripts=await applyPunctuationToTranscripts(transcriptTimestamps);
        sentences=await divideTranscriptsIntoSentencesWithAI(punctuatedTranscripts,speechTranscripts);
        newsWorthiness=await analyzeSentencesForNewsWorthiness(sentences,description,parsedDetails.mainTopic,parsedDetails.category);
    
        // Filter to get only important sentences
        
        for (const sentence of newsWorthiness) {  
          if (sentence.isImportant === true) {
            importantSentences.push(sentence);
          }
        }
        console.log(`Found ${importantSentences.length} important sentences out of ${newsWorthiness.length} total sentences`);

        meaningfulChunks=await createMeaningfulChunks(importantSentences,description,parsedDetails.mainTopic,parsedDetails.category);
        
        meaningfulChunks.forEach(chunk => {
          if (chunk.sentences && chunk.sentences.length > 0) {
            chunk.sentences.sort((a, b) => parseFloat(a.startTime) - parseFloat(b.startTime));
            console.log(`Chunk ${chunk.chunkId}: Sorted ${chunk.sentences.length} sentences by start time`);
          }
        });
        //PROCESSING EACH CHUNK INTO AN INDEPENDENT CLIP.
        
        if (meaningfulChunks && meaningfulChunks.length > 0) {
          console.log(`Processing ${meaningfulChunks.length} meaningful chunks...`);
          
          // Process all chunks in parallel (including subtitle processing)
          const chunkProcessingPromises = meaningfulChunks.map(async (chunk, index) => {
            const i = index + 1;
            console.log(`Processing chunk ${i}/${meaningfulChunks.length}: ${chunk.summary}`);
            
            try {
              // Step 1: Merge close transcripts within the chunk
              const mergedChunkTranscripts = mergeCloseTranscripts(chunk.sentences);
              console.log(`Chunk ${i}: Merged into ${mergedChunkTranscripts.length} groups`);
              
              // Step 2: Convert merged groups to segments for video trimming
              const chunkSegments = [];
              for (const group of mergedChunkTranscripts) {
                if (group && group.length > 0) {
                  const startTime = group[0].startTime;
                  const endTime = group[group.length - 1].endTime;
                  
                  chunkSegments.push({
                    startTime: startTime,
                    endTime: endTime + 0.3
                  });
                }
              }
              
              console.log(`Chunk ${i}: Created ${chunkSegments.length} segments for trimming`);
              
              // Step 3: Video trimming
              let chunkClippedVideoUrl = url; // Default to original video
              if (chunkSegments.length > 0) {
                try {
                  const renderId = await removeClipFromVideo(url, chunkSegments, chunk.totalDuration);
                  chunkClippedVideoUrl = renderId.url;
                  console.log(`Chunk ${i}: Video trimming successful`);
                } catch (trimError) {
                  console.error(`Chunk ${i}: Video trimming failed, using original video:`, trimError.message);
                  chunkClippedVideoUrl = url;
                }
              } else {
                console.warn(`Chunk ${i}: No segments to keep, using original video`);
              }
              
              // Step 4: Create subtitle chunks
              const chunkSubtitleChunks = createSubtitleChunks(mergedChunkTranscripts);
              console.log(`Chunk ${i}: Created ${chunkSubtitleChunks.length} subtitle chunks`);
              
              // Step 5: Apply subtitles (now in parallel)
              let chunkFinalVideoUrl = chunkClippedVideoUrl; // Default to clipped video
              if (chunkSubtitleChunks.length > 0) {
                try {
                  const subtitleResult = await processVideoWithChunkedSubtitles(chunkClippedVideoUrl, chunkSubtitleChunks, chunk.chunkId);
                  
                  if (subtitleResult.success) {
                    chunkFinalVideoUrl = subtitleResult.cloudinaryUrl;
                    console.log(`Chunk ${i}: Subtitles applied successfully`);
                  } else {
                    console.error(`Chunk ${i}: Failed to apply subtitles:`, subtitleResult.error);
                  }
                } catch (subtitleError) {
                  console.error(`Chunk ${i}: Error applying subtitles:`, subtitleError.message);
                }
              } else {
                console.warn(`Chunk ${i}: No subtitle chunks to apply`);
              }
              
              // Return the processed chunk result
              return {
                chunkId: chunk.chunkId,
                summary: chunk.summary,
                totalDuration: chunk.totalDuration,
                startTime: chunk.startTime,
                endTime: chunk.endTime,
                transcript: chunk.transcript,
                sentences: chunk.sentences,
                sentencesCount: chunk.sentences.length,
                segmentsCount: chunkSegments.length,
                subtitleChunksCount: chunkSubtitleChunks.length,
                originalVideoUrl: url,
                clippedVideoUrl: chunkClippedVideoUrl,
                finalVideoUrl: chunkFinalVideoUrl,
                processingStatus: 'success'
              };
              
            } catch (chunkError) {
              console.error(`Chunk ${i}: Processing failed:`, chunkError);
              
              // Return failed chunk result
              return {
                chunkId: chunk.chunkId,
                summary: chunk.summary,
                totalDuration: chunk.totalDuration,
                startTime: chunk.startTime,
                endTime: chunk.endTime,
                transcript: chunk.transcript,
                sentences: chunk.sentences,
                sentencesCount: chunk.sentences.length,
                originalVideoUrl: url,
                finalVideoUrl: url, // Fallback to original video
                processingStatus: 'failed',
                error: chunkError.message
              };
            }
          });
          
          // Wait for all parallel processing to complete
          processedChunks = await Promise.all(chunkProcessingPromises);
          console.log(`Completed processing all ${processedChunks.length} chunks in parallel`);
        } else {
          console.warn('No meaningful chunks to process');
        }
        
      }
      res.json({
        language: parsedDetails.language == "Unknown" ? language : parsedDetails.language,
          mainTopic: parsedDetails.mainTopic,
          category: parsedDetails.category,
          summary,
          originalVideoUrl: url,
          processedChunks: processedChunks,
          totalChunks: processedChunks.length,
      });
      return;

      }
      else{
        //Speaker not present,apply voiceover
        videoDetails = await getVideoHighlights2(videoId,description);
        console.log(videoDetails.highlights);
        const highlightsChunks=createHighlightChunksByDuration(videoDetails.highlights);
        console.log(highlightsChunks);
        
        // Process each chunk for video trimming
        const processedChunks = [];
        
        for (let i = 0; i < highlightsChunks.length; i++) {
          const chunk = highlightsChunks[i];
          console.log(`Processing chunk ${i + 1}/${highlightsChunks.length}: ${chunk.summary}`);
          
          try {
            // Convert chunk highlights to segments for video trimming
            const chunkSegments = [];
            for (const highlight of chunk.highlights) {
              chunkSegments.push({
                startTime: parseFloat(highlight.start),
                endTime: parseFloat(highlight.end)
              });
            }

            // Deduplicate overlapping segments
            const uniqueSegments = [];
            const seenSegments = new Set();

            for (const segment of chunkSegments) {
              const segmentKey = `${segment.startTime}-${segment.endTime}`;
              if (!seenSegments.has(segmentKey)) {
                seenSegments.add(segmentKey);
                uniqueSegments.push(segment);
              }
            }

            console.log(`Chunk ${i + 1}: Created ${chunkSegments.length} segments, deduplicated to ${uniqueSegments.length} unique segments`);

            // Video trimming for this chunk
            let chunkClippedVideoUrl = url; // Default to original video
            if (uniqueSegments.length > 0) {
              console.log('Unique segments for trimming:', uniqueSegments);
              try {
                const renderId = await removeClipFromVideo(url, uniqueSegments, chunk.totalDuration);
                chunkClippedVideoUrl = renderId.url;
                console.log(`Chunk ${i + 1}: Video trimming successful - ${chunkClippedVideoUrl}`);
              } catch (trimError) {
                console.error(`Chunk ${i + 1}: Video trimming failed, using original video:`, trimError.message);
                chunkClippedVideoUrl = url;
              }
            } else {
              console.warn(`Chunk ${i + 1}: No segments to keep, using original video`);
            }
            
            // Store the processed chunk result
            processedChunks.push({
              chunkId: chunk.chunkId,
              summary: chunk.summary,
              totalDuration: chunk.totalDuration,
              startTime: chunk.startTime,
              endTime: chunk.endTime,
              highlightSummaries: chunk.highlightSummaries,
              highlightsCount: chunk.highlights.length,
              highlights: chunk.highlights,
              segmentsCount: uniqueSegments.length, // Use uniqueSegments count
              originalVideoUrl: url,
              clippedVideoUrl: chunkClippedVideoUrl,
              processingStatus: 'success'
            });
            
            console.log(`Chunk ${i + 1}: Processing completed successfully`);
            
          } catch (chunkError) {
            console.error(`Chunk ${i + 1}: Processing failed:`, chunkError);
            
            // Store failed chunk result
            processedChunks.push({
              chunkId: chunk.chunkId,
              summary: chunk.summary,
              totalDuration: chunk.totalDuration,
              startTime: chunk.startTime,
              endTime: chunk.endTime,
              highlightSummaries: chunk.highlightSummaries,
              highlightsCount: chunk.highlights.length,
              highlights: chunk.highlights,
              originalVideoUrl: url,
              clippedVideoUrl: url, // Fallback to original video
              processingStatus: 'failed',
              error: chunkError.message
            });
          }
        }
        
        console.log(`Completed video trimming for all ${processedChunks.length} chunks`);
        
        // Check if transcripts exist
        if (transcripts && transcripts.length > 0) {
          console.log('Transcripts found, processing voiceover for each chunk...');
          
          // Process voiceover for each chunk
          for (let i = 0; i < processedChunks.length; i++) {
            const chunk = processedChunks[i];
            
            if (chunk.processingStatus === 'failed') {
              console.log(`Skipping voiceover for chunk ${i + 1} due to previous failure`);
              continue;
            }
            
            try {
              console.log(`Processing voiceover for chunk ${i + 1}/${processedChunks.length}`);
              
              // Find transcripts that fall within this chunk's time range
              const chunkTranscripts = transcripts.filter(transcript => {
                const transcriptStart = parseFloat(transcript.startTime || transcript.start);
                const transcriptEnd = parseFloat(transcript.endTime || transcript.end);
                
                // Check if transcript overlaps with chunk time range
                return (transcriptStart >= chunk.startTime && transcriptStart <= chunk.endTime) ||
                       (transcriptEnd >= chunk.startTime && transcriptEnd <= chunk.endTime) ||
                       (transcriptStart <= chunk.startTime && transcriptEnd >= chunk.endTime);
              });
              
              console.log(`Chunk ${i + 1}: Found ${chunkTranscripts.length} transcripts within time range`);
              
              let voiceOverScript = null;
              
              if (chunkTranscripts.length > 0) {
                // Combine transcript texts
                const transcriptTexts = chunkTranscripts.map(t => t.transcript || t.highlightSummary).join('\n');
                
                // Generate voiceover script using description, selected transcripts, and chunk summary
                voiceOverScript = await generateVoiceOverForVideo(
                  true, // hasTranscripts
                  description,
                  transcriptTexts,
                  [], // segments (not needed for voiceover generation)
                  chunk.totalDuration,
                  videoId
                );
              } else {
                // No transcripts found, use chunk highlights for voiceover
                voiceOverScript = await generateVoiceOverForVideo(
                  false, // noTranscripts
                  description,
                  chunk.highlightSummaries,
                  [], // segments (not needed for voiceover generation)
                  chunk.totalDuration,
                  videoId
                );
              }
              
              // Apply voiceover to the clipped video for this chunk
              if (voiceOverScript) {
                const { audioUrl, duration } = await convertTextToSpeech(voiceOverScript);
                const videoWithAudioId = await overlayAudioOnVideo(
                  chunk.clippedVideoUrl, 
                  audioUrl, 
                  duration, 
                  chunk.totalDuration
                );
                
                // Update the chunk with final video URL
                chunk.finalVideoUrl = videoWithAudioId.url;
                chunk.processingStatus = 'completed';
                chunk.voiceoverApplied = true;
                chunk.transcriptsFound = chunkTranscripts.length;
                
                console.log(`Chunk ${i + 1}: Voiceover applied successfully`);
              } else {
                console.warn(`Chunk ${i + 1}: No voiceover script generated`);
                chunk.processingStatus = 'completed';
                chunk.voiceoverApplied = false;
                chunk.transcriptsFound = chunkTranscripts.length;
              }
              
            } catch (voiceoverError) {
              console.error(`Chunk ${i + 1}: Voiceover processing failed:`, voiceoverError);
              chunk.processingStatus = 'voiceover_failed';
              chunk.error = voiceoverError.message;
            }
          }
          
          console.log('Voiceover processing completed for all chunks');
        } else {
          console.log('No transcripts found, skipping voiceover processing');
        }
        
        return res.json({
          language: parsedDetails.language == "Unknown" ? language : parsedDetails.language,
          mainTopic: parsedDetails.mainTopic,
          category: parsedDetails.category,
          summary,
          originalVideoUrl: url,
          highlightChunks: highlightsChunks,
          processedChunks: processedChunks,
          totalChunks: highlightsChunks.length,
          hasTranscripts: transcripts && transcripts.length > 0
        });
        
      }
    }
      //Speaker present,no need to apply voiceover
      if(result.is_speaker){
        try{
          if(parsedDetails.language=="Unknown"){
            parsedDetails.language=language;
          }
          const { speechTranscripts: googleSpeechTranscripts, labels, shots, operationResult } = await processVideoAnnotation(gsUri,parsedDetails.language);
          speechTranscripts = googleSpeechTranscripts;
          
        }
        catch(error){
          console.error('Error in video transcipt fetching from google API:', error);
          res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
          return; // Exit early on error
        }
        
        // If no speech transcripts found, handle gracefully
        if (!speechTranscripts || speechTranscripts.length === 0) {
          console.warn('No speech transcripts found in video from Google API, trying to use TwelveLabs transcripts');
          
          // Try to use TwelveLabs transcripts as fallback
          if (transcripts && transcripts.length > 0) {
            console.log('Using TwelveLabs transcripts as fallback');
            speechTranscripts = transcripts;
          } else {
            console.warn('No speech transcripts found from either Google API or TwelveLabs');
            // Set default values and skip transcript processing
            sentences = [];
            mergedGroups = [];
            segmentsToKeep = [];
            clippedVideoUrl = url; // Use original video
            videoWithAudioUrl = url;
          }
        }
        
        // Only process transcripts if we have them
        if (speechTranscripts && speechTranscripts.length > 0) {
          const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
          const punctuatedTranscripts=await applyPunctuationToTranscripts(transcriptTimestamps);
          sentences=await divideTranscriptsIntoSentencesWithAI(punctuatedTranscripts,speechTranscripts);
          const sentencesWithImportance=await analyzeSentenceImportance(sentences,description,parsedDetails.mainTopic,parsedDetails.category);
          console.log(sentencesWithImportance);
          const selectedTranscripts=await selectTranscriptsByImportance(sentencesWithImportance);
          console.log(selectedTranscripts);

          // Sort the selected transcripts by startTime before merging
          selectedTranscripts.selectedTranscripts.sort((a, b) => 
            parseFloat(a.startTime) - parseFloat(b.startTime)
          );

          mergedGroups = mergeCloseTranscripts(selectedTranscripts.selectedTranscripts);
          console.log(selectedTranscripts.totalDuration);
               
               // Convert mergedGroups to segmentsToKeep array
               for (const group of mergedGroups) {
                 if (group && group.length > 0) {
                   // Get the start time from the first transcript in the group
                   const startTime = group[0].startTime;
                   // Get the end time from the last transcript in the group
                   const endTime = group[group.length - 1].endTime;
                   
                   segmentsToKeep.push({
                     startTime: startTime,
                     endTime: endTime + 0.3
                   });
                 }
               }

               console.log('segmentsToKeep:', segmentsToKeep);
          const lastWordTimestamps=extractLastWordTimestamps(mergedGroups);
          console.log(lastWordTimestamps);
           // Validate segments before trimming
           if (segmentsToKeep.length === 0) {
             console.warn('No segments to keep, skipping video trimming');
             clippedVideoUrl = url; // Use original video
           } else {
             // Validate segment timing
             const totalDuration = Math.max(...segmentsToKeep.map(s => s.endTime));
             console.log('Total duration from segments:', totalDuration);
             console.log('Selected transcripts total duration:', selectedTranscripts.totalDuration);
             
             try {
               const renderId = await removeClipFromVideo(url, segmentsToKeep, selectedTranscripts.totalDuration);
               clippedVideoUrl = renderId.url;
               console.log('Video trimming successful:', clippedVideoUrl);
             } catch (trimError) {
               console.error('Video trimming failed, using original video:', trimError.message);
               clippedVideoUrl = url; // Fallback to original video
             }
           }
           
         
          
           subtitleChunks=createSubtitleChunks(mergedGroups);
           const subtitleResult = await processVideoWithChunkedSubtitles(clippedVideoUrl,subtitleChunks, 'main_chunk');
           
           if (!subtitleResult.success) {
            throw new Error(`Failed to process video with subtitles: ${subtitleResult.error}`);
          }
          
          const { cloudinaryUrl } = subtitleResult;
          videoWithAudioUrl=cloudinaryUrl;
        }

      }
      else{

        videoDetails = await getVideoHighlights(videoId,description);
        console.log(videoDetails.highlights);
        const result = selectMostImportantHighlights(videoDetails.highlights);
        console.log(result);
        selectedHighlights = result.selectedHighlights;
       
        for(const highlight of selectedHighlights){
          segmentsToKeep.push({
            startTime: highlight.start,
            endTime: highlight.end
          });
        }
        console.log(segmentsToKeep);
        
        // Validate segments before trimming
        if (segmentsToKeep.length === 0) {
          console.warn('No segments to keep, skipping video trimming');
          clippedVideoUrl = url; // Use original video
        } else {
          // Validate segment timing
          const totalDuration = Math.max(...segmentsToKeep.map(s => s.endTime));
          console.log('Total duration from segments:', totalDuration);
          console.log('Selected highlights total duration:', result.totalDuration);
          
          try {
            const renderId = await removeClipFromVideo(url, segmentsToKeep, result.totalDuration);
            clippedVideoUrl = renderId.url;
            console.log('Video trimming successful:', clippedVideoUrl);
          } catch (trimError) {
            console.error('Video trimming failed, using original video:', trimError.message);
            clippedVideoUrl = url; // Fallback to original video
          }
        }
        
        let voiceOver=null;
        if(transcripts.length>0){
          const transcriptTexts = [];
      
      // Iterate through each item in the array
      transcripts.forEach(item => {
            if (item.transcript) {
              transcriptTexts.push(item.transcript);
            }
        })
        const contentDescription = transcriptTexts.join('\n');
        voiceOver = await generateVoiceOverForVideo(true, description,contentDescription,segmentsToKeep, result.totalDuration,videoId);
          
        }
        else{
          const highlightText = [];
      
      // Iterate through each item in the array
        selectedHighlights.forEach(item => {
              highlightText.push(item.highlightSummary);
        })
        const contentDescription = highlightText.join('\n');
          voiceOver = await generateVoiceOverForVideo(false, description,contentDescription,segmentsToKeep, result.totalDuration,videoId);
        }
          const {audioUrl,duration} = await convertTextToSpeech(voiceOver);
          const videoWithAudioId = await overlayAudioOnVideo(clippedVideoUrl, audioUrl,duration, result.totalDuration);
          videoWithAudioUrl = videoWithAudioId.url;

      }
    
   
   //const importantChunks = await getImportantTrancriptChunks("685e3ea9da8b16ab27aeb33b");
    res.json({
      language:parsedDetails.language=="Unknown"?language:parsedDetails.language,
      mainTopic:parsedDetails.mainTopic,
      category:parsedDetails.category,
      summary,
      originalVideoUrl: url,
      videoWithAudioUrl,
      segmentsToKeep,
      mergedGroups,
      subtitleChunks,
      selectedHighlights,
      sentences
    });

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}


module.exports = {
  summarizeVideo,
  upload,
  summarizeVideo2,
  summarizeVideo5
};
