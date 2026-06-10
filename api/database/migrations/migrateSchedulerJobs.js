const fs = require('fs');
const path = require('path');
const DatabaseStore = require('../store');

/**
 * Migration script to transfer existing scheduler jobs from JSON to SQLite
 * Usage: node api/database/migrations/migrateSchedulerJobs.js
 */
async function migrateSchedulerJobs() {
  console.log('🔄 Starting scheduler jobs migration...');
  
  const jsonFilePath = path.join(__dirname, '../../../scheduler-jobs.json');
  const backupFilePath = path.join(__dirname, '../../../scheduler-jobs.json.backup');
  
  // Create backup
  if (fs.existsSync(jsonFilePath)) {
    console.log('📦 Creating backup of scheduler-jobs.json...');
    fs.copyFileSync(jsonFilePath, backupFilePath);
    console.log('✅ Backup created at scheduler-jobs.json.backup');
  } else {
    console.log('⚠️  scheduler-jobs.json not found, no data to migrate');
    return;
  }
  
  // Initialize database
  const store = new DatabaseStore();
  store.connect();
  
  try {
    // Load existing jobs from JSON
    console.log('📖 Loading jobs from scheduler-jobs.json...');
    const jsonJobs = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    console.log(`✅ Found ${jsonJobs.length} jobs in JSON file`);
    
    // Get existing jobs from database
    const existingJobs = store.job.getAll();
    const existingJobIds = new Set(existingJobs.map(j => j.id));
    console.log(`📊 Found ${existingJobs.length} existing jobs in database`);
    
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    // Use transaction for all migrations
    store.beginTransaction();
    
    try {
      for (const jsonJob of jsonJobs) {
        try {
          // Skip if job already exists in database
          if (existingJobIds.has(jsonJob.id)) {
            console.log(`⏭️  Skipping job "${jsonJob.name}" (${jsonJob.id}) - already exists`);
            skippedCount++;
            continue;
          }
          
          // Convert JSON job to database format
          const dbJob = convertJsonJobToDbFormat(jsonJob);
          
          // Create job in database
          store.job.create(dbJob);
          
          // Create job runs if run_history exists
          if (jsonJob.run_history && jsonJob.run_history.length > 0) {
            for (const run of jsonJob.run_history) {
              try {
                const runData = {
                  id: run.id,
                  job_id: jsonJob.id,
                  status: run.status || 'completed',
                  started_at: run.started_at,
                  completed_at: run.completed_at,
                  error_message: run.error
                };
                
                // Add output files if present
                if (run.video_path || run.thumb_path || run.audio_path) {
                  runData.output_files = JSON.stringify({
                    video_path: run.video_path,
                    thumb_path: run.thumb_path,
                    audio_path: run.audio_path,
                    clip_count: run.clip_count
                  });
                }
                
                store.jobRun.create(runData);
              } catch (runError) {
                console.warn(`⚠️  Failed to migrate run ${run.id} for job ${jsonJob.id}:`, runError.message);
              }
            }
          }
          
          console.log(`✅ Migrated job "${jsonJob.name}" (${jsonJob.id})`);
          migratedCount++;
          
        } catch (jobError) {
          console.error(`❌ Failed to migrate job "${jsonJob.name}" (${jsonJob.id}):`, jobError.message);
          errorCount++;
        }
      }
      
      store.commit();
      console.log('💾 Database transaction committed');
      
    } catch (transactionError) {
      store.rollback();
      console.error('❌ Transaction failed, rolling back:', transactionError.message);
      throw transactionError;
    }
    
    // Summary
    console.log('\n📊 Migration Summary:');
    console.log(`   ✅ Migrated: ${migratedCount} jobs`);
    console.log(`   ⏭️  Skipped: ${skippedCount} jobs (already exist)`);
    console.log(`   ❌ Errors: ${errorCount} jobs`);
    
    // Verify migration
    const finalJobCount = store.job.count();
    console.log(`\n📈 Final database job count: ${finalJobCount}`);
    
    if (migratedCount > 0) {
      console.log('\n✅ Migration completed successfully!');
      console.log('💡 Tip: You can now delete scheduler-jobs.json after verifying everything works');
    } else {
      console.log('\n⚠️  No new jobs were migrated');
    }
    
  } catch (error) {
    console.error('\n❌ Migration failed:', error.message);
    console.error('📋 No changes were made to the database');
    throw error;
  } finally {
    store.disconnect();
  }
}

/**
 * Convert JSON job format to database format
 */
