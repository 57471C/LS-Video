use std::sync::Mutex;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct FfmpegState(pub Mutex<Option<tauri_plugin_shell::process::CommandChild>>);

/// Format an FFmpeg failure message, falling back to stdout when stderr is empty.
fn format_ffmpeg_output_error(prefix: &str, output: &tauri_plugin_shell::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        return format!("{}: {}", prefix, stderr);
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if !stdout.trim().is_empty() {
        return format!("{}: {}", prefix, stdout);
    }
    format!(
        "{}: FFmpeg exited with non-zero code but empty logs",
        prefix
    )
}

#[tauri::command]
fn get_startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .map(|arg| arg.trim_matches('"').to_string())
        .find(|arg| {
            let l = arg.to_lowercase();
            l.ends_with(".lsv") || l.ends_with(".lsvz") || l.ends_with(".tmv") || l.ends_with(".tmvz")
        })
}

#[tauri::command]
fn get_launch_argument() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() > 1 {
        let arg = &args[1];
        if !arg.starts_with("--") {
            return Some(arg.trim_matches('"').to_string());
        }
    }
    None
}

#[tauri::command]
async fn run_ffmpeg(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, FfmpegState>,
    args: Vec<String>,
) -> Result<String, String> {
    // 1. Check if there is already a running process
    {
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return Err("FFmpeg process is already running.".to_string());
        }
    }

    // 2. Create sidecar command
    let sidecar_cmd = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .args(args);

    // 3. Spawn child
    let (mut rx, child) = sidecar_cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn FFmpeg sidecar: {}", e))?;

    // 4. Store child in state
    {
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = Some(child);
    }

    // 5. Read output in a background task
    let app_clone = app_handle.clone();
    let stderr_logs = std::sync::Arc::new(Mutex::new(Vec::new()));
    let stderr_logs_clone = stderr_logs.clone();
    let stdout_logs = std::sync::Arc::new(Mutex::new(Vec::new()));
    let stdout_logs_clone = stdout_logs.clone();

    let join_handle = tauri::async_runtime::spawn(async move {
        let mut exit_code = None;

        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    {
                        let mut logs = stdout_logs_clone.lock().unwrap_or_else(|e| e.into_inner());
                        logs.push(line.clone());
                        if logs.len() > 100 {
                            logs.remove(0);
                        }
                    }
                    let _ = app_clone.emit("ffmpeg-stdout", line);
                }
                CommandEvent::Stderr(line_bytes) => {
                    let line = String::from_utf8_lossy(&line_bytes).to_string();
                    // Store in log buffer
                    {
                        let mut logs = stderr_logs_clone.lock().unwrap_or_else(|e| e.into_inner());
                        logs.push(line.clone());
                        if logs.len() > 100 {
                            logs.remove(0);
                        }
                    }
                    // Emit progress or raw logs to JS
                    let _ = app_clone.emit("ffmpeg-stderr", line);
                }
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code;
                    break;
                }
                _ => {}
            }
        }

        // Clear child from state
        let state = app_clone.state::<FfmpegState>();
        {
            let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
            *guard = None;
        }

        exit_code
    });

    // Wait for the process to complete or fail
    let exit_code = join_handle
        .await
        .map_err(|e| format!("Background thread panicked: {}", e))?;

    match exit_code {
        Some(0) => Ok("Success".to_string()),
        Some(code) => {
            let stderr = stderr_logs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .join("\n");
            if !stderr.trim().is_empty() {
                return Err(format!(
                    "FFmpeg failed with exit status code {}.\n\nLogs:\n{}",
                    code, stderr
                ));
            }
            let stdout = stdout_logs
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .join("\n");
            if !stdout.trim().is_empty() {
                return Err(format!(
                    "FFmpeg failed with exit status code {}.\n\nLogs (stdout):\n{}",
                    code, stdout
                ));
            }
            Err(format!(
                "FFmpeg failed with exit status code {}.\n\nFFmpeg exited with non-zero code but empty logs",
                code
            ))
        }
        None => Err("FFmpeg process ended unexpectedly or was terminated by signal.".to_string()),
    }
}

#[tauri::command]
async fn abort_ffmpeg(state: tauri::State<'_, FfmpegState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(child) = guard.take() {
        let _ = child.kill();
    }
    Ok(())
}

// Triggering a recompile to pick up new icons

#[tauri::command]
async fn resolve_subtitles(
    app_handle: tauri::AppHandle,
    video_path: String,
) -> Result<Option<String>, String> {
    use std::path::Path;

    let v_path = Path::new(&video_path);
    let base_dir = v_path.parent().unwrap_or(Path::new(""));
    let base_name = v_path
        .file_stem()
        .unwrap_or_default()
        .to_str()
        .unwrap_or("video");

    let vtt_path = base_dir.join(format!("{}.vtt", base_name));
    let srt_path = base_dir.join(format!("{}.srt", base_name));

    // 1. Check if .vtt exists
    if vtt_path.exists() {
        return Ok(Some(vtt_path.to_string_lossy().into_owned()));
    }

    // 2. Check if .srt exists and convert
    if srt_path.exists() {
        let srt_str = srt_path.to_string_lossy().into_owned();
        let vtt_str = vtt_path.to_string_lossy().into_owned();

        let sidecar = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| e.to_string())?;
        let output = sidecar
            .args(["-y", "-i", &srt_str, &vtt_str])
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            return Ok(Some(vtt_str));
        }
    }

    // 3. Extract embedded soft-subtitles
    let vtt_str = vtt_path.to_string_lossy().into_owned();
    let sidecar = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| e.to_string())?;
    let output = sidecar
        .args(["-y", "-i", &video_path, "-map", "0:s:0", &vtt_str])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    if output.status.success() {
        Ok(Some(vtt_str))
    } else {
        let _ = std::fs::remove_file(&vtt_path);
        Ok(None)
    }
}

// ---------------------------------------------------------------------------
// Bundle commands — save / load .tmvz project packages
// ---------------------------------------------------------------------------

/// Payload emitted to JS on the "package-progress" event.
#[derive(Clone, serde::Serialize)]
struct PackageProgressPayload {
    step: String,
    percent: u32,
    message: String,
    current: u32,
    total: u32,
}

/// Save the current project state and all referenced video files into a single
/// .tmvz archive (ZIP under the hood).
///
/// Heavy zip/IO work is offloaded to Tokio's blocking thread pool so the Tauri
/// executor is never stalled. Progress events are emitted on "package-progress".
///
/// * `project_json` — the full serialised project state
/// * `video_paths`  — absolute paths to every video file to bundle
/// * `output_path`  — destination path for the .tmvz archive
#[tauri::command]
async fn save_tspz_bundle(
    app_handle: tauri::AppHandle,
    project_json: String,
    video_paths: Vec<String>,
    output_path: String,
) -> Result<(), String> {
    let app = app_handle.clone();

    let emit = move |step: &str, percent: u32, message: &str, current: u32, total: u32| {
        let _ = app.emit(
            "package-progress",
            PackageProgressPayload {
                step: step.to_string(),
                percent,
                message: message.to_string(),
                current,
                total,
            },
        );
    };

    emit("start", 0, "Creating archive…", 0, 0);

    let app2 = app_handle.clone();
    let total = video_paths.len() as u32;

    tokio::task::spawn_blocking(move || {
        use std::fs::File;
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let emit_b = |step: &str, percent: u32, message: &str, current: u32, total: u32| {
            let _ = app2.emit(
                "package-progress",
                PackageProgressPayload {
                    step: step.to_string(),
                    percent,
                    message: message.to_string(),
                    current,
                    total,
                },
            );
        };

        let dest = File::create(&output_path).map_err(|e| format!("Cannot create archive: {e}"))?;
        let mut zip = zip::ZipWriter::new(dest);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        // --- project JSON ---
        emit_b("project", 5, "Writing project data…", 0, total);
        zip.start_file("project.lsv", opts)
            .map_err(|e| format!("Cannot start project.lsv: {e}"))?;
        zip.write_all(project_json.as_bytes())
            .map_err(|e| format!("Cannot write project JSON: {e}"))?;

        // --- video files ---
        for (i, path_str) in video_paths.iter().enumerate() {
            let current = (i + 1) as u32;
            let src_path = std::path::Path::new(path_str);
            let entry_name = src_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("video.mp4")
                .to_string();

            // Scale progress: videos occupy 10%–95% of the bar
            let pct = 10 + ((i as f64 / total.max(1) as f64) * 85.0) as u32;
            emit_b(
                "video",
                pct,
                &format!("Packing {} ({}/{})", entry_name, current, total),
                current,
                total,
            );

            let mut src_file =
                File::open(src_path).map_err(|e| format!("Cannot open '{}': {e}", path_str))?;
            zip.start_file(&entry_name, opts)
                .map_err(|e| format!("Cannot start entry '{}': {e}", entry_name))?;
            std::io::copy(&mut src_file, &mut zip)
                .map_err(|e| format!("Cannot copy '{}' into archive: {e}", entry_name))?;
        }

        emit_b("finalising", 97, "Finalising archive…", total, total);
        zip.finish()
            .map_err(|e| format!("Cannot finalise archive: {e}"))?;
        emit_b("done", 100, "Package complete!", total, total);

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| format!("Blocking task panicked: {e}"))??;

    Ok(())
}

/// Result returned to the JavaScript caller after extracting a bundle.
#[derive(serde::Serialize)]
pub struct LoadBundleResult {
    pub project_json: String,
    pub video_paths: Vec<String>,
}

/// Open a .tmvz archive, extract its contents to the OS temp directory, and
/// return the project JSON plus absolute paths of any extracted video files.
///
/// Extraction is offloaded to Tokio's blocking thread pool. Progress events
/// are emitted on "package-progress".
#[tauri::command]
async fn load_tspz_bundle(
    app_handle: tauri::AppHandle,
    bundle_path: String,
) -> Result<LoadBundleResult, String> {
    let app = app_handle.clone();

    tokio::task::spawn_blocking(move || {
        use std::fs::File;
        use std::io::Read;

        let emit = |step: &str, percent: u32, message: &str, current: u32, total: u32| {
            let _ = app.emit(
                "package-progress",
                PackageProgressPayload {
                    step: step.to_string(),
                    percent,
                    message: message.to_string(),
                    current,
                    total,
                },
            );
        };

        emit("start", 0, "Opening archive…", 0, 0);

        let file = File::open(&bundle_path)
            .map_err(|e| format!("Cannot open bundle '{}': {e}", bundle_path))?;
        let mut archive =
            zip::ZipArchive::new(file).map_err(|e| format!("Cannot read ZIP: {e}"))?;

        let total = archive.len() as u32;

        // Unique extraction directory
        let extract_dir = std::env::temp_dir().join(format!(
            "lsvideo_bundle_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&extract_dir)
            .map_err(|e| format!("Cannot create temp dir: {e}"))?;

        let mut project_json = String::new();
        let mut video_paths: Vec<String> = Vec::new();

        const VIDEO_EXTS: &[&str] = &[
            "mp4", "mkv", "avi", "mov", "webm", "mpg", "mpeg", "m4v", "flv",
        ];

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| format!("Cannot read entry {i}: {e}"))?;

            let name = entry.name().to_string();
            let out_path = extract_dir.join(&name);
            let current = (i + 1) as u32;
            let pct = ((i as f64 / total.max(1) as f64) * 95.0) as u32;

            emit(
                "extract",
                pct,
                &format!("Extracting {} ({}/{})", name, current, total),
                current,
                total,
            );

            if entry.is_dir() {
                std::fs::create_dir_all(&out_path)
                    .map_err(|e| format!("Cannot create dir '{name}': {e}"))?;
                continue;
            }

            let mut buf = Vec::new();
            entry
                .read_to_end(&mut buf)
                .map_err(|e| format!("Cannot read entry '{name}': {e}"))?;

            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Cannot create parent dir: {e}"))?;
            }
            std::fs::write(&out_path, &buf).map_err(|e| format!("Cannot write '{name}': {e}"))?;

            let lower = name.to_lowercase();
            if lower == "project.lsv" || lower == "project.tmv" {
                project_json = String::from_utf8(buf)
                    .map_err(|e| format!("project file is not valid UTF-8: {e}"))?;
            } else {
                let ext = std::path::Path::new(&lower)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if VIDEO_EXTS.contains(&ext) {
                    video_paths.push(
                        out_path
                            .to_str()
                            .map(|s| s.to_string())
                            .ok_or_else(|| format!("Non-UTF-8 path for '{name}'"))?,
                    );
                }
            }
        }

        if project_json.is_empty() {
            return Err("Archive does not contain a project file.".to_string());
        }

        emit("done", 100, "Extraction complete!", total, total);

        Ok::<LoadBundleResult, String>(LoadBundleResult {
            project_json,
            video_paths,
        })
    })
    .await
    .map_err(|e| format!("Blocking task panicked: {e}"))?
}

