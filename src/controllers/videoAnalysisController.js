const path = require('path');
const multer = require('multer');
const { LANGUAGE_NAMES } = require('../constants/languages');
const { extractAudioAndAnalyze, getTranscriptTimestamps } = require('../services/audioAnalysisService');
const { groupRelatedTranscripts,analyzeMainTopic,mergeCloseTranscripts } = require('../services/openAIService');
const { analyzeVideoLabels, analyzeShots ,analyzeShotRelevance,separateAndMergeRelevantShots,selectMostRelevantShotsWithin30sGreedy} = require('../services/visualAnalysisService');
const { uploadVideoToCloudinary } = require('../services/cloudinaryUpload');
const { removeClipFromVideo,overlayAudioOnVideo,applySubtitlesWithShotstack } = require('../services/videoTrimmingService');
const { annotateVideoWithGoogle, processVideoAnnotation } = require('../services/googleService');
const { generateVoiceOver, convertTextToSpeech } = require('../services/voiceOverGenerationService');
const { processVideoWithSubtitles, generateSRTFromTranscripts } = require('../services/subtitleGenerationService');
const { uploadVideoToTwelveLabs } = require('../services/twelveLabsService');
const { getVideoHighlights,getVideoDetails, getVideoTranscript, getImportantTrancriptChunks,selectMostImportantHighlights,generateVoiceOverForVideo,getSpeechSegments,createIndex,selectTranscriptsByImportance } = require('../services/twelveLabsService');

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
      
      const transcriptTimestamps = getTranscriptTimestamps(speechTranscripts);
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
    // if (!req.file) {
    //   return res.status(400).json({ error: 'No video file uploaded' });
    // }

    const description = req.body.summary || null;
    const url=req.body.videoUrl;
    //const fileBuffer = req.file.buffer;
    //const url = await uploadVideoToCloudinary(fileBuffer);
    //const url = `https://res.cloudinary.com/ds0opfsmi/video/upload/v1750942950/my_videos/kgi6pa0lajkyecqiapq3.mp4`
    console.log(url);
  // const url=`https://res.cloudinary.com/ds0opfsmi/video/upload/v1750745841/my_videos/kniuzaombtb1ullbptrh.mp4`;

    // Step 1: Analyze audio first
    //const audioAnalysis = await extractAudioAndAnalyze(fileBuffer);
    

    // Step 2: Process video annotation using the Google service
    //const { speechTranscripts, labels, shots, operationResult } = await processVideoAnnotation(fileBuffer, audioAnalysis.detectedLanguage);
    const videoId = await uploadVideoToTwelveLabs(url);
    console.log(videoId);
    const result = await getVideoTranscript(videoId,description);
    const transcripts=result.transcripts;
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
     
    // const importantChunks = await getImportantTrancriptChunks("6860f305da8b16ab27af7b7a",description);
    // console.log(importantChunks);

    let videoDetails=null;
    let selectedHighlights=null;
    let clippedVideoUrl=null;
    let videoWithAudioUrl=null;
    let mergedGroups=null;
    let segmentsToKeep = [];
    //We have transcript
      if(result.is_speaker){
       

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
      language:parsedDetails.language,
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

async function summarizeVideo3(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }
    const indexId = await createIndex();
    console.log(indexId);

  } catch (error) {
    console.error('Error in video analysis endpoint:', error);
    res.status(500).json({ error: 'Failed to analyze video', trace: error?.message });
  }
}

module.exports = {
  summarizeVideo,
  upload,
  summarizeVideo2,
  summarizeVideo3
};
