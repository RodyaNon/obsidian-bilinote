#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Command line entry for Obsidian and local automation."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True, write_through=True)
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True, write_through=True)

def _write_cookie_file(sessdata: Optional[str], bili_jct: Optional[str], buvid3: Optional[str]) -> Optional[str]:
    pairs = {
        "sessdata": sessdata,
        "bili_jct": bili_jct,
        "buvid3": buvid3,
    }
    if not any(pairs.values()):
        return None

    fd, path = tempfile.mkstemp(prefix="bilinote-cookie-", suffix=".txt")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as f:
        for key, value in pairs.items():
            if value:
                f.write(f"{key}={value}\n")
    return path


def _unique_destination(directory: Path, filename: str) -> Path:
    destination = directory / filename
    if not destination.exists():
        return destination

    stem = destination.stem
    suffix = destination.suffix
    counter = 2
    while True:
        candidate = directory / f"{stem}-{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _copy_notes(markdown_files: List[str], notes_output: Optional[str]) -> List[str]:
    if not notes_output:
        return []

    output_dir = Path(notes_output).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    copied: List[str] = []
    for markdown_file in markdown_files:
        source = Path(markdown_file)
        if not source.exists():
            continue
        destination = output_dir / source.name
        shutil.copy2(source, destination)
        copied.append(str(destination))
    return copied


def _build_generate_options(args: argparse.Namespace) -> Dict[str, bool]:
    return {
        "summary": not args.no_summary,
        "full_content": not args.no_content,
        "exercises": False,
        "questions": False,
    }


def _load_prompt_config(path_value: Optional[str]) -> Dict[str, Any]:
    if not path_value:
        return {}
    path = Path(path_value).expanduser().resolve()
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("prompt 配置必须是 JSON 对象。")
    return data