/// Source-time speed range within a segment [start, end) at constant `rate`.
#[derive(Clone, serde::Deserialize)]
struct SpeedRange {
    #[serde(default, alias = "startTime")]
    start: f64,
    #[serde(default, alias = "endTime")]
    end: f64,
    #[serde(default = "default_speed_rate", alias = "speedValue")]
    rate: f64,
}

fn default_speed_rate() -> f64 {
    1.0
}

#[derive(serde::Deserialize)]
struct VideoSegment {
    path: String,
    start_time: f64,
    end_time: f64,
    /// Prefer `loop_count` from JS. `loopCount` accepted as alias only — never send both.
    #[serde(default, alias = "loopCount")]
    loop_count: Option<i32>,
    /// Soft clip-edge fade-in (seconds) at segment start. 0 / omit = no fade.
    #[serde(default, alias = "fadeInSec")]
    fade_in_sec: Option<f64>,
    /// Soft clip-edge fade-out (seconds) ending at segment end. 0 / omit = no fade.
    #[serde(default, alias = "fadeOutSec")]
    fade_out_sec: Option<f64>,
    /// Optional constant-rate sub-ranges in source time (for Speed markers).
    /// When empty / all rate≈1, treated as a normal trim.
    #[serde(default, alias = "speedRanges")]
    speed_ranges: Option<Vec<SpeedRange>>,
    /// True when this segment is audio-only (no video stream / audio export path).
    #[serde(default, alias = "audioOnly")]
    audio_only: Option<bool>,
}

fn is_audio_only_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    [
        ".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".wma",
    ]
    .iter()
    .any(|e| lower.ends_with(e))
}

/// atempo only accepts 0.5–2.0; chain for rates outside that band.
fn build_atempo_filter(rate: f64) -> String {
    let mut r = rate.max(0.01);
    let mut parts: Vec<String> = Vec::new();
    while r > 2.0 + 1e-6 {
        parts.push("atempo=2.0".into());
        r /= 2.0;
    }
    while r < 0.5 - 1e-6 {
        parts.push("atempo=0.5".into());
        r *= 2.0;
    }
    parts.push(format!("atempo={:.4}", r));
    parts.join(",")
}

/// Output duration of a source span played at `rate`.
fn speed_output_duration(source_span: f64, rate: f64) -> f64 {
    let r = rate.max(0.01);
    (source_span / r).max(0.01)
}

/// Sort/clamp/fill speed ranges so they form a contiguous partition of [start, end].
/// Gaps filled at rate 1.0. Overlaps resolved by later range winning at the boundary.
fn normalize_speed_ranges(start: f64, end: f64, raw: &[SpeedRange]) -> Vec<SpeedRange> {
    let mut pts: Vec<(f64, f64)> = raw
        .iter()
        .map(|sr| {
            let a = sr.start.max(start).min(end);
            (a, sr.rate.clamp(0.25, 4.0))
        })
        .filter(|(a, _)| *a < end - 1e-6)
        .collect();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // Dedupe same start — keep last rate
    let mut dedup: Vec<(f64, f64)> = Vec::new();
    for p in pts {
        if let Some(last) = dedup.last_mut() {
            if (last.0 - p.0).abs() < 1e-4 {
                *last = p;
                continue;
            }
        }
        dedup.push(p);
    }
    let mut out: Vec<SpeedRange> = Vec::new();
    let mut cursor = start;
    let mut rate = 1.0;
    if let Some(&(t0, r0)) = dedup.first() {
        if (t0 - start).abs() < 1e-4 {
            rate = r0;
        }
    }
    for (t, r) in &dedup {
        if *t > cursor + 1e-4 {
            out.push(SpeedRange {
                start: cursor,
                end: *t,
                rate,
            });
            cursor = *t;
        }
        rate = *r;
        cursor = cursor.max(*t);
    }
    if cursor < end - 1e-4 {
        out.push(SpeedRange {
            start: cursor,
            end,
            rate,
        });
    }
    if out.is_empty() {
        out.push(SpeedRange {
            start,
            end,
            rate: 1.0,
        });
    }
    println!(
        "[export_queue_job] speed ranges [{:.3}..{:.3}]: {:?}",
        start,
        end,
        out.iter()
            .map(|s| format!("[{:.3},{:.3})@{:.3}", s.start, s.end, s.rate))
            .collect::<Vec<_>>()
    );
    out
}

/// Build ffmpeg video/audio fade filter strings for a trimmed segment (timeline t=0..dur).
/// Soft filters only — no titles, burn-in, or ASS.
///
/// Fade-out reaches full black a few frames *before* the cut: if `st+d` lands
/// exactly on the last sample, frame rounding often leaves the final frame
/// mid-grey instead of black. Early completion holds solid black to the end.
fn build_segment_fade_filters(
    dur: f64,
    fade_in: f64,
    fade_out: f64,
) -> (Option<String>, Option<String>) {
    let mut vf: Vec<String> = Vec::new();
    let mut af: Vec<String> = Vec::new();
    let safe_dur = dur.max(0.01);
    let fi = fade_in.max(0.0);
    let fo = fade_out.max(0.0);
    if fi > 0.001 {
        let d = fi.min(safe_dur);
        vf.push(format!("fade=t=in:st=0:d={:.4}", d));
        af.push(format!("afade=t=in:st=0:d={:.4}", d));
    }
    if fo > 0.001 {
        let d = fo.min(safe_dur);
        // ~2 frames @ 24fps, capped so short fades still work
        let early = 0.08_f64.min(d * 0.2).min((safe_dur * 0.5).max(0.0));
        let st = (safe_dur - d - early).max(0.0);
        // color=black ensures solid black (not residual RGB from source)
        vf.push(format!(
            "fade=t=out:st={:.4}:d={:.4}:color=black",
            st, d
        ));
        af.push(format!("afade=t=out:st={:.4}:d={:.4}", st, d));
    }
    (
        if vf.is_empty() {
            None
        } else {
            Some(vf.join(","))
        },
        if af.is_empty() {
            None
        } else {
            Some(af.join(","))
        },
    )
}

