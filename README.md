# Bili Note

将原 web 框架 更改为 obsidian插件。

Bili Note 是一个 Obsidian 插件，用本地 Python 流水线把 Bilibili 视频、分 P 视频、合集或收藏夹整理成结构化 Markdown 学习笔记。

插件负责交互、配置和笔记落库；Python 流水线负责获取视频信息、下载或复用字幕、在需要时进行本地 ASR 转写，并调用兼容 OpenAI Chat Completions 的模型生成学习笔记。

## 主要功能

- 支持 Bilibili 单视频、分 P、合集、收藏夹链接
- 支持起始序号、终止序号和并发数设置
- 自动复用字幕、纯文本和 Markdown 缓存，避免重复处理
- 运行前检测已生成内容，并提示命中的视频标题
- 支持配置学习目录、自定义提示词和输出模板，并提供常用预设
- 在插件设置页管理 LLM API、Bilibili Cookie 和本地 ASR 参数
- 视频没有在线字幕时，可使用 faster-whisper 做本地转写

## 项目结构

```text
.
├── main.js                         # Obsidian 插件主逻辑和侧边栏 UI
├── styles.css                      # 插件样式
├── manifest.json                   # Obsidian 插件清单
├── cli.py                          # Python 命令入口
├── pipeline.py                     # 可复用任务流水线
├── processor.py                    # 视频处理核心逻辑
├── bilibili_subtitle_downloader.py # Bilibili 信息、字幕、音频处理
├── subtitle_summarizer.py          # LLM 提示词与 Markdown 生成
├── llm_client.py                   # OpenAI 兼容接口客户端
├── video_transcriber.py            # 本地 ASR 转写
├── process_video_info.py           # 文件名清理等工具
├── pyproject.toml                  # Python 项目与 uv 配置
├── requirements.txt                # 基础 Python 依赖
├── requirements-gpu.txt            # 可选 GPU 依赖
├── install_ffmpeg.ps1              # Windows FFmpeg 安装辅助脚本
├── LICENSE                         # 开源许可证
├── config/                         # 模型配置示例和本地配置
├── subtitles/                      # 运行时缓存输出，默认不提交
├── tools/ffmpeg/                   # 可选内置 FFmpeg，默认不提交
└── models/                         # 本地 ASR 模型缓存，默认不提交
```

## 环境要求

- Obsidian 桌面版
- Python 3.12
- `uv`，推荐用于创建虚拟环境和安装依赖
- FFmpeg，本地 ASR 转写时需要
- 一个兼容 OpenAI Chat Completions 的模型 API

当前项目优先支持 Windows。插件会优先使用项目目录下的 `.venv\Scripts\python.exe`；如果找不到，会尝试使用 `uv run python`。

## 安装

将项目放到 Obsidian 仓库的插件目录：

```text
<Vault>/.obsidian/plugins/obsidian-bilinote/
```

然后在项目目录安装 Python 依赖：

```powershell
uv venv .venv --python 3.12
uv pip install -r requirements.txt --python .venv\Scripts\python.exe
```

如果需要本地 ASR，确保 FFmpeg 可用。可以运行脚本安装：

```powershell
.\install_ffmpeg.ps1
```

也可以手动把 `ffmpeg.exe` 放到：

```text
tools/ffmpeg/bin/ffmpeg.exe
```

最后在 Obsidian 中打开设置，进入第三方插件，允许第三方插件并启用 `Bili Note`。

## 模型配置

推荐在插件设置页添加模型 API。配置会写入本地文件：

```text
config/llm_models.json
```

这个文件可能包含 API Key，已经被 `.gitignore` 排除，不应提交。

也可以先复制示例配置：

```powershell
Copy-Item config/llm_models.example.json config/llm_models.json
```

示例结构：

```json
{
  "models": [
    {
      "id": "default",
      "name": "默认模型",
      "model_name": "your-model-name",
      "api_base": "https://your-api-base/v1",
      "api_key": "your-api-key"
    }
  ]
}
```

## Bilibili Cookie

如果需要访问合集、收藏夹或受限字幕，可以在插件设置页填写 Bilibili Cookie。常用字段包括：

- `SESSDATA`
- `bili_jct`
- `buvid3`

插件支持从完整 Cookie 字符串中自动提取这些字段。Cookie 会保存在 Obsidian 插件本地数据中，不应提交到仓库。

## 使用方式

1. 打开 Obsidian 右侧栏里的 `视频转笔记`。
2. 选择或新建学习路径，例如 `后端/Java 基础`。
3. 输入一个或多个 Bilibili 链接，每行一个。
4. 按需设置起始序号、终止序号、并发数、提示词预设和输出模板。
5. 点击运行，等待生成 Markdown 笔记。

输出会写入两个位置：

- 插件缓存：`subtitles/<学习路径>/...`
- Obsidian 笔记目录：`<Vault>/<学习路径>/...`

如果缓存中已有对应 Markdown，插件会在运行前提示，方便跳过或复用已有内容。

## CLI 用法

插件底层调用 `cli.py`，也可以手动运行：

```powershell
.\.venv\Scripts\python.exe cli.py generate "https://www.bilibili.com/video/BV..." `
  --output subtitles `
  --notes-output "D:\path\to\vault\后端\Java 基础" `
  --workspace-name "后端/Java 基础" `
  --model-name "默认模型" `
  --download-all-parts `
  --start-index 1 `
  --end-index 5 `
  --max-workers 2
```

## 提交前检查

```powershell
node --check main.js
python -m py_compile cli.py pipeline.py processor.py bilibili_subtitle_downloader.py subtitle_summarizer.py llm_client.py video_transcriber.py process_video_info.py
```

## 推荐提交清单

这个仓库当前作为源码提交时，通常只需要提交 19 个文件：18 个项目文件加 `.gitignore`。

```text
.gitignore
README.md
LICENSE
manifest.json
main.js
styles.css
pyproject.toml
requirements.txt
requirements-gpu.txt
install_ffmpeg.ps1
cli.py
pipeline.py
processor.py
bilibili_subtitle_downloader.py
subtitle_summarizer.py
llm_client.py
video_transcriber.py
process_video_info.py
config/llm_models.example.json
```

提交前请确认以下本地文件或目录没有被加入版本控制：

- `data.json`
- `cookies.txt`
- `config/llm_models.json`
- `subtitles/`
- `models/`
- `tools/ffmpeg/`
- `.venv/`
- `.uv-cache/`
- `.tmp/`
- `__pycache__/`
- `.agents/`
- `.codex/`