def _positive_int(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _expand_urls(
    urls: List[str],
    cookies_file: str,
    start_index: Optional[int] = None,
    end_index: Optional[int] = None,
) -> Tuple[List[str], bool]:
    from bilibili_subtitle_downloader import BilibiliSubtitleDownloader, load_cookies_from_file

    cookies = load_cookies_from_file(cookies_file)
    downloader = BilibiliSubtitleDownloader(
        sessdata=cookies.get("sessdata"),
        bili_jct=cookies.get("bili_jct"),
        buvid3=cookies.get("buvid3"),
    )

    expanded: List[str] = []
    consumed_range = False
    for url in urls:
        url = (url or "").strip()
        if not url:
            continue
        if downloader.is_favorite_url(url):
            fid = downloader.extract_fid(url)
            if fid:
                videos = downloader.get_favorite_videos(fid, max_count=end_index)
                if not videos:
                    raise ValueError("收藏夹未获取到视频。请确认 URL 中包含正确的 fid，且 Cookie 有权限访问该收藏夹。")
                start = (start_index or 1) - 1
                selected = videos[start:end_index] if (start_index or end_index) else videos
                expanded.extend(f"https://www.bilibili.com/video/{video['bvid']}" for video in selected if video.get("bvid"))
                consumed_range = consumed_range or bool(start_index or end_index)
                continue
        expanded.append(url)
    if not expanded:
        raise ValueError("未解析到有效的视频 URL。请检查输入的网址。")
    return expanded, consumed_range


def _expand_video_parts(
    urls: List[str],
    cookies_file: str,
    start_index: Optional[int] = None,
    end_index: Optional[int] = None,
) -> List[str]:
    from bilibili_subtitle_downloader import BilibiliSubtitleDownloader, load_cookies_from_file

    cookies = load_cookies_from_file(cookies_file)
    downloader = BilibiliSubtitleDownloader(
        sessdata=cookies.get("sessdata"),
        bili_jct=cookies.get("bili_jct"),
        buvid3=cookies.get("buvid3"),
    )

    expanded: List[str] = []
    for url in urls:
        bvid = downloader.extract_bvid(url)
        if not bvid:
            expanded.append(url)
            continue

        video_info = downloader.get_video_info(bvid)
        if not video_info:
            expanded.append(url)
            continue

        pages: List[Dict[str, Any]] = []
        sections = video_info.get("ugc_season", {}).get("sections") or []
        if sections:
            for section in sections:
                for episode in section.get("episodes") or []:
                    episode_pages = episode.get("pages") or []
                    if len(episode_pages) > 1:
                        for page in episode_pages:
                            pages.append({
                                "bvid": episode.get("bvid") or bvid,
                                "page": page.get("page"),
                            })
                    else:
                        pages.append({
                            "bvid": episode.get("bvid") or bvid,
                            "page": episode.get("page", {}).get("page") or 1,
                        })
        else:
            for page in video_info.get("pages") or []:
                pages.append({
                    "bvid": bvid,
                    "page": page.get("page"),
                })

        if not pages:
            expanded.append(url)
            continue

        start = max((start_index or 1) - 1, 0)
        end = end_index if end_index and end_index > 0 else None
        for page in pages[start:end]:
            page_bvid = page.get("bvid") or bvid
            page_number = page.get("page") or 1
            part_url = f"https://www.bilibili.com/video/{page_bvid}"
            if page_bvid == bvid and page_number > 1:
                part_url = f"{part_url}?p={page_number}"
            expanded.append(part_url)

    return expanded or urls


def generate(args: argparse.Namespace) -> int:
    from pipeline import PipelineJob, iter_generated_markdown, run_pipeline

    start_index = _positive_int(args.start_index)
    end_index = _positive_int(args.end_index)
    max_workers = _positive_int(args.max_workers) or 1
    cookie_override = _write_cookie_file(args.sessdata, args.bili_jct, args.buvid3)
    cookies_file = cookie_override or args.cookies_file

    try:
        expanded_urls, range_consumed_by_url_expansion = _expand_urls(args.urls, cookies_file, start_index, end_index)
        download_all_parts = args.download_all_parts
        job_start_index = None if range_consumed_by_url_expansion else start_index
        job_end_index = None if range_consumed_by_url_expansion else end_index
        if args.download_all_parts and max_workers > 1:
            part_urls = _expand_video_parts(expanded_urls, cookies_file, start_index, end_index)
            if len(part_urls) > len(expanded_urls):
                expanded_urls = part_urls
                download_all_parts = False
                job_start_index = None
                job_end_index = None
        job = PipelineJob(
            urls=expanded_urls,
            output_dir=args.output,
            model_name=args.model_name,
            cookies_file=cookies_file,
            workspace_name=args.workspace_name,
            download_all_parts=download_all_parts,
            max_parts=None,
            start_index=job_start_index,
            end_index=job_end_index,
            asr_model_size=args.asr_model_size,
            asr_device=args.asr_device,
            asr_compute_type=args.asr_compute_type,
            max_workers=max_workers,
            generate_options=_build_generate_options(args),
            prompt_config=_load_prompt_config(args.prompt_config),
            ffmpeg_path=args.ffmpeg_path,
        )
        result = run_pipeline(job)
        markdown_files = list(iter_generated_markdown(result["results"]))
        copied_notes = _copy_notes(markdown_files, args.notes_output)
        result["markdown_files"] = [str(Path(path).resolve()) for path in markdown_files]
        result["copied_notes"] = copied_notes

        if args.result_file:
            result_path = Path(args.result_file).expanduser().resolve()
            result_path.parent.mkdir(parents=True, exist_ok=True)
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"结果文件: {result_path}")
        else:
            print("__AI_LEARNING_RESULT_START__")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            print("__AI_LEARNING_RESULT_END__")
        return 0 if result["success"] else 1
    finally:
        if cookie_override:
            try:
                os.remove(cookie_override)
            except OSError:
                pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AI Learning Assistant CLI")
    subparsers = parser.add_subparsers(dest="command")

    generate_parser = subparsers.add_parser("generate", help="Generate learning notes from Bilibili videos")
    generate_parser.add_argument("urls", nargs="+", help="Bilibili video URLs")
    generate_parser.add_argument("-o", "--output", default="subtitles", help="Project output root")
    generate_parser.add_argument("--notes-output", default=None, help="Folder where Markdown notes should be copied")
    generate_parser.add_argument("--result-file", default=None, help="Write machine-readable result JSON to this file instead of stdout")
    generate_parser.add_argument("--workspace-name", default=None, help="Workspace/course folder name under output")
    generate_parser.add_argument("-n", "--model-name", default=None, help="Model name from config/llm_models.json")
    generate_parser.add_argument("--cookies-file", default="cookies.txt", help="Cookie file path")
    generate_parser.add_argument("--sessdata", default=None, help="Bilibili SESSDATA")
    generate_parser.add_argument("--bili-jct", default=None, help="Bilibili bili_jct")
    generate_parser.add_argument("--buvid3", default=None, help="Bilibili buvid3")
    generate_parser.add_argument("--ffmpeg-path", default=None, help="ffmpeg executable path")
    generate_parser.add_argument("--start-index", default=None, help="Start index for favorite lists, collections, or multi-part videos (1-based)")
    generate_parser.add_argument("--end-index", default=None, help="End index for favorite lists, collections, or multi-part videos (inclusive)")
    generate_parser.add_argument("--max-workers", default="1", help="Maximum number of videos to process concurrently")
    generate_parser.add_argument("--asr-model-size", default="small", help="Local ASR model size: tiny/base/small/medium/large-v3")
    generate_parser.add_argument("--asr-device", default="auto", help="Local ASR device: auto/cpu/cuda")
    generate_parser.add_argument("--asr-compute-type", default="auto", help="Local ASR compute type: auto/int8/float16/float32")
    generate_parser.add_argument("--prompt-config", default=None, help="JSON file containing prompt mode and rules")
    generate_parser.add_argument("--download-all-parts", action="store_true", help="Download all video parts")
    generate_parser.add_argument("--no-summary", action="store_true", help="Skip knowledge point summary")
    generate_parser.add_argument("--no-content", action="store_true", help="Skip Markdown content")
    generate_parser.set_defaults(func=generate)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not hasattr(args, "func"):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except Exception as error:
        payload = {
            "success": False,
            "error": str(error),
            "traceback": traceback.format_exc(),
            "results": [],
        }
        result_file = getattr(args, "result_file", None)
        if result_file:
            result_path = Path(result_file).expanduser().resolve()
            result_path.parent.mkdir(parents=True, exist_ok=True)
            result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"结果文件: {result_path}")
        else:
            print("__AI_LEARNING_RESULT_START__")
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            print("__AI_LEARNING_RESULT_END__")
        return 1


if __name__ == "__main__":
    sys.exit(main())