#[tauri::command]
async fn join_and_compress_videos(
    app_handle: tauri::AppHandle,
    video_segments: Vec<VideoSegment>,
    output_file_name: String,
) -> Result<String, String> {
    let app_handle_clone = app_handle.clone();
    let video_segments_clone = video_segments;
    let output_file_name_clone = output_file_name.clone();

    tokio::task::spawn_blocking(move || {
        use std::env;
        use std::path::Path;
        use std::time::{SystemTime, UNIX_EPOCH};

        if video_segments_clone.is_empty() {
            return Err("No video segments provided.".to_string());
        }

        // Helper function to extract native duration using ffmpeg -i
        let get_duration = |path: &str| -> Option<f64> {
            if let Ok(sidecar) = app_handle_clone.shell().sidecar("ffmpeg") {
                let sidecar = sidecar.args(["-i", path]);
                if let Ok(output) = tauri::async_runtime::block_on(sidecar.output()) {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if let Some(pos) = stderr.find("Duration: ") {
                        let sub = &stderr[pos + 10..];
                        if sub.len() >= 11 {
                            let parts: Vec<&str> = sub[..11].split(':').collect();
                            if parts.len() == 3 {
                                let hours: f64 = parts[0].parse().unwrap_or(0.0);
                                let minutes: f64 = parts[1].parse().unwrap_or(0.0);
                                let seconds: f64 = parts[2].parse().unwrap_or(0.0);
                                return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                            }
                        }
                    }
                }
            }
            None
        };

        // Step 1: Resolve Absolute Paths
        let first_video_path = Path::new(&video_segments_clone[0].path);
        let base_dir = first_video_path
            .parent()
            .ok_or_else(|| "Failed to get parent directory".to_string())?;

        let unique_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let temp_dir = env::temp_dir();
        let list_path = temp_dir.join(format!("concat_list_{}.txt", unique_id));
        let intermediate_path = temp_dir.join(format!("intermediate_{}.mp4", unique_id));
        let temp_final_path = temp_dir.join(format!("temp_final_{}.mp4", unique_id));
        let final_path = base_dir.join(&output_file_name_clone);

        let list_path_str = list_path.to_str().ok_or("Invalid list path")?;
        let intermediate_path_str = intermediate_path
            .to_str()
            .ok_or("Invalid intermediate path")?;
        let temp_final_path_str = temp_final_path.to_str().ok_or("Invalid temp final path")?;
        let final_path_str = final_path.to_str().ok_or("Invalid final path")?;

        // Recursive Pre-Trim execution loop
        let mut temp_clips = Vec::new();
        let mut final_paths_to_concat = Vec::new();

        for (i, segment) in video_segments_clone.iter().enumerate() {
            let mut needs_trim = true;
            if segment.start_time == 0.0 {
                if segment.end_time == 0.0 {
                    needs_trim = false;
                } else if let Some(native_dur) = get_duration(&segment.path) {
                    if (segment.end_time - native_dur).abs() < 0.1 {
                        needs_trim = false;
                    }
                }
            }

            let temp_output_path = temp_dir.join(format!("temp_seg_{}_{}.mp4", i, unique_id));
            let temp_output_str = temp_output_path
                .to_str()
                .ok_or("Invalid temp segment path")?;

            if needs_trim {
                let ffmpeg_sidecar = app_handle_clone
                    .shell()
                    .sidecar("ffmpeg")
                    .map_err(|e| e.to_string())?
                    .args([
                        "-y",
                        "-ss",
                        &segment.start_time.to_string(),
                        "-to",
                        &segment.end_time.to_string(),
                        "-i",
                        &segment.path,
                        "-c",
                        "copy",
                        temp_output_str,
                    ]);

                let output = tauri::async_runtime::block_on(ffmpeg_sidecar.output())
                    .map_err(|e| e.to_string())?;

                if !output.status.success() {
                    // Cleanup temp files
                    tokio::spawn(async move {
                        for clip in temp_clips {
                            let _ = tokio::fs::remove_file(clip).await;
                        }
                    });

                    return Err(format_ffmpeg_output_error(
                        &format!("Failed to trim segment {}", i),
                        &output,
                    ));
                }

                temp_clips.push(temp_output_path.clone());
            }

            let loop_count = segment.loop_count.unwrap_or(1).max(1);
            for _ in 0..loop_count {
                if needs_trim {
                    final_paths_to_concat.push(temp_output_str.to_string());
                } else {
                    final_paths_to_concat.push(segment.path.clone());
                }
            }
        }

        // Step 2: Pre-Flight Extension Match (of final paths to concat)
        let mut all_same_extension = true;
        let first_ext = Path::new(&final_paths_to_concat[0])
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        for path in &final_paths_to_concat {
            let ext = Path::new(path)
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext != first_ext {
                all_same_extension = false;
                break;
            }
        }

        // Write concat demuxer list, then drop the handle so Windows releases the file lock
        // before the FFmpeg sidecar opens the same path.
        {
            use std::io::Write;
            let mut list_file = std::fs::File::create(&list_path).map_err(|e| e.to_string())?;
            let mut out_string = String::with_capacity(final_paths_to_concat.len() * 250);
            for path in &final_paths_to_concat {
                // FFmpeg concat demuxer expects forward slashes and single-quoted paths
                let formatted_path = path.replace("\\", "/");
                let line = format!("file '{}'\n", formatted_path);
                out_string.push_str(&line);
            }
            list_file
                .write_all(out_string.as_bytes())
                .map_err(|e| e.to_string())?;
            list_file.flush().map_err(|e| e.to_string())?;
            list_file.sync_all().map_err(|e| e.to_string())?;
            // Explicit drop releases the exclusive write lock on Windows
            drop(list_file);
        }

        let mut lossless_success = false;

        if all_same_extension {
            let ffmpeg_sidecar = app_handle_clone
                .shell()
                .sidecar("ffmpeg")
                .map_err(|e| e.to_string())?
                .args([
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    list_path_str,
                    "-c",
                    "copy",
                    intermediate_path_str,
                ]);

            let output = tauri::async_runtime::block_on(ffmpeg_sidecar.output())
                .map_err(|e| e.to_string())?;
            if output.status.success() {
                lossless_success = true;
            }
        }

        // Step 3: Fallback Mixed Media Mode
        if !lossless_success {
            let mut args = vec!["-y".to_string()];
            let mut filter_complex = String::new();
            let n = final_paths_to_concat.len();

            for (i, path) in final_paths_to_concat.iter().enumerate() {
                args.push("-i".to_string());
                args.push(path.to_string());
                filter_complex.push_str(&format!("[{}:v][{}:a]", i, i));
            }
            filter_complex.push_str(&format!("concat=n={}:v=1:a=1[v][a]", n));

            args.push("-filter_complex".to_string());
            args.push(filter_complex);
            args.push("-map".to_string());
            args.push("[v]".to_string());
            args.push("-map".to_string());
            args.push("[a]".to_string());
            args.push(intermediate_path_str.to_string());

            let ffmpeg_sidecar = app_handle_clone
                .shell()
                .sidecar("ffmpeg")
                .map_err(|e| e.to_string())?
                .args(args);
            let output = tauri::async_runtime::block_on(ffmpeg_sidecar.output())
                .map_err(|e| e.to_string())?;

            if !output.status.success() {
                let list_path_clone = list_path.clone();
                let intermediate_path_clone = intermediate_path.clone();
                tokio::spawn(async move {
                    let _ = tokio::fs::remove_file(list_path_clone).await;
                    let _ = tokio::fs::remove_file(intermediate_path_clone).await;
                    for clip in temp_clips {
                        let _ = tokio::fs::remove_file(clip).await;
                    }
                });

                return Err(format_ffmpeg_output_error(
                    "Filtergraph fallback failed",
                    &output,
                ));
            }
        }

        // Step 4: Final Compression Step
        let compression_args = vec![
            "-y",
            "-i",
            intermediate_path_str,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-crf",
            "23",
            "-preset",
            "medium",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            temp_final_path_str,
        ];

        let ffmpeg_sidecar = app_handle_clone
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| e.to_string())?
            .args(compression_args);

        let output =
            tauri::async_runtime::block_on(ffmpeg_sidecar.output()).map_err(|e| e.to_string())?;

        if !output.status.success() {
            let list_path_clone = list_path.clone();
            let intermediate_path_clone = intermediate_path.clone();
            let temp_final_path_clone = temp_final_path.clone();
            tokio::spawn(async move {
                let _ = tokio::fs::remove_file(list_path_clone).await;
                let _ = tokio::fs::remove_file(intermediate_path_clone).await;
                let _ = tokio::fs::remove_file(temp_final_path_clone).await;
                for clip in temp_clips {
                    let _ = tokio::fs::remove_file(clip).await;
                }
            });

            return Err(format_ffmpeg_output_error(
                "Final compression failed",
                &output,
            ));
        }

        // Step 5: Cleanup and Return (with Cross-Drive LINK Support)
        std::fs::copy(&temp_final_path, &final_path)
            .map_err(|e| format!("Failed to copy file across drives: {}", e))?;

        tokio::spawn(async move {
            let concat_list_str = list_path.to_string_lossy().to_string();
            let concat_list_path = Path::new(&concat_list_str);
            if tokio::fs::try_exists(concat_list_path)
                .await
                .unwrap_or(false)
            {
                if let Err(e) = tokio::fs::remove_file(concat_list_path).await {
                    println!("Non-fatal warning: failed to delete temp list: {}", e);
                }
            }

            let _ = tokio::fs::remove_file(intermediate_path).await;
            let _ = tokio::fs::remove_file(temp_final_path).await;
            for clip in temp_clips {
                let _ = tokio::fs::remove_file(clip).await;
            }
        });

        Ok(final_path_str.to_string())
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

/// Batch-export one job: one or more segments (solo trim or joined concat).
/// Writes `output_path` (absolute). Sources are never deleted.
/// `quality`: "copy" | "low" | "medium" | "high"
/// `strip_audio`: omit audio track (-an)
#[tauri::command]
async fn export_queue_job(
    app_handle: tauri::AppHandle,
    video_segments: Vec<VideoSegment>,
    output_path: String,
    quality: String,
    strip_audio: bool,
) -> Result<String, String> {
    let app = app_handle.clone();
    tokio::task::spawn_blocking(move || {
        use std::env;
        use std::path::Path;
        use std::time::{SystemTime, UNIX_EPOCH};

        if video_segments.is_empty() {
            return Err("No video segments provided.".to_string());
        }
        if output_path.trim().is_empty() {
            return Err("Output path is empty.".to_string());
        }
        // Reject mixed audio+video join jobs up front (clear error, not ffmpeg dump)
        {
            let mut has_audio = false;
            let mut has_video = false;
            for s in &video_segments {
                let ao = s.audio_only.unwrap_or(false) || is_audio_only_path(&s.path);
                if ao {
                    has_audio = true;
                } else {
                    has_video = true;
                }
            }
            if has_audio && has_video {
                return Err("Can't join audio and video in one export.".to_string());
            }
        }

        let get_duration = |path: &str| -> Option<f64> {
            if let Ok(sidecar) = app.shell().sidecar("ffmpeg") {
                let sidecar = sidecar.args(["-i", path]);
                if let Ok(output) = tauri::async_runtime::block_on(sidecar.output()) {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if let Some(pos) = stderr.find("Duration: ") {
                        let sub = &stderr[pos + 10..];
                        if sub.len() >= 11 {
                            let parts: Vec<&str> = sub[..11].split(':').collect();
                            if parts.len() == 3 {
                                let hours: f64 = parts[0].parse().unwrap_or(0.0);
                                let minutes: f64 = parts[1].parse().unwrap_or(0.0);
                                let seconds: f64 = parts[2].parse().unwrap_or(0.0);
                                return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                            }
                        }
                    }
                }
            }
            None
        };

        let unique_id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();
        let temp_dir = env::temp_dir();
        let mut temp_clips: Vec<std::path::PathBuf> = Vec::new();
        let mut cleaned_paths: Vec<String> = Vec::new();

        let quality_l = quality.to_lowercase();
        let prefer_copy = quality_l == "copy";
        let crf = match quality_l.as_str() {
            "low" => "32",
            "high" => "18",
            _ => "23",
        };
        let preset = match quality_l.as_str() {
            "low" => "veryfast",
            "high" => "medium",
            _ => "fast",
        };

        // --- Step 1: per-segment trim into temp (reliable reencode; copy attempt first when quality=copy) ---
        for (i, segment) in video_segments.iter().enumerate() {
            let path = Path::new(&segment.path);
            if !path.exists() {
                return Err(format!("Source not found: {}", segment.path));
            }

            let start = segment.start_time.max(0.0);
            let mut end = segment.end_time;
            if end <= 0.0 {
                end = get_duration(&segment.path).unwrap_or(0.0);
            }
            if end > 0.0 && end <= start {
                return Err(format!(
                    "Invalid clip bounds for segment {} (start={}, end={})",
                    i, start, end
                ));
            }

            let seg_dur = if end > start {
                (end - start).max(0.01)
            } else {
                get_duration(&segment.path).unwrap_or(0.01).max(0.01)
            };
            let fade_in = segment.fade_in_sec.unwrap_or(0.0).max(0.0);
            let fade_out = segment.fade_out_sec.unwrap_or(0.0).max(0.0);
            let audio_only = segment.audio_only.unwrap_or(false)
                || is_audio_only_path(&segment.path);

            // Contiguous partition of [start, end] on Speed marker times
            let raw_ranges = segment.speed_ranges.clone().unwrap_or_default();
            let speed_ranges = normalize_speed_ranges(start, end, &raw_ranges);
            let has_variable_speed = speed_ranges
                .iter()
                .any(|sr| (sr.rate - 1.0).abs() > 0.01);
            let output_seg_dur: f64 = speed_ranges
                .iter()
                .map(|sr| speed_output_duration(sr.end - sr.start, sr.rate))
                .sum();
            // Fades apply on OUTPUT timeline after speed (correct export length first)
            let has_fades = fade_in > 0.001 || fade_out > 0.001;
            let (fade_vf_full, fade_af) =
                build_segment_fade_filters(output_seg_dur.max(0.01), fade_in, fade_out);
            // Never apply video fade filters on audio-only sources (no video stream)
            let fade_vf: Option<String> = if audio_only {
                None
            } else {
                fade_vf_full
            };

            let is_full = start <= 0.001
                && (end <= 0.0
                    || get_duration(&segment.path)
                        .map(|d| (end - d).abs() < 0.15)
                        .unwrap_or(false));

            let temp_ext = if audio_only { "m4a" } else { "mp4" };
            let temp_out =
                temp_dir.join(format!("batch_seg_{}_{}.{}", i, unique_id, temp_ext));
            let temp_out_str = temp_out.to_string_lossy().to_string();

            let mut made = false;

            // --- Audio-only path: no video filters / no libx264 ---
            if audio_only && !made {
                let mut aargs: Vec<String> = vec!["-y".into()];
                if start > 0.001 {
                    aargs.push("-ss".into());
                    aargs.push(start.to_string());
                }
                aargs.push("-i".into());
                aargs.push(segment.path.clone());
                if end > 0.0 {
                    aargs.push("-t".into());
                    aargs.push(seg_dur.to_string());
                }
                aargs.push("-vn".into());
                if let Some(ref af) = fade_af {
                    aargs.push("-af".into());
                    aargs.push(af.clone());
                } else if has_variable_speed {
                    // atempo only (no video setpts)
                    let mut af_parts: Vec<String> = Vec::new();
                    // Simple: if single non-1 rate, apply atempo; multi-rate audio is rare
                    if speed_ranges.len() == 1 {
                        let rate = speed_ranges[0].rate.clamp(0.25, 4.0);
                        if (rate - 1.0).abs() > 0.01 {
                            af_parts.push(build_atempo_filter(rate));
                        }
                    }
                    if !af_parts.is_empty() {
                        aargs.push("-af".into());
                        aargs.push(af_parts.join(","));
                    }
                }
                if prefer_copy && !has_fades && !has_variable_speed {
                    aargs.extend(["-c:a".into(), "copy".into()]);
                } else {
                    aargs.extend([
                        "-c:a".into(),
                        "aac".into(),
                        "-b:a".into(),
                        "192k".into(),
                    ]);
                }
                aargs.push(temp_out_str.clone());
                let out = tauri::async_runtime::block_on(
                    app.shell()
                        .sidecar("ffmpeg")
                        .map_err(|e| e.to_string())?
                        .args(aargs)
                        .output(),
                )
                .map_err(|e| e.to_string())?;
                if out.status.success() {
                    temp_clips.push(temp_out.clone());
                    cleaned_paths.push(temp_out_str.clone());
                    made = true;
                } else {
                    for c in &temp_clips {
                        let _ = std::fs::remove_file(c);
                    }
                    return Err(format_ffmpeg_output_error(
                        &format!("Audio export failed for segment {}", i),
                        &out,
                    ));
                }
            }

            // Stream copy only when no soft fades and no speed changes
            if !audio_only
                && !has_fades
                && !has_variable_speed
                && is_full
                && prefer_copy
                && !strip_audio
            {
                cleaned_paths.push(segment.path.clone());
                made = true;
            } else if !audio_only
                && !has_fades
                && !has_variable_speed
                && is_full
                && prefer_copy
                && strip_audio
            {
                // Full file, strip audio only
                let args = vec![
                    "-y".into(),
                    "-i".into(),
                    segment.path.clone(),
                    "-c:v".into(),
                    "copy".into(),
                    "-an".into(),
                    temp_out_str.clone(),
                ];
                let out = tauri::async_runtime::block_on(
                    app.shell()
                        .sidecar("ffmpeg")
                        .map_err(|e| e.to_string())?
                        .args(args)
                        .output(),
                )
                .map_err(|e| e.to_string())?;
                if out.status.success() {
                    temp_clips.push(temp_out.clone());
                    cleaned_paths.push(temp_out_str.clone());
                    made = true;
                }
            }

            if !made && !audio_only {
                // --- Variable speed path: split on Speed markers, setpts/atempo, concat, then fade ---
                if has_variable_speed {
                    // Each run: trim ONLY [sr.start, sr.end), then speed that piece alone.
                    // Output piece duration MUST be span/rate (explicit -t after filters).
                    let mut speed_temps: Vec<std::path::PathBuf> = Vec::new();
                    for (ri, sr) in speed_ranges.iter().enumerate() {
                        let piece = temp_dir.join(format!(
                            "batch_spd_{}_{}_{}.mp4",
                            i, ri, unique_id
                        ));
                        let piece_str = piece.to_string_lossy().to_string();
                        let span = (sr.end - sr.start).max(0.01);
                        let rate = sr.rate.clamp(0.25, 4.0);
                        let out_dur = speed_output_duration(span, rate);
                        println!(
                            "[export_queue_job] seg{} run{} trim [{:.3},{:.3}) span={:.3} rate={:.3} -> out_dur={:.3}",
                            i, ri, sr.start, sr.end, span, rate, out_dur
                        );
                        // Input seek + duration first, then setpts/atempo on that slice only.
                        // setpts alone does not drop frames; -t out_dur caps the encode length.
                        let mut rargs: Vec<String> = vec![
                            "-y".into(),
                            "-ss".into(),
                            format!("{:.6}", sr.start),
                            "-i".into(),
                            segment.path.clone(),
                            "-t".into(),
                            format!("{:.6}", span),
                        ];
                        if (rate - 1.0).abs() > 0.01 {
                            rargs.push("-vf".into());
                            rargs.push(format!(
                                "setpts=(PTS-STARTPTS)/{:.6}",
                                rate
                            ));
                        } else {
                            // 1x: reset PTS only (no time stretch)
                            rargs.push("-vf".into());
                            rargs.push("setpts=PTS-STARTPTS".into());
                        }
                        rargs.extend([
                            "-c:v".into(),
                            "libx264".into(),
                            "-pix_fmt".into(),
                            "yuv420p".into(),
                            "-crf".into(),
                            crf.into(),
                            "-preset".into(),
                            preset.into(),
                        ]);
                        if strip_audio {
                            rargs.push("-an".into());
                        } else if (rate - 1.0).abs() > 0.01 {
                            rargs.push("-af".into());
                            rargs.push(build_atempo_filter(rate));
                            rargs.extend([
                                "-c:a".into(),
                                "aac".into(),
                                "-b:a".into(),
                                "128k".into(),
                            ]);
                        } else {
                            rargs.extend([
                                "-c:a".into(),
                                "aac".into(),
                                "-b:a".into(),
                                "128k".into(),
                            ]);
                        }
                        // Force output length = source_span / rate (prevents ~10s from 5s@2x frame count)
                        rargs.push("-t".into());
                        rargs.push(format!("{:.6}", out_dur));
                        rargs.push(piece_str.clone());
                        let out = tauri::async_runtime::block_on(
                            app.shell()
                                .sidecar("ffmpeg")
                                .map_err(|e| e.to_string())?
                                .args(rargs)
                                .output(),
                        )
                        .map_err(|e| e.to_string())?;
                        if !out.status.success() {
                            for c in &speed_temps {
                                let _ = std::fs::remove_file(c);
                            }
                            for c in &temp_clips {
                                let _ = std::fs::remove_file(c);
                            }
                            return Err(format_ffmpeg_output_error(
                                &format!("Failed speed range {} on segment {}", ri, i),
                                &out,
                            ));
                        }
                        speed_temps.push(piece);
                    }

                    // Concat speed pieces
                    let speed_concat_list =
                        temp_dir.join(format!("batch_spd_list_{}_{}.txt", i, unique_id));
                    let speed_concat_out =
                        temp_dir.join(format!("batch_spd_cat_{}_{}.mp4", i, unique_id));
                    {
                        use std::io::Write;
                        let mut lf = std::fs::File::create(&speed_concat_list)
                            .map_err(|e| e.to_string())?;
                        for p in &speed_temps {
                            let formatted = p.to_string_lossy().replace('\\', "/");
                            writeln!(lf, "file '{}'", formatted).map_err(|e| e.to_string())?;
                        }
                        lf.flush().map_err(|e| e.to_string())?;
                    }
                    let list_str = speed_concat_list.to_string_lossy().to_string();
                    let cat_str = speed_concat_out.to_string_lossy().to_string();
                    let cat_args = vec![
                        "-y".into(),
                        "-f".into(),
                        "concat".into(),
                        "-safe".into(),
                        "0".into(),
                        "-i".into(),
                        list_str.clone(),
                        "-c".into(),
                        "copy".into(),
                        cat_str.clone(),
                    ];
                    let mut cat_ok = false;
                    if let Ok(out) = tauri::async_runtime::block_on(
                        app.shell()
                            .sidecar("ffmpeg")
                            .map_err(|e| e.to_string())?
                            .args(cat_args)
                            .output(),
                    ) {
                        cat_ok = out.status.success();
                    }
                    if !cat_ok {
                        // Reencode concat fallback
                        let mut cargs = vec!["-y".to_string()];
                        let mut fc = String::new();
                        let n = speed_temps.len();
                        for (pi, p) in speed_temps.iter().enumerate() {
                            cargs.push("-i".into());
                            cargs.push(p.to_string_lossy().to_string());
                            if strip_audio {
                                fc.push_str(&format!("[{}:v]", pi));
                            } else {
                                fc.push_str(&format!("[{}:v][{}:a]", pi, pi));
                            }
                        }
                        if strip_audio {
                            fc.push_str(&format!("concat=n={}:v=1:a=0[v]", n));
                        } else {
                            fc.push_str(&format!("concat=n={}:v=1:a=1[v][a]", n));
                        }
                        cargs.push("-filter_complex".into());
                        cargs.push(fc);
                        cargs.push("-map".into());
                        cargs.push("[v]".into());
                        if !strip_audio {
                            cargs.push("-map".into());
                            cargs.push("[a]".into());
                        }
                        cargs.extend([
                            "-c:v".into(),
                            "libx264".into(),
                            "-pix_fmt".into(),
                            "yuv420p".into(),
                            "-crf".into(),
                            crf.into(),
                            "-preset".into(),
                            preset.into(),
                        ]);
                        if strip_audio {
                            cargs.push("-an".into());
                        } else {
                            cargs.extend([
                                "-c:a".into(),
                                "aac".into(),
                                "-b:a".into(),
                                "128k".into(),
                            ]);
                        }
                        cargs.push(cat_str.clone());
                        let out = tauri::async_runtime::block_on(
                            app.shell()
                                .sidecar("ffmpeg")
                                .map_err(|e| e.to_string())?
                                .args(cargs)
                                .output(),
                        )
                        .map_err(|e| e.to_string())?;
                        if !out.status.success() {
                            let _ = std::fs::remove_file(&speed_concat_list);
                            for c in &speed_temps {
                                let _ = std::fs::remove_file(c);
                            }
                            for c in &temp_clips {
                                let _ = std::fs::remove_file(c);
                            }
                            return Err(format_ffmpeg_output_error(
                                &format!("Failed to concat speed ranges for segment {}", i),
                                &out,
                            ));
                        }
                    }

                    // Apply edge fades on OUTPUT timeline after speed
                    if has_fades {
                        let mut fargs: Vec<String> = vec![
                            "-y".into(),
                            "-i".into(),
                            cat_str.clone(),
                        ];
                        if let Some(ref vf) = fade_vf {
                            fargs.push("-vf".into());
                            fargs.push(vf.clone());
                        }
                        fargs.extend([
                            "-c:v".into(),
                            "libx264".into(),
                            "-pix_fmt".into(),
                            "yuv420p".into(),
                            "-crf".into(),
                            crf.into(),
                            "-preset".into(),
                            preset.into(),
                        ]);
                        if strip_audio {
                            fargs.push("-an".into());
                        } else if let Some(ref af) = fade_af {
                            fargs.push("-af".into());
                            fargs.push(af.clone());
                            fargs.extend([
                                "-c:a".into(),
                                "aac".into(),
                                "-b:a".into(),
                                "128k".into(),
                            ]);
                        } else {
                            fargs.extend([
                                "-c:a".into(),
                                "aac".into(),
                                "-b:a".into(),
                                "128k".into(),
                            ]);
                        }
                        fargs.push(temp_out_str.clone());
                        let out = tauri::async_runtime::block_on(
                            app.shell()
                                .sidecar("ffmpeg")
                                .map_err(|e| e.to_string())?
                                .args(fargs)
                                .output(),
                        )
                        .map_err(|e| e.to_string())?;
                        let _ = std::fs::remove_file(&speed_concat_list);
                        let _ = std::fs::remove_file(&speed_concat_out);
                        for c in &speed_temps {
                            let _ = std::fs::remove_file(c);
                        }
                        if !out.status.success() {
                            for c in &temp_clips {
                                let _ = std::fs::remove_file(c);
                            }
                            return Err(format_ffmpeg_output_error(
                                &format!("Failed fade after speed on segment {}", i),
                                &out,
                            ));
                        }
                        temp_clips.push(temp_out.clone());
                        cleaned_paths.push(temp_out_str.clone());
                        made = true;
                    } else {
                        // Move concat result to temp_out
                        let _ = std::fs::remove_file(&speed_concat_list);
                        for c in &speed_temps {
                            let _ = std::fs::remove_file(c);
                        }
                        if std::fs::rename(&speed_concat_out, &temp_out).is_err() {
                            std::fs::copy(&speed_concat_out, &temp_out)
                                .map_err(|e| e.to_string())?;
                            let _ = std::fs::remove_file(&speed_concat_out);
                        }
                        temp_clips.push(temp_out.clone());
                        cleaned_paths.push(temp_out_str.clone());
                        made = true;
                    }
                }
            }

            if !made && !audio_only {
                // Trim (and optionally reencode). Prefer reencode for HEVC/proxy safety.
                let mut args: Vec<String> = vec!["-y".into()];
                if start > 0.001 {
                    args.push("-ss".into());
                    args.push(start.to_string());
                }
                args.push("-i".into());
                args.push(segment.path.clone());
                if end > 0.0 {
                    // duration-based -t is more reliable after -ss input seek than -to
                    args.push("-t".into());
                    args.push(seg_dur.to_string());
                }

                // Stream copy only when no fades / no speed
                if prefer_copy && !has_fades && !has_variable_speed {
                    args.push("-c".into());
                    args.push("copy".into());
                    if strip_audio {
                        args.push("-an".into());
                    }
                    args.push(temp_out_str.clone());
                    let out = tauri::async_runtime::block_on(
                        app.shell()
                            .sidecar("ffmpeg")
                            .map_err(|e| e.to_string())?
                            .args(args.clone())
                            .output(),
                    )
                    .map_err(|e| e.to_string())?;
                    if out.status.success() {
                        temp_clips.push(temp_out.clone());
                        cleaned_paths.push(temp_out_str.clone());
                        made = true;
                    }
                }

                if !made {
                    // Reencode (HEVC / keyframe / mixed containers / soft fades)
                    let mut rargs: Vec<String> = vec!["-y".into()];
                    if start > 0.001 {
                        rargs.push("-ss".into());
                        rargs.push(start.to_string());
                    }
                    rargs.push("-i".into());
                    rargs.push(segment.path.clone());
                    if end > 0.0 {
                        rargs.push("-t".into());
                        rargs.push(seg_dur.to_string());
                    }
                    if let Some(ref vf) = fade_vf {
                        rargs.push("-vf".into());
                        rargs.push(vf.clone());
                    }
                    rargs.extend([
                        "-c:v".into(),
                        "libx264".into(),
                        "-pix_fmt".into(),
                        "yuv420p".into(),
                        "-crf".into(),
                        crf.into(),
                        "-preset".into(),
                        preset.into(),
                    ]);
                    if strip_audio {
                        rargs.push("-an".into());
                    } else if let Some(ref af) = fade_af {
                        rargs.push("-af".into());
                        rargs.push(af.clone());
                        rargs.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
                    } else {
                        rargs.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
                    }
                    rargs.push(temp_out_str.clone());
                    let out = tauri::async_runtime::block_on(
                        app.shell()
                            .sidecar("ffmpeg")
                            .map_err(|e| e.to_string())?
                            .args(rargs)
                            .output(),
                    )
                    .map_err(|e| e.to_string())?;
                    if !out.status.success() {
                        for c in &temp_clips {
                            let _ = std::fs::remove_file(c);
                        }
                        return Err(format_ffmpeg_output_error(
                            &format!("Failed to process segment {}", i),
                            &out,
                        ));
                    }
                    temp_clips.push(temp_out.clone());
                    cleaned_paths.push(temp_out_str);
                }
            }
        }

        if cleaned_paths.is_empty() {
            return Err("No processed segments to export.".to_string());
        }

        let out_path = Path::new(&output_path);
        if let Some(parent) = out_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create output directory: {}", e))?;
            }
        }

        // --- Step 2: single clip → copy/move to output; multi → concat ---
        if cleaned_paths.len() == 1 {
            let src = &cleaned_paths[0];
            let single_audio = video_segments[0].audio_only.unwrap_or(false)
                || is_audio_only_path(&video_segments[0].path);
            // If source is original full file, re-mux/copy to output path
            if Path::new(src) == Path::new(&video_segments[0].path)
                || !prefer_copy
                || strip_audio
            {
                // Ensure final quality at destination
                let mut args: Vec<String> = vec![
                    "-y".into(),
                    "-i".into(),
                    src.clone(),
                ];
                if single_audio {
                    args.push("-vn".into());
                    if prefer_copy {
                        args.extend(["-c:a".into(), "copy".into()]);
                    } else {
                        args.extend([
                            "-c:a".into(),
                            "aac".into(),
                            "-b:a".into(),
                            "192k".into(),
                        ]);
                    }
                } else if prefer_copy && !strip_audio {
                    args.extend(["-c".into(), "copy".into()]);
                } else if prefer_copy && strip_audio {
                    args.extend(["-c:v".into(), "copy".into(), "-an".into()]);
                } else {
                    args.extend([
                        "-c:v".into(),
                        "libx264".into(),
                        "-pix_fmt".into(),
                        "yuv420p".into(),
                        "-crf".into(),
                        crf.into(),
                        "-preset".into(),
                        preset.into(),
                    ]);
                    if strip_audio {
                        args.push("-an".into());
                    } else {
                        args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
                    }
                }
                args.push(output_path.clone());
                let out = tauri::async_runtime::block_on(
                    app.shell()
                        .sidecar("ffmpeg")
                        .map_err(|e| e.to_string())?
                        .args(args)
                        .output(),
                )
                .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    // Fallback: raw copy of temp file if it is already processed mp4
                    if Path::new(src) != Path::new(&video_segments[0].path) {
                        std::fs::copy(src, &output_path).map_err(|e| {
                            format!(
                                "Export failed and copy fallback failed: {}",
                                e
                            )
                        })?;
                    } else {
                        for c in &temp_clips {
                            let _ = std::fs::remove_file(c);
                        }
                        return Err(format_ffmpeg_output_error("Final export failed", &out));
                    }
                }
            } else {
                std::fs::copy(src, &output_path)
                    .map_err(|e| format!("Failed to write output: {}", e))?;
            }
        } else {
            // Concat multiple processed segments
            let all_audio = video_segments.iter().all(|s| {
                s.audio_only.unwrap_or(false) || is_audio_only_path(&s.path)
            });
            let list_path = temp_dir.join(format!("batch_concat_{}.txt", unique_id));
            let inter_ext = if all_audio { "m4a" } else { "mp4" };
            let intermediate =
                temp_dir.join(format!("batch_inter_{}.{}", unique_id, inter_ext));
            {
                use std::io::Write;
                let mut list_file =
                    std::fs::File::create(&list_path).map_err(|e| e.to_string())?;
                for p in &cleaned_paths {
                    let formatted = p.replace('\\', "/");
                    writeln!(list_file, "file '{}'", formatted).map_err(|e| e.to_string())?;
                }
                list_file.flush().map_err(|e| e.to_string())?;
                list_file.sync_all().map_err(|e| e.to_string())?;
            }

            let list_str = list_path.to_string_lossy().to_string();
            let inter_str = intermediate.to_string_lossy().to_string();

            // Try concat demuxer copy
            let mut lossless_ok = false;
            {
                let args = vec![
                    "-y".into(),
                    "-f".into(),
                    "concat".into(),
                    "-safe".into(),
                    "0".into(),
                    "-i".into(),
                    list_str.clone(),
                    "-c".into(),
                    "copy".into(),
                    inter_str.clone(),
                ];
                if let Ok(out) = tauri::async_runtime::block_on(
                    app.shell()
                        .sidecar("ffmpeg")
                        .map_err(|e| e.to_string())?
                        .args(args)
                        .output(),
                ) {
                    if out.status.success() {
                        lossless_ok = true;
                    }
                }
            }

            if !lossless_ok {
                // filter_complex concat with reencode
                let mut args = vec!["-y".to_string()];
                let mut fc = String::new();
                let n = cleaned_paths.len();
                if all_audio {
                    for (i, p) in cleaned_paths.iter().enumerate() {
                        args.push("-i".into());
                        args.push(p.clone());
                        fc.push_str(&format!("[{}:a]", i));
                    }
                    fc.push_str(&format!("concat=n={}:v=0:a=1[a]", n));
                    args.push("-filter_complex".into());
                    args.push(fc);
                    args.push("-map".into());
                    args.push("[a]".into());
                    args.extend([
                        "-c:a".into(),
                        "aac".into(),
                        "-b:a".into(),
                        "192k".into(),
                    ]);
                } else {
                    for (i, p) in cleaned_paths.iter().enumerate() {
                        args.push("-i".into());
                        args.push(p.clone());
                        if strip_audio {
                            fc.push_str(&format!("[{}:v]", i));
                        } else {
                            fc.push_str(&format!("[{}:v][{}:a]", i, i));
                        }
                    }
                    if strip_audio {
                        fc.push_str(&format!("concat=n={}:v=1:a=0[v]", n));
                    } else {
                        fc.push_str(&format!("concat=n={}:v=1:a=1[v][a]", n));
                    }
                    args.push("-filter_complex".into());
                    args.push(fc);
                    args.push("-map".into());
                    args.push("[v]".into());
                    if !strip_audio {
                        args.push("-map".into());
                        args.push("[a]".into());
                    }
                    args.extend([
                        "-c:v".into(),
                        "libx264".into(),
                        "-pix_fmt".into(),
                        "yuv420p".into(),
                        "-crf".into(),
                        crf.into(),
                        "-preset".into(),
                        preset.into(),
                    ]);
                    if !strip_audio {
                        args.extend([
                            "-c:a".into(),
                            "aac".into(),
                            "-b:a".into(),
                            "128k".into(),
                        ]);
                    } else {
                        args.push("-an".into());
                    }
                }
                args.push(inter_str.clone());
                let out = tauri::async_runtime::block_on(
                    app.shell()
                        .sidecar("ffmpeg")
                        .map_err(|e| e.to_string())?
                        .args(args)
                        .output(),
                )
                .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    let _ = std::fs::remove_file(&list_path);
                    for c in &temp_clips {
                        let _ = std::fs::remove_file(c);
                    }
                    return Err(format_ffmpeg_output_error("Concat failed", &out));
                }
            }

            // Final pass: quality + strip_audio to destination
            let mut fargs: Vec<String> = vec![
                "-y".into(),
                "-i".into(),
                inter_str.clone(),
            ];
            if all_audio {
                if prefer_copy {
                    fargs.extend(["-c".into(), "copy".into()]);
                } else {
                    fargs.extend([
                        "-c:a".into(),
                        "aac".into(),
                        "-b:a".into(),
                        "192k".into(),
                    ]);
                }
                fargs.push("-vn".into());
            } else if prefer_copy && !strip_audio {
                fargs.extend(["-c".into(), "copy".into()]);
            } else {
                fargs.extend([
                    "-c:v".into(),
                    "libx264".into(),
                    "-pix_fmt".into(),
                    "yuv420p".into(),
                    "-crf".into(),
                    crf.into(),
                    "-preset".into(),
                    preset.into(),
                ]);
                if strip_audio {
                    fargs.push("-an".into());
                } else {
                    fargs.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "128k".into()]);
                }
            }
            fargs.push(output_path.clone());
            let out = tauri::async_runtime::block_on(
                app.shell()
                    .sidecar("ffmpeg")
                    .map_err(|e| e.to_string())?
                    .args(fargs)
                    .output(),
            )
            .map_err(|e| e.to_string())?;

            let _ = std::fs::remove_file(&list_path);
            let _ = std::fs::remove_file(&intermediate);

            if !out.status.success() {
                for c in &temp_clips {
                    let _ = std::fs::remove_file(c);
                }
                return Err(format_ffmpeg_output_error("Final mux failed", &out));
            }
        }

        for c in &temp_clips {
            let _ = std::fs::remove_file(c);
        }

        Ok(output_path)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