function convertJsonJobToDbFormat(jsonJob) {
  return {
    id: jsonJob.id,
    name: jsonJob.name,
    topic: jsonJob.topic,
    niche: jsonJob.niche,
    platform: jsonJob.platform,
    goal: jsonJob.goal,
    tone: jsonJob.tone,
    style: jsonJob.style,
    duration_minutes: jsonJob.duration_minutes,
    orientation: jsonJob.orientation,
    voice: jsonJob.voice,
    speed: jsonJob.speed,
    model: jsonJob.model,
    clips_per_scene: jsonJob.clips_per_scene,
    use_youtube: jsonJob.use_youtube ? 1 : 0,
    use_pexels: jsonJob.use_pexels ? 1 : 0,
    use_pixabay: jsonJob.use_pixabay ? 1 : 0,
    podcast_host_voice: jsonJob.podcast_host_voice,
    podcast_guest_voice: jsonJob.podcast_guest_voice,
    auto_captions: jsonJob.auto_captions ? 1 : 0,
    caption_template: jsonJob.caption_template,
    color_grade: jsonJob.color_grade ? 1 : 0,
    title_cards: jsonJob.title_cards ? 1 : 0,
    cut_duration_seconds: jsonJob.cut_duration_seconds,
    tts_provider: jsonJob.tts_provider,
    auto_loop: jsonJob.auto_loop ? 1 : 0,
    background_music: jsonJob.background_music ? 1 : 0,
    music_volume: jsonJob.music_volume,
    multi_format_export: jsonJob.multi_format_export ? 1 : 0,
    webhook_url: jsonJob.webhook_url,
    intro_clip: jsonJob.intro_clip,
    outro_clip: jsonJob.outro_clip,
    hook_ab_test: jsonJob.hook_ab_test ? 1 : 0,
    talking_head_path: jsonJob.talking_head_path,
    pip_size: jsonJob.pip_size,
    pip_corner: jsonJob.pip_corner,
    youtube_auto_upload: jsonJob.youtube_auto_upload ? 1 : 0,
    youtube_privacy: jsonJob.youtube_privacy,
    youtube_title: jsonJob.youtube_title,
    youtube_description: jsonJob.youtube_description,
    youtube_tags: jsonJob.youtube_tags ? JSON.stringify(jsonJob.youtube_tags) : null,
    auto_lower_thirds: jsonJob.auto_lower_thirds ? 1 : 0,
    tiktok_auto_post: jsonJob.tiktok_auto_post ? 1 : 0,
    tiktok_privacy: jsonJob.tiktok_privacy,
    tiktok_title: jsonJob.tiktok_title,
    instagram_auto_post: jsonJob.instagram_auto_post ? 1 : 0,
    instagram_caption: jsonJob.instagram_caption,
    public_video_url: jsonJob.public_video_url,
    steps: jsonJob.steps ? JSON.stringify(jsonJob.steps) : null,
    config: null, // Using individual fields instead of config
    status: jsonJob.status,
    enabled: jsonJob.enabled ? 1 : 0,
    schedule: jsonJob.schedule ? JSON.stringify(jsonJob.schedule) : null,
    next_run_at: jsonJob.next_run_ms ? new Date(jsonJob.next_run_ms).toISOString() : null,
    created_at: jsonJob.created_at,
    updated_at: new Date().toISOString(),
    last_run_id: jsonJob.last_run_id,
    last_run: jsonJob.last_run,
    next_run_ms: jsonJob.next_run_ms,
    run_history: jsonJob.run_history ? JSON.stringify(jsonJob.run_history) : null,
    current_run_id: jsonJob.current_run_id,
    cached_script: jsonJob._cached_script ? JSON.stringify(jsonJob._cached_script) : null,
    last_youtube_video_id: jsonJob._last_youtube_video_id,
    last_youtube_upload_at: jsonJob._last_youtube_upload_at,
    youtube_stats: jsonJob._youtube_stats ? JSON.stringify(jsonJob._youtube_stats) : null,
    youtube_stats_fetched: jsonJob._youtube_stats_fetched ? 1 : 0,
    retry_count: jsonJob._retry_count || 0,
    from_planner: jsonJob._from_planner ? 1 : 0,
    planner_idea_id: jsonJob._planner_idea_id
  };
}

// Run migration if executed directly
if (require.main === module) {
  migrateSchedulerJobs()
    .then(() => {
      console.log('✅ Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { migrateSchedulerJobs, convertJsonJobToDbFormat };