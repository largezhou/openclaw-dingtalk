import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

const FFPROBE_TIMEOUT_MS = 10_000;
const FFMPEG_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

// ======================= ffmpeg 检测 =======================

let ffmpegAvailable: boolean | null = null;

/**
 * 检测系统是否安装了 ffmpeg 和 ffprobe
 * 结果会被缓存，只检测一次
 */
export function hasFFmpeg(): boolean {
  if (ffmpegAvailable !== null) {
    return ffmpegAvailable;
  }

  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];

  let foundFfmpeg = false;
  let foundFfprobe = false;

  for (const dir of parts) {
    for (const ext of extensions) {
      if (!foundFfmpeg) {
        try {
          fs.accessSync(path.join(dir, `ffmpeg${ext}`), fs.constants.X_OK);
          foundFfmpeg = true;
        } catch { /* keep scanning */ }
      }
      if (!foundFfprobe) {
        try {
          fs.accessSync(path.join(dir, `ffprobe${ext}`), fs.constants.X_OK);
          foundFfprobe = true;
        } catch { /* keep scanning */ }
      }
      if (foundFfmpeg && foundFfprobe) break;
    }
    if (foundFfmpeg && foundFfprobe) break;
  }

  ffmpegAvailable = foundFfmpeg && foundFfprobe;

  if (ffmpegAvailable) {
    logger.log("[ffmpeg] 检测到 ffmpeg 和 ffprobe 已安装");
  } else {
    logger.log(`[ffmpeg] 未检测到 ffmpeg/ffprobe（ffmpeg: ${foundFfmpeg}, ffprobe: ${foundFfprobe}）`);
  }

  return ffmpegAvailable;
}

// ======================= ffprobe 探测 =======================

async function runFfprobe(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("ffprobe", args, {
    timeout: FFPROBE_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return stdout.toString();
}

async function runFfmpeg(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("ffmpeg", args, {
    timeout: FFMPEG_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES,
  });
  return stdout.toString();
}

/**
 * 获取音频/视频的时长（毫秒）
 * @param filePath - 本地文件路径
 * @returns 时长（毫秒），整数
 */
export async function getMediaDuration(filePath: string): Promise<number> {
  const stdout = await runFfprobe([
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    filePath,
  ]);
  const durationSec = parseFloat(stdout.trim());
  if (isNaN(durationSec)) {
    throw new Error(`无法解析时长: ${stdout.trim()}`);
  }
  return Math.round(durationSec * 1000);
}

/**
 * 获取视频的宽高
 * @param filePath - 本地文件路径
 * @returns { width, height }
 */
export async function getVideoResolution(filePath: string): Promise<{ width: number; height: number }> {
  const stdout = await runFfprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0:s=x",
    filePath,
  ]);
  const match = stdout.trim().match(/^(\d+)x(\d+)/);
  if (!match) {
    throw new Error(`无法解析视频分辨率: ${stdout.trim()}`);
  }
  return { width: parseInt(match[1], 10), height: parseInt(match[2], 10) };
}

/**
 * 提取视频的第一帧作为封面图
 * @param videoPath - 本地视频文件路径
 * @returns 封面图片的 Buffer（JPEG 格式）
 */
export async function extractVideoCover(videoPath: string): Promise<Buffer> {
  const tmpDir = os.tmpdir();
  const coverPath = path.join(tmpDir, `dingtalk-cover-${crypto.randomUUID()}.jpg`);

  try {
    await runFfmpeg([
      "-y",
      "-i", videoPath,
      "-vframes", "1",
      "-q:v", "2",
      "-f", "image2",
      coverPath,
    ]);

    const buffer = fs.readFileSync(coverPath);
    return buffer;
  } finally {
    // 清理临时文件
    try {
      fs.unlinkSync(coverPath);
    } catch { /* ignore */ }
  }
}

export interface MediaProbeResult {
  /** 时长（毫秒），整数 */
  duration: number;
  /** 视频分辨率（仅视频有） */
  width?: number;
  height?: number;
  /** 视频封面图 Buffer（仅视频有） */
  coverBuffer?: Buffer;
}

/**
 * 将 Buffer 写入临时文件，执行探测，然后清理
 * @param buffer - 媒体文件内容
 * @param fileName - 文件名（用于扩展名推断）
 * @param type - 媒体类型 "voice" | "video"
 */
export async function probeMediaBuffer(
  buffer: Buffer,
  fileName: string,
  type: "voice" | "video"
): Promise<MediaProbeResult> {
  const ext = path.extname(fileName) || (type === "video" ? ".mp4" : ".mp3");
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `dingtalk-probe-${crypto.randomUUID()}${ext}`);

  fs.writeFileSync(tmpPath, buffer);

  try {
    const duration = await getMediaDuration(tmpPath);
    const result: MediaProbeResult = { duration };

    if (type === "video") {
      try {
        const { width, height } = await getVideoResolution(tmpPath);
        result.width = width;
        result.height = height;
      } catch (err) {
        logger.warn(`[ffmpeg] 获取视频分辨率失败: ${err}`);
      }

      try {
        result.coverBuffer = await extractVideoCover(tmpPath);
      } catch (err) {
        logger.warn(`[ffmpeg] 提取视频封面失败: ${err}`);
      }
    }

    return result;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }
  }
}