#[tauri::command]
async fn get_waveform_data(
    app_handle: tauri::AppHandle,
    video_path: String,
    duration_seconds: f64,
) -> Result<Vec<i32>, String> {
    tokio::task::spawn_blocking(move || {
        tauri::async_runtime::block_on(async {
            let sidecar_probe = app_handle
                .shell()
                .sidecar("ffmpeg")
                .map_err(|e| format!("Failed to find sidecar: {}", e))?
                .args(["-i", &video_path]);

            let probe_output = sidecar_probe
                .output()
                .await
                .map_err(|e| format!("Failed to run probe: {}", e))?;

            let stderr_str = String::from_utf8_lossy(&probe_output.stderr);
            let has_audio = stderr_str.contains("Audio:");

            if !has_audio {
                // PATH B (Silent Video Fallback)
                let length = (duration_seconds * 60.0).round() as usize;
                let peaks = vec![5; length];
                return Ok(peaks);
            }

            // PATH A (Real Audio)
            let sidecar = app_handle
                .shell()
                .sidecar("ffmpeg")
                .map_err(|e| format!("Failed to find sidecar: {}", e))?;

            let sidecar_cmd = sidecar.args([
                "-i",
                &video_path,
                "-ac",
                "1",
                "-ar",
                "8000",
                "-f",
                "s8",
                "-acodec",
                "pcm_s8",
                "-",
            ]);

            let (mut rx, _child) = sidecar_cmd
                .spawn()
                .map_err(|e| format!("Failed to spawn ffmpeg: {}", e))?;

            let mut all_bytes = Vec::new();
            while let Some(event) = rx.recv().await {
                if let CommandEvent::Stdout(bytes) = event {
                    all_bytes.extend_from_slice(&bytes);
                }
            }

            if all_bytes.is_empty() {
                return Err("No audio data extracted".to_string());
            }

            let chunk_size = 128;
            let mut peaks = Vec::new();
            for chunk in all_bytes.chunks(chunk_size) {
                let mut max_val = 0u8;
                for &b in chunk {
                    let val = if b == i8::MIN as u8 {
                        127
                    } else {
                        (b as i8).unsigned_abs()
                    };
                    if val > max_val {
                        max_val = val;
                    }
                }
                let peak = (max_val as i32).min(127);
                peaks.push(peak);
            }

            Ok(peaks)
        })
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

/// Generate filmstrip tiles for a video.
/// Optional `start_seconds` / `end_seconds` limit sampling to [clipIn, clipOut]
/// so join segments do not stretch a full-file strip into a shorter slot.
#[tauri::command]
async fn generate_timeline_thumbnails(
    app_handle: tauri::AppHandle,
    video_path: String,
    tile_count: usize,
    start_seconds: Option<f64>,
    end_seconds: Option<f64>,
) -> Result<Vec<String>, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let app_handle_clone = app_handle.clone();
    let tile_count = tile_count.max(1);
    tokio::task::spawn_blocking(move || {
        // Helper function to extract native duration using ffmpeg -i
        let get_duration = |path: &str| -> Option<f64> {
            if let Ok(sidecar) = app_handle_clone.shell().sidecar("ffmpeg") {
                let sidecar = sidecar.args(["-i", path]);
                if let Ok(output) = tauri::async_runtime::block_on(sidecar.output()) {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    if let Some(pos) = stderr.find("Duration: ") {
                        let sub = &stderr[pos + 10..];
                        if sub.len() >= 11 {
                            let parts: Vec<&str> = sub[..11].split(':').collect();
                            if parts.len() == 3 {
                                let hours: f64 = parts[0].parse().unwrap_or(0.0);
                                let minutes: f64 = parts[1].parse().unwrap_or(0.0);
                                let seconds: f64 = parts[2].parse().unwrap_or(0.0);
                                return Some(hours * 3600.0 + minutes * 60.0 + seconds);
                            }
                        }
                    }
                }
            }
            None
        };

        let total_duration_seconds = get_duration(&video_path).unwrap_or(10.0);
        let start = start_seconds.unwrap_or(0.0).max(0.0).min(total_duration_seconds);
        let end = end_seconds
            .unwrap_or(total_duration_seconds)
            .max(start)
            .min(total_duration_seconds);
        // Guard zero-length range
        let end = if end <= start {
            (start + 0.1).min(total_duration_seconds.max(start + 0.1))
        } else {
            end
        };
        let segment_duration = (end - start).max(0.05);
        let interval_step = segment_duration / (tile_count as f64);
        let dynamic_fps_filter = format!("fps=1/{},scale=120:-1", interval_step);

        // Per-video+range cache so full-file and segment strips never collide
        let mut hasher = DefaultHasher::new();
        video_path.hash(&mut hasher);
        // Quantize range into cache key (ms)
        ((start * 1000.0).round() as i64).hash(&mut hasher);
        ((end * 1000.0).round() as i64).hash(&mut hasher);
        (tile_count as u64).hash(&mut hasher);
        let path_hash = format!("{:x}", hasher.finish());

        let cache_path = app_handle_clone
            .path()
            .app_cache_dir()
            .map_err(|e| format!("Failed to get app cache dir: {}", e))?
            .join("lsvideo_thumbnails")
            .join(&path_hash);

        // Ensure the per-video directory is created if missing
        std::fs::create_dir_all(&cache_path)
            .map_err(|e| format!("Failed to create thumbnail directory: {}", e))?;

        // Clear only JPGs in this range subdir (never wipe sibling video caches)
        if let Ok(entries) = std::fs::read_dir(&cache_path) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "jpg") {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }

        let cache_path_string = cache_path.to_string_lossy().to_string();
        let start_str = format!("{:.3}", start);
        let dur_str = format!("{:.3}", segment_duration);
        let out_pattern = format!("{}/thumb_%04d.jpg", cache_path_string);

        // -ss before -i for faster seek; -t limits decode to the segment window
        let sidecar = app_handle_clone
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("Failed to find sidecar: {}", e))?
            .args([
                "-ss",
                &start_str,
                "-i",
                &video_path,
                "-t",
                &dur_str,
                "-vf",
                &dynamic_fps_filter,
                "-q:v",
                "5",
                &out_pattern,
            ]);

        // Wait for the ffmpeg execution pipeline child process to terminate successfully
        let output = tauri::async_runtime::block_on(sidecar.output())
            .map_err(|e| format!("Failed to run sidecar: {}", e))?;

        if !output.status.success() {
            return Err(format_ffmpeg_output_error("FFmpeg failed", &output));
        }

        // Scan only this range's subdir sequentially
        let mut thumbnails = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&cache_path) {
            let mut entry_paths = Vec::new();
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "jpg") {
                    entry_paths.push(path);
                }
            }

            // Sort sequentially (thumb_0001.jpg, thumb_0002.jpg, etc.)
            entry_paths.sort();

            for path in entry_paths {
                thumbnails.push(path.to_string_lossy().to_string());
            }
        }

        Ok(thumbnails)
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

