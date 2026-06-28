#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Core video processing used by the Obsidian plugin and CLI."""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime
from typing import Dict, Optional

from bilibili_subtitle_downloader import BilibiliSubtitleDownloader, load_cookies_from_file
from llm_client import OpenAICompatClient
from subtitle_summarizer import SRTParser, SubtitleSummarizer, load_llm_config


tasks: Dict[str, Dict] = {}
tasks_lock = threading.Lock()


class TaskStatus:
    PENDING = "pending"
    DOWNLOADING = "downloading"
    SUMMARIZING = "summarizing"
    COMPLETED = "completed"
    FAILED = "failed"
    STOPPING = "stopping"
    STOPPED = "stopped"


def is_valid_content(filepath: str) -> bool:
    return os.path.exists(filepath) and os.path.getsize(filepath) > 100


def is_valid_exercises(filepath: str) -> bool:
    if not os.path.exists(filepath):
        return False
    try:
        with open(filepath, "r", encoding="utf-8") as file:
            data = json.load(file)
        return bool(data.get("multiple_choice") or data.get("short_answer"))
    except Exception:
        return False


def is_valid_questions(filepath: str) -> bool:
    if not os.path.exists(filepath):
        return False
    try:
        with open(filepath, "r", encoding="utf-8") as file:
            data = json.load(file)
        return bool(data)
    except Exception:
        return False


def _set_task(task_id: str, **updates) -> None:
    with tasks_lock:
        tasks.setdefault(task_id, {}).update(updates)


def _is_stopped(task_id: str) -> bool:
    with tasks_lock:
        task = tasks.setdefault(task_id, {})
        if task.get("stop_flag"):
            task["status"] = TaskStatus.STOPPED
            task["message"] = "任务已停止"
            return True
    return False


def process_video_task(
    task_id: str,
    thread_name: str,
    url: str,
    output_dir: str,
    model_name: Optional[str],
    cookies_file: str,
    custom_folder_name: Optional[str] = None,
    download_all_parts: bool = False,
    generate_options: Optional[Dict[str, bool]] = None,
    prompt_config: Optional[Dict[str, str]] = None,
    ffmpeg_path: Optional[str] = None,
    max_parts: Optional[int] = None,
    start_index: Optional[int] = None,
    end_index: Optional[int] = None,
    asr_model_size: str = "small",
    asr_device: str = "auto",
    asr_compute_type: str = "auto",
) -> None:
    """Download subtitles and generate Markdown notes for one video task."""
    if generate_options is None:
        generate_options = {
            "summary": True,
            "full_content": True,
            "exercises": False,
            "questions": False,
        }

    try:
        if _is_stopped(task_id):
            return

        _set_task(
            task_id,
            status=TaskStatus.DOWNLOADING,
            message=f"正在下载字幕: {url}",
        )

        config_cookies = load_cookies_from_file(cookies_file)
        downloader = BilibiliSubtitleDownloader(
            sessdata=config_cookies.get("sessdata"),
            bili_jct=config_cookies.get("bili_jct"),
            buvid3=config_cookies.get("buvid3"),
            debug=False,
            ffmpeg_path=ffmpeg_path,
        )

        download_result = downloader.download(
            video_url=url,
            video_index=thread_name,
            output_dir=output_dir,
            format_type="srt",
            language="zh-CN",
            download_cover=True,
            custom_folder_name=custom_folder_name,
            download_all_parts=download_all_parts,
            max_parts=max_parts,
            start_index=start_index,
            end_index=end_index,
            asr_model_size=asr_model_size,
            asr_device=asr_device,
            asr_compute_type=asr_compute_type,
        )

        downloaded_files = download_result.get("subtitles", [])
        cover_path = download_result.get("cover")
        video_title = download_result.get("title", "")
        video_dir = download_result.get("video_dir", output_dir)

        if not downloaded_files:
            download_error = download_result.get("error")
            if download_error:
                raise RuntimeError(download_error)
            raise RuntimeError("视频没有字幕，无法生成笔记")

        if _is_stopped(task_id):
            return

        _set_task(task_id, video_dir=video_dir, video_title=video_title)

        model_config = load_llm_config("config/llm_models.json", model_name=model_name)
        llm_client = OpenAICompatClient(
            api_base=model_config["api_base"],
            api_key=model_config["api_key"],
            default_model=model_config["model_name"],
            request_timeout=500,
        )
        summarizer = SubtitleSummarizer(llm_client)

        all_generated_files = []
        total_files = len(downloaded_files)
        for file_index, subtitle_file in enumerate(downloaded_files, 1):
            if _is_stopped(task_id):
                return

            current_video_dir = os.path.dirname(subtitle_file) or video_dir
            subtitle_filename = os.path.basename(subtitle_file)
            subtitle_name = os.path.splitext(subtitle_filename)[0]
            subtitle_title = subtitle_name.rsplit("_", 1)[0] if "_" in subtitle_name else subtitle_name

            plain_text_file = os.path.join(current_video_dir, f"{subtitle_title}.txt")
            markdown_file = os.path.join(current_video_dir, f"{subtitle_title}.md")

            if os.path.exists(plain_text_file) and os.path.getsize(plain_text_file) > 0:
                with open(plain_text_file, "r", encoding="utf-8") as file:
                    plain_text = file.read()
            else:
                plain_text = SRTParser.extract_plain_text(subtitle_file)
                with open(plain_text_file, "w", encoding="utf-8") as file:
                    file.write(plain_text)

            _set_task(
                task_id,
                status=TaskStatus.SUMMARIZING,
                message=f"正在处理字幕 {file_index}/{total_files}: {subtitle_title}: 重新生成 Markdown 文档...",
                subtitle_file=subtitle_file,
            )
            markdown_content = summarizer.generate_markdown_note(
                plain_text,
                video_title=video_title,
                include_summary=generate_options.get("summary", True),
                include_content=generate_options.get("full_content", True),
                include_exercises=generate_options.get("exercises", False),
                include_questions=generate_options.get("questions", False),
                prompt_config=prompt_config,
                stream=False,
            )
            with open(markdown_file, "w", encoding="utf-8") as file:
                file.write(markdown_content)

            all_generated_files.append({
                "subtitle_title": subtitle_title,
                "subtitle_file": subtitle_file,
                "plain_text": plain_text_file,
                "content_md": markdown_file,
            })

        _set_task(
            task_id,
            status=TaskStatus.COMPLETED,
            message=f"全部完成，已处理 {total_files} 个字幕文件。",
            files={
                "video_dir": video_dir,
                "cover": cover_path,
                "generated_files": all_generated_files,
            },
            completed_at=datetime.now().isoformat(),
        )

    except Exception as error:
        _set_task(
            task_id,
            status=TaskStatus.FAILED,
            message=f"错误: {error}",
            error=str(error),
        )