#[tauri::command]
fn save_vtt_file(video_path: String, vtt_text: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;
    let path = Path::new(&video_path);
    let vtt_path = path.with_extension("vtt");
    fs::write(&vtt_path, vtt_text)
        .map_err(|err| format!("Failed to write VTT subtitle file to disk: {}", err))?;
    Ok(vtt_path.to_string_lossy().into_owned())
}

/// Remove the app-cache proxy file for a source path (same hash as verify_and_prepare_video).
/// No-op if no proxy exists. Does not delete the original source media.
#[tauri::command]
async fn delete_proxy_for_video(
    app_handle: tauri::AppHandle,
    video_path: String,
) -> Result<bool, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::path::Path;

    if video_path.trim().is_empty() {
        return Ok(false);
    }

    let mut hasher = DefaultHasher::new();
    video_path.hash(&mut hasher);
    let hash_value = hasher.finish();
    let proxy_filename = format!("proxy_{:x}.mp4", hash_value);

    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?;
    let proxy_path = cache_dir.join(&proxy_filename);

    if proxy_path.exists() {
        std::fs::remove_file(&proxy_path)
            .map_err(|e| format!("Failed to delete proxy cache file: {}", e))?;
        println!(
            "[Proxy Core] Deleted proxy cache for source: {} -> {}",
            video_path,
            proxy_path.display()
        );
        return Ok(true);
    }
    // Also try deleting an explicit proxy path if the frontend stored one under app cache
    let explicit = Path::new(&video_path);
    if let Some(name) = explicit.file_name().and_then(|n| n.to_str()) {
        if name.starts_with("proxy_") && explicit.exists() {
            if let (Ok(cache_canon), Ok(file_canon)) =
                (cache_dir.canonicalize(), explicit.canonicalize())
            {
                if file_canon.starts_with(&cache_canon) {
                    let _ = std::fs::remove_file(&file_canon);
                    return Ok(true);
                }
            }
        }
    }
    Ok(false)
}

#[tauri::command]
async fn verify_and_prepare_video(
    app_handle: tauri::AppHandle,
    video_path: String,
) -> Result<String, String> {
    use std::collections::hash_map::DefaultHasher;
    use std::fs;
    use std::hash::{Hash, Hasher};
    use std::path::Path;

    let path = Path::new(&video_path);

    // 1. Structural Sanity Check: Ensure the path is completely absolute and exists
    if !path.is_absolute() {
        return Err(
            "Security Violation: Rejected un-normalized relative path trajectory.".to_string(),
        );
    }
    if !path.exists() {
        return Err("Target media file path does not exist on disk".to_string());
    }

    // 2. Extension Validation: Whitelist valid media containers to drop script text-manifest entries (.vtt, .m3u8)
    let ext = if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        let normalized_ext = ext.to_lowercase();
        let valid_extensions = vec![
            "mp4", "mkv", "avi", "wmv", "flv", "mov", "webm", // Videos
            "mp3", "wav", "m4a", "ogg", "aac", // Audio
        ];
        if !valid_extensions.contains(&normalized_ext.as_str()) {
            return Err(format!(
                "Security Violation: Blocked processing for non-whitelisted container format: .{}",
                normalized_ext
            ));
        }
        normalized_ext
    } else {
        return Err(
            "Rejected media tracking target with missing file format parameters.".to_string(),
        );
    };

    let is_audio = matches!(ext.as_str(), "mp3" | "wav" | "m4a" | "ogg" | "aac" | "flac");
    if is_audio {
        println!(
            "[Proxy Backend] Audio file detected ({}); skipping video proxy pipeline.",
            ext
        );
        return Ok(video_path);
    }

    let is_unsafe_container = matches!(ext.as_str(), "avi" | "mkv" | "wmv" | "flv");

    // 3. Probe the video metadata using the bundled static ffmpeg sidecar binary
    // Running input query without destination targets sends stream information directly to stderr
    let output = app_handle
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("FFmpeg sidecar component mapping failure: {}", e))?
        .args(["-i", &video_path])
        .output()
        .await
        .map_err(|e| format!("Failed to initialize command thread execution: {}", e))?;

    // Convert stderr to lowercase for case-insensitive codec scan
    let stderr_lowercase = String::from_utf8_lossy(&output.stderr).to_lowercase();

    println!(
        "[Proxy Backend] FFmpeg probe trace final output length: {} bytes",
        stderr_lowercase.len()
    );

    // Detect HEVC only from codec-bearing lines / tags — avoid bare "hevc"/"x265"
    // matches buried in unrelated stderr text (paths, titles, library banners).
    let is_h265 = {
        let mut hit: Option<&'static str> = None;
        for line in stderr_lowercase.lines() {
            let line = line.trim();
            // FFmpeg stream dump: "Stream #0:0: Video: hevc (Main)..." / "Video: h264"
            let is_video_line = line.contains("video:") || line.contains("video :");
            if !is_video_line {
                continue;
            }
            if line.contains("hevc")
                || line.contains("h265")
                || line.contains("hev1")
                || line.contains("hvc1")
            {
                hit = Some("video-line hevc/h265/hev1/hvc1");
                break;
            }
            // Explicit H.264/AVC on a Video: line — keep scanning for another HEVC stream
            if line.contains("h264") || line.contains("avc1") || line.contains(" avc ") {
                println!("[Proxy Backend] Probe saw H.264/AVC video line (non-HEVC candidate)");
            }
        }
        if hit.is_none() {
            if stderr_lowercase.contains("video: hevc")
                || stderr_lowercase.contains("video: h265")
            {
                hit = Some("video: hevc|h265");
            } else if stderr_lowercase.contains("codec_name=hevc")
                || stderr_lowercase.contains("codec_name=h265")
            {
                hit = Some("codec_name=hevc|h265");
            } else if stderr_lowercase.contains("(hevc)")
                || stderr_lowercase.contains("(h265)")
            {
                // Parenthesized codec id next to stream metadata — still reasonably specific
                hit = Some("codec-tag (hevc)|(h265)");
            }
        }
        if let Some(branch) = hit {
            println!("[Proxy Backend] HEVC branch fired: {}", branch);
            true
        } else {
            false
        }
    };

    // WebView-safe video codecs: only trust Video: stream lines (same gate as HEVC).
    // If probe stderr is tiny/garbled and no safe codec is confirmed, force proxy so
    // WebView never gets DEMUXER_ERROR_NO_SUPPORTED_STREAMS on unknown HEVC-like files.
    let is_web_safe_video = {
        let mut safe = false;
        for line in stderr_lowercase.lines() {
            let line = line.trim();
            let is_video_line = line.contains("video:") || line.contains("video :");
            if !is_video_line {
                continue;
            }
            if line.contains("h264")
                || line.contains("avc1")
                || line.contains(" avc ")
                || line.contains("vp8")
                || line.contains("vp9")
                || line.contains("av1")
            {
                safe = true;
                break;
            }
        }
        safe
    };

    let needs_proxy = is_h265 || is_unsafe_container || !is_web_safe_video;

    // Direct playback compatible formats (e.g. H.264 MP4/WebM): return original path
    if !needs_proxy {
        println!(
            "[Proxy Backend] Target container '.{}' and video codec are compatible for direct playback. Returning original path; no proxy.",
            ext
        );
        return Ok(video_path);
    }

    // Log which proxy branch(es) fired (hevc / unsafe container / not web-safe)
    if is_h265 {
        println!("[Proxy Backend] Proxy branch: hevc");
    }
    if is_unsafe_container {
        println!(
            "[Proxy Backend] Proxy branch: unsafe container (.{})",
            ext
        );
    }
    if !is_web_safe_video {
        println!(
            "[Proxy Backend] Proxy branch: not web-safe (no h264/avc1/avc/vp8/vp9/av1 Video: line)"
        );
    }
    println!(
        "[Proxy Backend] Media file requires proxy (container: '.{}', is_h265: {}, is_web_safe_video: {}). Initiating proxy sequence...",
        ext, is_h265, is_web_safe_video
    );

    // Generate a collision-free unique proxy filename
    let mut hasher = DefaultHasher::new();
    video_path.hash(&mut hasher);
    let hash_value = hasher.finish();
    let proxy_filename = format!("proxy_{:x}.mp4", hash_value);

    let cache_dir = app_handle.path().app_cache_dir().map_err(|e| {
        format!(
            "System environment failed to map absolute local cache boundaries: {}",
            e
        )
    })?;

    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir)
            .map_err(|e| format!("Failed to create storage folder cache matrices: {}", e))?;
    }

    let proxy_destination_path = cache_dir.join(&proxy_filename);
    let proxy_path_str = proxy_destination_path.to_string_lossy().to_string();

    // Reject tiny / corrupt cached proxies so a bad encode cannot stick forever
    const MIN_PROXY_BYTES: u64 = 64_000;
    if proxy_destination_path.exists() {
        match fs::metadata(&proxy_destination_path) {
            Ok(meta) if meta.len() >= MIN_PROXY_BYTES => {
                println!(
                    "[Proxy Core] Valid cached proxy ({} bytes). Skipping re-encode.",
                    meta.len()
                );
            }
            Ok(meta) => {
                println!(
                    "[Proxy Core] Cached proxy too small ({} bytes < {}). Deleting and re-encoding.",
                    meta.len(),
                    MIN_PROXY_BYTES
                );
                let _ = fs::remove_file(&proxy_destination_path);
            }
            Err(e) => {
                println!(
                    "[Proxy Core] Could not stat cached proxy ({}); deleting and re-encoding.",
                    e
                );
                let _ = fs::remove_file(&proxy_destination_path);
            }
        }
    }

    // Build proxy if missing (or just deleted as invalid)
    if !proxy_destination_path.exists() {
        let _ = app_handle.emit("transcode-needed", ());
        println!(
            "[Proxy Core] Encoding clean proxy container instance to location: {}",
            proxy_path_str
        );

        let transcode_output = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|e| format!("FFmpeg sidecar instance context invalid: {}", e))?
            .args([
                "-i",
                &video_path,
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-y",
                &proxy_path_str,
            ])
            .output()
            .await
            .map_err(|e| format!("Transcode pipeline execution faulted: {}", e))?;

        if !transcode_output.status.success() {
            return Err(
                "FFmpeg process mapping failed to finalize stream conversion cleanly".to_string(),
            );
        }

        // Validate newly written proxy before returning it
        match fs::metadata(&proxy_destination_path) {
            Ok(meta) if meta.len() >= MIN_PROXY_BYTES => {
                println!(
                    "[Proxy Core] Transcoding finished successfully ({} bytes).",
                    meta.len()
                );
            }
            Ok(meta) => {
                let _ = fs::remove_file(&proxy_destination_path);
                return Err(format!(
                    "Proxy encode produced undersized file ({} bytes); refusing to use it",
                    meta.len()
                ));
            }
            Err(e) => {
                return Err(format!(
                    "Proxy encode finished but output is unreadable: {}",
                    e
                ));
            }
        }
    }

    let clean_proxy_path = proxy_path_str.replace("\\\\?\\", "");
    println!(
        "[Proxy Core] Returning sanitized proxy path to frontend: {}",
        clean_proxy_path
    );
    Ok(clean_proxy_path)
}

async fn clear_old_proxy_caches(app_handle: tauri::AppHandle) -> std::io::Result<()> {
    if let Ok(cache_dir) = app_handle.path().app_cache_dir() {
        if let Ok(mut entries) = tokio::fs::read_dir(cache_dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(file_type) = entry.file_type().await {
                    if file_type.is_file() {
                        let path = entry.path();
                        if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                            if file_name.starts_with("proxy_") {
                                if let Ok(metadata) = entry.metadata().await {
                                    if let Ok(modified) = metadata.modified() {
                                        if let Ok(elapsed) = modified.elapsed() {
                                            // If the proxy file hasn't been accessed/modified in 7 days, purge it
                                            if elapsed.as_secs() > 7 * 24 * 3600 {
                                                let _ = tokio::fs::remove_file(&path).await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
    .manage(FfmpegState(Mutex::new(None)))
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
  let app_handle = app.handle().clone();
  tauri::async_runtime::spawn(async move {
      let _ = clear_old_proxy_caches(app_handle).await;
  });
  if cfg!(debug_assertions) {
    app.handle().plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )?;
  }
  Ok(())
})
     // Add this line to register your new commands:
    .invoke_handler(tauri::generate_handler![
        get_startup_file,
        get_launch_argument,
        run_ffmpeg, abort_ffmpeg,
        save_tspz_bundle,
        load_tspz_bundle,
        resolve_subtitles,
        join_and_compress_videos,
        export_queue_job,
        get_waveform_data,
        generate_timeline_thumbnails,
        save_vtt_file,
        verify_and_prepare_video,
        delete_proxy_for_video
        ])
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        let state = window.state::<FfmpegState>();
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(child) = guard.take() {
          let _ = child.kill();
          println!("[Cleanup] Terminated background FFmpeg sidecar process on window destruction.");
        }
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
