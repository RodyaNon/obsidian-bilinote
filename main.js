const { ItemView, Modal, Notice, Plugin, PluginSettingTab, Setting, normalizePath } = require("obsidian");
const { spawn } = require("child_process");
const fs = require("fs");
const https = require("https");
const path = require("path");

const VIEW_TYPE = "bilinote-view";

const DEFAULT_SETTINGS = {
  projectPath: "",
  pythonCommand: "",
  selectedModel: "",
  systemPrompt: "",
  targetFolder: "",
  parentFolder: "",
  courseFolder: "",
  selectedWorkspaceId: "",
  directoryWorkspaces: [],
  startIndex: "",
  endIndex: "",
  maxWorkers: "1",
  sessdata: "",
  biliJct: "",
  buvid3: "",
  biliUserName: "",
  asrModelSize: "small",
  asrDevice: "auto",
  asrComputeType: "auto",
  promptMode: "engineering_notes",
  userPrompt: "",
  outputRules: "",
  downloadAllParts: false
};

const PROMPT_MODE_OPTIONS = [
  ["engineering_notes", "工程学习笔记"],
  ["quick_summary", "速览摘要"],
  ["exam_review", "考试复习"],
  ["concept_cards", "概念卡片"],
  ["project_practice", "项目实战"],
  ["custom", "自定义"]
];

const DEFAULT_SYSTEM_PROMPT = "你是一个专业的学习笔记整理助手，擅长把视频文字稿整理成准确、结构清晰、适合复习的 Obsidian Markdown 文档。";

const DEFAULT_OUTPUT_RULES = [
  "只输出 Markdown，不要代码块包裹，不要写元说明。",
  "严格基于视频文字稿；原文没有的信息不要补编，不确定处写“原文未说明”。",
  "保留技术名词、命令、配置项、参数、流程和限制条件。",
  "如果出现代码、命令、配置、路径或 API，必须原样保留并用行内代码或代码块呈现。"
].join("\n");

const PROMPT_PRESETS = {
  engineering_notes: {
    userPrompt: [
      "面向工程学习者整理笔记，重点提炼可复用的概念、流程、参数、命令、配置、案例和限制条件。",
      "把口语化讲解改写成可查阅的技术文档；优先呈现结论，再解释原因和步骤。",
      "遇到实现细节、源码分析、架构取舍、排错经验时要保留上下文。"
    ].join("\n"),
    outputRules: [
      "输出 `# 标题`、`## 核心要点`、`## 学习笔记`、`## 实践注意`。",
      "`核心要点` 用 5-8 条列出最值得记住的结论。",
      "`学习笔记` 按主题重组，不按口播流水账复述。",
      "`实践注意` 收集命令、配置、易错点、边界条件和适用场景。"
    ].join("\n")
  },
  quick_summary: {
    userPrompt: [
      "把视频整理成快速浏览版，帮助我在短时间内判断内容价值和复习重点。",
      "减少展开解释，保留关键结论、重要例子、行动项和原文明确提到的限制。"
    ].join("\n"),
    outputRules: [
      "输出 `# 标题`、`## 一句话概括`、`## 关键结论`、`## 值得回看`。",
      "`一句话概括` 不超过 80 字。",
      "`关键结论` 控制在 6-10 条，每条尽量短。",
      "`值得回看` 只列出确实需要细看的主题或片段内容。"
    ].join("\n")
  },
  exam_review: {
    userPrompt: [
      "面向考试和面试复习整理内容，突出定义、区别、条件、步骤、易错点和可出题点。",
      "把知识点改写成便于背诵和自测的形式，避免散文化长段落。"
    ].join("\n"),
    outputRules: [
      "输出 `# 标题`、`## 考点速记`、`## 知识点详解`、`## 易错点`、`## 自测题`。",
      "`考点速记` 使用短句 bullet。",
      "`知识点详解` 说明是什么、为什么、怎么用、与相近概念的区别。",
      "`自测题` 给 5-8 道题，并在题后给简短答案。"
    ].join("\n")
  },
  concept_cards: {
    userPrompt: [
      "把视频内容整理成概念卡片，适合导入 Obsidian 后做双链、复习和二次整理。",
      "每张卡片聚焦一个概念或一个方法，不要把多个主题混在一起。"
    ].join("\n"),
    outputRules: [
      "输出 `# 标题`、`## 概念卡片`、`## 关系索引`。",
      "`概念卡片` 中每张卡片使用 `### 概念名`，包含定义、用途、关键点、例子。",
      "`关系索引` 列出概念之间的依赖、对比或流程关系。",
      "可以使用 Obsidian 风格的 `[[概念名]]` 标记核心概念。"
    ].join("\n")
  },
  project_practice: {
    userPrompt: [
      "面向项目实战整理内容，突出目标、前置条件、操作步骤、关键配置、验证方式和排错线索。",
      "如果视频中出现命令、路径、配置、代码或工具名称，要完整保留。"
    ].join("\n"),
    outputRules: [
      "输出 `# 标题`、`## 实战目标`、`## 操作步骤`、`## 关键配置`、`## 验证与排错`。",
      "`操作步骤` 使用有序列表，保证顺序清晰。",
      "`关键配置` 用表格或代码块呈现，不能改写具体字段名。",
      "`验证与排错` 记录成功现象、常见失败原因和处理办法。"
    ].join("\n")
  },
  custom: {
    userPrompt: "",
    outputRules: DEFAULT_OUTPUT_RULES
  }
};

const DEFAULT_MODEL = {
  id: "default",
  name: "",
  model_name: "",
  api_base: "",
  api_key: ""
};

function maskSecret(value) {
  return value ? "已配置" : "未配置";
}

function sanitizeRelativeFolder(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
}

function joinRelativeFolders(...parts) {
  return parts
    .map((part) => sanitizeRelativeFolder(part))
    .filter(Boolean)
    .join("/");
}

function extractCookieValue(source, key) {
  const text = String(source || "").trim();
  if (!text) return "";
  if (!text.includes("=")) return key.toLowerCase() === "sessdata" ? text : "";

  const lowerKey = key.toLowerCase();
  for (const part of text.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || !rawValue.length) continue;
    if (rawName.trim().toLowerCase() === lowerKey) {
      return rawValue.join("=").trim();
    }
  }
  return "";
}

function normalizeCookieSettings(settings) {
  const sources = [settings.sessdata, settings.biliJct, settings.buvid3].filter(Boolean);
  for (const source of sources) {
    if (String(source).includes("=")) {
      settings.sessdata = extractCookieValue(source, "SESSDATA") || settings.sessdata;
      settings.biliJct = extractCookieValue(source, "bili_jct") || settings.biliJct;
      settings.buvid3 = extractCookieValue(source, "buvid3") || settings.buvid3;
    }
  }
}

class TextInputModal extends Modal {
  constructor(app, title, placeholder, onDone) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.onDone = onDone;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    const input = contentEl.createEl("input", {
      type: "text",
      cls: "ala-modal-input",
      attr: { placeholder: this.placeholder || "" }
    });

    const actions = contentEl.createDiv({ cls: "ala-modal-actions" });
    const cancelBtn = actions.createEl("button", { text: "取消" });
    const confirmBtn = actions.createEl("button", { text: "确定", cls: "mod-cta" });
    let submitted = false;

    const submit = () => {
      if (submitted) return;
      const value = sanitizeRelativeFolder(input.value);
      if (!value) {
        new Notice("请输入目录名称。");
        return;
      }
      submitted = true;
      this.done = true;
      confirmBtn.disabled = true;
      const done = this.onDone;
      this.close();
      done(value);
    };

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") submit();
      if (event.key === "Escape") this.close();
    });
    cancelBtn.addEventListener("click", () => this.close());
    confirmBtn.addEventListener("click", submit);
    setTimeout(() => input.focus(), 0);
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.onDone("");
  }
}

class ConfirmModal extends Modal {
  constructor(app, title, message, confirmText, onDone) {
    super(app);
    this.title = title;
    this.message = message;
    this.confirmText = confirmText || "确定";
    this.onDone = onDone;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });
    for (const line of String(this.message || "").split("\n")) {
      contentEl.createEl("p", { text: line });
    }

    const actions = contentEl.createDiv({ cls: "ala-modal-actions" });
    const cancelBtn = actions.createEl("button", { text: "取消" });
    const confirmBtn = actions.createEl("button", { text: this.confirmText, cls: "mod-warning" });
    let submitted = false;

    cancelBtn.addEventListener("click", () => this.close());
    confirmBtn.addEventListener("click", () => {
      if (submitted) return;
      submitted = true;
      this.done = true;
      confirmBtn.disabled = true;
      const done = this.onDone;
      this.close();
      done(true);
    });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.onDone(false);
  }
}

function confirmWithModal(app, title, message, confirmText = "确定") {
  return new Promise((resolve) => {
    new ConfirmModal(app, title, message, confirmText, resolve).open();
  });
}

function requestTextWithModal(app, title, placeholder = "") {
  return new Promise((resolve) => {
    new TextInputModal(app, title, placeholder, resolve).open();
  });
}

class DirectoryTreeModal extends Modal {
  constructor(app, paths, currentPath, onDone) {
    super(app);
    this.paths = Array.isArray(paths) ? paths : [];
    this.currentPath = sanitizeRelativeFolder(currentPath);
    this.onDone = onDone;
    this.done = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "选择学习路径" });

    const tree = contentEl.createDiv({ cls: "ala-tree-picker" });
    const root = this.buildTree(this.paths);
    if (!root.children.size) {
      tree.createDiv({ cls: "ala-tree-empty", text: "还没有路径，请先新建。" });
    } else {
      this.renderNodes(tree, Array.from(root.children.values()), 0);
    }

    const actions = contentEl.createDiv({ cls: "ala-modal-actions" });
    const createBtn = actions.createEl("button", { text: "新建路径", cls: "mod-cta" });
    const cancelBtn = actions.createEl("button", { text: "取消" });

    createBtn.addEventListener("click", () => {
      this.done = true;
      const done = this.onDone;
      this.close();
      done("__new__");
    });
    cancelBtn.addEventListener("click", () => this.close());
  }

  buildTree(paths) {
    const root = { name: "", path: "", children: new Map() };
    for (const rawPath of paths) {
      const parts = sanitizeRelativeFolder(rawPath).split("/").filter(Boolean);
      let node = root;
      let current = "";
      for (const part of parts) {
        current = joinRelativeFolders(current, part);
        if (!node.children.has(part)) {
          node.children.set(part, { name: part, path: current, children: new Map() });
        }
        node = node.children.get(part);
      }
    }
    return root;
  }

  renderNodes(container, nodes, depth) {
    nodes
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .forEach((node) => {
        const item = container.createDiv({
          cls: `ala-tree-item${node.path === this.currentPath ? " is-active" : ""}`
        });
        item.style.setProperty("--tree-depth", String(depth));
        item.createSpan({ cls: "ala-tree-folder", text: node.children.size ? "▾" : "•" });
        item.createSpan({ cls: "ala-tree-name", text: node.name });
        item.createSpan({ cls: "ala-tree-path", text: node.path });
        item.addEventListener("click", () => {
          this.done = true;
          const done = this.onDone;
          this.close();
          done(node.path);
        });
        this.renderNodes(container, Array.from(node.children.values()), depth + 1);
      });
  }

  onClose() {
    this.contentEl.empty();
    if (!this.done) this.onDone("");
  }
}

function requestDirectoryPathWithModal(app, paths, currentPath) {
  return new Promise((resolve) => {
    new DirectoryTreeModal(app, paths, currentPath, resolve).open();
  });
}

class AssistantView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.textModalOpen = false;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Bili Note";
  }

  getIcon() {
    return "graduation-cap";
  }

  async onOpen() {
    this.render();
  }

  render() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ala-view");

    const shell = containerEl.createDiv({ cls: "ala-shell" });
    const header = shell.createDiv({ cls: "ala-header ala-header-compact" });
    header.createEl("h2", { text: "视频转笔记" });

    const taskCard = shell.createDiv({ cls: "ala-card" });
    taskCard.createEl("h3", { text: "任务" });

    const directoryRow = taskCard.createDiv({ cls: "ala-directory-row" });
    const parentField = directoryRow.createDiv({ cls: "ala-field ala-parent-field" });
    parentField.createEl("label", { text: "学习路径" });
    const currentPath = this.plugin.getCombinedTargetFolder();
    const pathButton = parentField.createEl("button", {
      cls: "ala-path-select",
      text: currentPath || "选择或新建路径"
    });
    const openPathPicker = async () => {
      if (this.textModalOpen) return;
      this.textModalOpen = true;
      try {
        const selected = await requestDirectoryPathWithModal(
          this.app,
          this.plugin.getDirectoryPaths(),
          this.plugin.getCombinedTargetFolder()
        );
        if (selected === "__new__") {
          const value = await requestTextWithModal(this.app, "新建学习路径", "例如：后端/IT老齐");
          if (value) {
            await this.plugin.selectDirectoryPath(value);
          }
        } else if (selected) {
          await this.plugin.selectDirectoryPath(selected);
        }
      } finally {
        this.textModalOpen = false;
      }
      this.render();
    };
    pathButton.addEventListener("click", openPathPicker);

    const directoryActions = directoryRow.createDiv({ cls: "ala-directory-actions" });
    const deleteDirectoryBtn = directoryActions.createEl("button", {
      cls: "ala-button",
      text: "删除"
    });
    deleteDirectoryBtn.disabled = !sanitizeRelativeFolder(this.plugin.getCombinedTargetFolder());
    deleteDirectoryBtn.addEventListener("click", async () => {
      try {
        await this.plugin.deleteCurrentDirectoryWithConfirm();
        this.render();
      } catch (error) {
        new Notice(error.message || String(error));
      }
    });

    const urlField = taskCard.createDiv({ cls: "ala-field" });
    urlField.createEl("label", { text: "Bilibili 视频网址" });
    const urlInput = urlField.createEl("textarea", {
      cls: "ala-url-input",
      attr: {
        rows: "3",
        placeholder: "https://www.bilibili.com/video/BV..."
      }
    });
    urlInput.value = this.plugin.settings.urlsText || "";
    urlInput.addEventListener("input", () => {
      this.plugin.settings.urlsText = urlInput.value;
    });
    urlInput.addEventListener("change", async () => {
      await this.plugin.persistActiveDirectoryWorkspace();
    });

    const compactFields = taskCard.createDiv({ cls: "ala-compact-fields" });
    let rangeCount = null;
    const updateRangeCount = () => {
      if (rangeCount) {
        rangeCount.setText(this.plugin.formatRangeCount(this.plugin.settings.startIndex, this.plugin.settings.endIndex));
      }
    };

    const startField = compactFields.createDiv({ cls: "ala-field ala-range-field" });
    startField.createEl("label", { text: "起始序号" });
    const startInput = startField.createEl("input", {
      type: "number",
      value: this.plugin.settings.startIndex || "",
      attr: {
        min: "1",
        placeholder: "1"
      }
    });
    startInput.addEventListener("change", async () => {
      this.plugin.settings.startIndex = this.plugin.normalizePositiveInt(startInput.value);
      startInput.value = this.plugin.settings.startIndex;
      updateRangeCount();
      await this.plugin.persistActiveDirectoryWorkspace();
    });
    startInput.addEventListener("input", () => {
      this.plugin.settings.startIndex = startInput.value;
      updateRangeCount();
    });

    const endField = compactFields.createDiv({ cls: "ala-field ala-range-field" });
    endField.createEl("label", { text: "终止序号" });
    const endInput = endField.createEl("input", {
      type: "number",
      value: this.plugin.settings.endIndex || "",
      attr: {
        min: "1",
        placeholder: "不限"
      }
    });
    endInput.addEventListener("change", async () => {
      this.plugin.settings.endIndex = this.plugin.normalizePositiveInt(endInput.value);
      endInput.value = this.plugin.settings.endIndex;
      updateRangeCount();
      await this.plugin.persistActiveDirectoryWorkspace();
    });
    endInput.addEventListener("input", () => {
      this.plugin.settings.endIndex = endInput.value;
      updateRangeCount();
    });

    const workersField = compactFields.createDiv({ cls: "ala-field ala-range-field" });
    workersField.createEl("label", { text: "并发数" });
    const workersInput = workersField.createEl("input", {
      type: "number",
      value: this.plugin.settings.maxWorkers || DEFAULT_SETTINGS.maxWorkers,
      attr: {
        min: "1",
        max: "6",
        placeholder: "1"
      }
    });
    workersInput.addEventListener("change", async () => {
      this.plugin.settings.maxWorkers = this.plugin.normalizePositiveInt(workersInput.value) || DEFAULT_SETTINGS.maxWorkers;
      workersInput.value = this.plugin.settings.maxWorkers;
      await this.plugin.persistActiveDirectoryWorkspace();
    });
    workersInput.addEventListener("input", () => {
      this.plugin.settings.maxWorkers = workersInput.value;
    });

    const meta = taskCard.createDiv({ cls: "ala-meta-row" });
    rangeCount = meta.createSpan({
      text: this.plugin.formatRangeCount(this.plugin.settings.startIndex, this.plugin.settings.endIndex)
    });
    const cookieStatus = meta.createSpan({ text: `Cookie：${this.plugin.getCookieDisplayName()}` });
    this.plugin.refreshCookieUserName((name) => {
      cookieStatus.setText(`Cookie：${name}`);
    });

    const actions = taskCard.createDiv({ cls: "ala-actions" });

    const previewBtn = actions.createEl("button", {
      cls: "ala-button ala-button-secondary",
      text: "预览命令"
    });
    const runBtn = actions.createEl("button", {
      cls: "ala-button ala-button-primary",
      text: "运行"
    });
    const stopBtn = actions.createEl("button", {
      cls: "ala-button ala-button-danger",
      text: "终止"
    });
    stopBtn.disabled = !this.plugin.currentChild;

    const optionCard = shell.createDiv({ cls: "ala-card" });
    optionCard.createEl("h3", { text: "提示词" });

    const modeField = optionCard.createDiv({ cls: "ala-field" });
    modeField.createEl("label", { text: "预设模式" });
    const modeSelect = modeField.createEl("select");
    for (const [value, label] of PROMPT_MODE_OPTIONS) {
      modeSelect.createEl("option", { value, text: label });
    }
    modeSelect.value = this.plugin.settings.promptMode || DEFAULT_SETTINGS.promptMode;

    const userPromptField = optionCard.createDiv({ cls: "ala-field" });
    userPromptField.createEl("label", { text: "目录级用户提示词" });
    const userPromptInput = userPromptField.createEl("textarea", {
      cls: "ala-prompt-input",
      attr: {
        rows: "4",
        placeholder: "例如：偏向 Java 后端面试复习；重点保留源码分析、设计取舍和易错点。"
      }
    });
    userPromptInput.value = this.plugin.settings.userPrompt || "";
    userPromptInput.addEventListener("input", () => {
      this.plugin.settings.userPrompt = userPromptInput.value;
    });
    userPromptInput.addEventListener("change", async () => {
      await this.plugin.persistActiveDirectoryWorkspace();
    });

    const outputRulesField = optionCard.createDiv({ cls: "ala-field" });
    outputRulesField.createEl("label", { text: "输出规则" });
    const outputRulesInput = outputRulesField.createEl("textarea", {
      cls: "ala-prompt-input",
      attr: { rows: "5" }
    });
    outputRulesInput.value = this.plugin.settings.outputRules || DEFAULT_OUTPUT_RULES;
    outputRulesInput.addEventListener("input", () => {
      this.plugin.settings.outputRules = outputRulesInput.value;
    });
    outputRulesInput.addEventListener("change", async () => {
      await this.plugin.persistActiveDirectoryWorkspace();
    });

    modeSelect.addEventListener("change", async () => {
      this.plugin.settings.promptMode = modeSelect.value;
      if (modeSelect.value === "custom") {
        this.plugin.settings.userPrompt = "";
        this.plugin.settings.outputRules = DEFAULT_OUTPUT_RULES;
        userPromptInput.value = "";
        outputRulesInput.value = DEFAULT_OUTPUT_RULES;
      } else {
        const preset = PROMPT_PRESETS[modeSelect.value] || PROMPT_PRESETS[DEFAULT_SETTINGS.promptMode];
        this.plugin.settings.userPrompt = preset.userPrompt;
        this.plugin.settings.outputRules = preset.outputRules;
        userPromptInput.value = preset.userPrompt;
        outputRulesInput.value = preset.outputRules;
      }
      await this.plugin.persistActiveDirectoryWorkspace();
    });

    const status = shell.createDiv({ cls: "ala-status" });
    const statusTitle = status.createDiv({ cls: "ala-status-title", text: "终端" });
    const log = this.createCopyableLog(status, "准备运行。\n");

    previewBtn.addEventListener("click", async () => {
      const state = this.plugin.collectRunState();
      const validation = this.plugin.validateRunState(state);
      if (validation) {
        statusTitle.setText(validation);
        this.setLog(log, "请先完成任务配置。\n");
        return;
      }
      statusTitle.setText("命令预览");
      const previewPromptConfigFile = path.resolve(this.plugin.getRuntimePath(), ".tmp", "ai-learning-prompt-preview.json");
      this.setLog(log, `${this.plugin.buildCommand(state, {
        writePromptConfig: true,
        promptConfigFile: previewPromptConfigFile
      }).display}\n`);
    });

    runBtn.addEventListener("click", async () => {
      const state = this.plugin.collectRunState();
      const validation = this.plugin.validateRunState(state);
      if (validation) {
        new Notice(validation);
        return;
      }
      const existingCourse = this.plugin.getExistingCourseStatus(state);
      if (existingCourse.exists) {
        const matchedVideoText = this.plugin.formatMatchedVideoList(existingCourse.matchedVideos);
        const message = `选中范围内已有生成结果：${state.targetFolder}\n\n已生成的视频：\n${matchedVideoText}\n\n继续运行会优先复用插件缓存，并复制到当前 Obsidian 目录。是否继续？`;
        const confirmed = await confirmWithModal(this.app, "已有课程存在", message, "继续运行");
        if (!confirmed) {
          this.appendLog(log, `\n已取消：选中的已有课程存在（${state.targetFolder}）。\n`);
          return;
        }
        this.appendLog(log, `\n提示：选中范围内已有 ${existingCourse.generatedCount} 个视频生成过。\n${matchedVideoText}\n`);
      }

      runBtn.disabled = true;
      previewBtn.disabled = true;
      stopBtn.disabled = false;
      statusTitle.setText("运行中");
      this.appendLog(log, "\n$ 正在启动生成任务...\n");

      try {
        const result = await this.plugin.runGenerate(state, (line) => {
          this.appendLog(log, line);
        });

        statusTitle.setText(result.success ? "已完成" : "失败");
        if (result.error) {
          this.appendLog(log, `\n错误：${result.error}\n`);
        }
        if (result.traceback) {
          this.appendLog(log, `\n${result.traceback}\n`);
        }
        this.appendLog(log, `\nURL 数量：${state.urls.length}\n`);
        this.appendLog(log, `目标目录：${state.targetFolder}\n`);
        this.appendLog(log, `已复制笔记数：${(result.copied_notes || []).length}\n`);
        for (const notePath of result.copied_notes || []) {
          this.appendLog(log, `笔记：${notePath}\n`);
        }
        this.appendLog(log, result.success ? "任务完成。\n" : "任务结束，但存在错误。\n");

        new Notice(result.success ? "学习笔记已生成。" : "生成结束，但存在错误。");
      } catch (error) {
        statusTitle.setText("失败");
        this.appendLog(log, `\n${error.message || String(error)}\n`);
        new Notice("生成失败，请查看面板日志。");
      } finally {
        runBtn.disabled = false;
        previewBtn.disabled = false;
        stopBtn.disabled = true;
      }
    });

    stopBtn.addEventListener("click", () => {
      this.plugin.stopGenerate();
      stopBtn.disabled = true;
      statusTitle.setText("正在终止");
      this.appendLog(log, "\n已发送终止信号，正在等待进程退出。\n");
    });
  }

  createCopyableLog(container, text) {
    const log = container.createEl("textarea", { cls: "ala-log ala-copyable-log" });
    log.readOnly = false;
    log.value = text || "";
    log.setAttribute("spellcheck", "false");
    log.wrap = "soft";
    return log;
  }

  setLog(log, text) {
    log.value = text || "";
    log.scrollTop = log.scrollHeight;
  }

  appendLog(log, text) {
    log.value += text || "";
    log.scrollTop = log.scrollHeight;
  }

}

module.exports = class AILearningAssistantPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    normalizeCookieSettings(this.settings);
    if (this.settings.modelName && !this.settings.selectedModel) {
      this.settings.selectedModel = this.settings.modelName;
    }
    if (this.settings.outputFolder && !this.settings.targetFolder) {
      this.settings.targetFolder = this.settings.outputFolder;
    }
    this.migrateFolderSettings();
    await this.saveSettings();

    this.registerView(VIEW_TYPE, (leaf) => new AssistantView(leaf, this));
    this.currentChild = null;

    this.addRibbonIcon("file-text", "Bili Note", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-bilinote",
      name: "打开 Bili Note",
      callback: () => this.activateView()
    });

    this.addSettingTab(new AssistantSettingTab(this.app, this));
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getDirectoryWorkspaces() {
    if (!Array.isArray(this.settings.directoryWorkspaces)) {
      this.settings.directoryWorkspaces = [];
    }
    return this.settings.directoryWorkspaces;
  }

  getWorkspacePath(workspace) {
    const target = sanitizeRelativeFolder(workspace?.targetFolder);
    if (target) return target;
    return joinRelativeFolders(workspace?.parentFolder, workspace?.courseFolder);
  }

  getDirectoryPaths() {
    const paths = new Set(
      this.getDirectoryWorkspaces()
        .map((item) => this.getWorkspacePath(item))
        .filter(Boolean)
    );
    const current = this.getCombinedTargetFolder();
    if (current) paths.add(current);
    return Array.from(paths).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  splitDirectoryPath(directoryPath) {
    const parts = sanitizeRelativeFolder(directoryPath).split("/").filter(Boolean);
    return {
      targetFolder: parts.join("/"),
      parentFolder: parts.length > 1 ? parts.slice(0, -1).join("/") : (parts[0] || ""),
      courseFolder: parts.length > 1 ? parts[parts.length - 1] : ""
    };
  }

  setDirectoryPath(directoryPath) {
    const parts = this.splitDirectoryPath(directoryPath);
    this.settings.targetFolder = parts.targetFolder;
    this.settings.parentFolder = parts.parentFolder;
    this.settings.courseFolder = parts.courseFolder;
    return parts;
  }

  getParentFolders() {
    const parents = new Set(
      this.getDirectoryWorkspaces()
        .map((item) => sanitizeRelativeFolder(item.parentFolder))
        .filter(Boolean)
    );
    if (sanitizeRelativeFolder(this.settings.parentFolder)) {
      parents.add(sanitizeRelativeFolder(this.settings.parentFolder));
    }
    return Array.from(parents).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  getCourseFolders(parentFolder) {
    const parent = sanitizeRelativeFolder(parentFolder);
    if (!parent) return [];
    return Array.from(new Set(
      this.getDirectoryWorkspaces()
        .filter((item) => sanitizeRelativeFolder(item.parentFolder) === parent)
        .map((item) => sanitizeRelativeFolder(item.courseFolder))
        .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, "zh-CN"));
  }

  findDirectoryWorkspace(parentFolder, courseFolder = "") {
    const parent = sanitizeRelativeFolder(parentFolder);
    const course = sanitizeRelativeFolder(courseFolder);
    return this.getDirectoryWorkspaces().find((item) =>
      sanitizeRelativeFolder(item.parentFolder) === parent
      && sanitizeRelativeFolder(item.courseFolder) === course
    );
  }

  findDirectoryWorkspaceByPath(directoryPath) {
    const target = sanitizeRelativeFolder(directoryPath);
    return this.getDirectoryWorkspaces().find((item) => this.getWorkspacePath(item) === target);
  }

  collectDirectoryWorkspace(id = this.settings.selectedWorkspaceId || String(Date.now())) {
    const targetFolder = sanitizeRelativeFolder(this.settings.targetFolder) || this.getCombinedTargetFolder();
    const { parentFolder, courseFolder } = this.splitDirectoryPath(targetFolder);
    return {
      id,
      name: targetFolder,
      targetFolder,
      parentFolder,
      courseFolder,
      urlsText: this.settings.urlsText || "",
      startIndex: this.normalizePositiveInt(this.settings.startIndex),
      endIndex: this.normalizePositiveInt(this.settings.endIndex),
      maxWorkers: this.normalizePositiveInt(this.settings.maxWorkers) || DEFAULT_SETTINGS.maxWorkers,
      promptMode: this.normalizePromptMode(this.settings.promptMode),
      userPrompt: this.settings.userPrompt || "",
      outputRules: this.settings.outputRules || DEFAULT_OUTPUT_RULES,
      downloadAllParts: false
    };
  }

  resetLearningStateForNewDirectory(parentFolder, courseFolder = "") {
    this.setDirectoryPath(joinRelativeFolders(parentFolder, courseFolder));
    this.settings.urlsText = "";
    this.settings.startIndex = "";
    this.settings.endIndex = "";
    this.settings.maxWorkers = DEFAULT_SETTINGS.maxWorkers;
    this.settings.promptMode = DEFAULT_SETTINGS.promptMode;
    this.settings.userPrompt = PROMPT_PRESETS[DEFAULT_SETTINGS.promptMode].userPrompt;
    this.settings.outputRules = PROMPT_PRESETS[DEFAULT_SETTINGS.promptMode].outputRules;
    this.settings.downloadAllParts = false;
  }

  async createDirectoryWorkspace() {
    const workspaces = this.getDirectoryWorkspaces();
    if (!sanitizeRelativeFolder(this.settings.parentFolder)) {
      throw new Error("主目录必填。");
    }
    this.resetLearningStateForNewDirectory(this.settings.parentFolder, this.settings.courseFolder);
    const workspace = this.collectDirectoryWorkspace(String(Date.now()));
    const existing = workspaces.find((item) => item.targetFolder === workspace.targetFolder);
    if (existing) {
      this.applyDirectoryWorkspace(existing.id);
      await this.saveSettings();
      return existing;
    }
    workspaces.push(workspace);
    this.settings.selectedWorkspaceId = workspace.id;
    this.settings.parentFolder = workspace.parentFolder;
    this.settings.courseFolder = workspace.courseFolder;
    this.settings.targetFolder = workspace.targetFolder;
    await this.saveSettings();
    return workspace;
  }

  async ensureDirectoryWorkspace(parentFolder, courseFolder = "") {
    const target = joinRelativeFolders(parentFolder, courseFolder);
    if (!target) throw new Error("学习路径必填。");
    const existing = this.findDirectoryWorkspaceByPath(target);
    if (existing) {
      this.applyDirectoryWorkspace(existing.id);
      await this.saveSettings();
      return existing;
    }
    this.resetLearningStateForNewDirectory(target);
    const workspace = this.collectDirectoryWorkspace(String(Date.now()));
    this.getDirectoryWorkspaces().push(workspace);
    this.settings.selectedWorkspaceId = workspace.id;
    this.settings.targetFolder = workspace.targetFolder;
    await this.saveSettings();
    return workspace;
  }

  async ensureDirectoryPath(directoryPath) {
    const target = sanitizeRelativeFolder(directoryPath);
    if (!target) throw new Error("学习路径必填。");
    const existing = this.findDirectoryWorkspaceByPath(target);
    if (existing) {
      this.applyDirectoryWorkspace(existing.id);
      await this.saveSettings();
      return existing;
    }
    this.resetLearningStateForNewDirectory(target);
    const workspace = this.collectDirectoryWorkspace(String(Date.now()));
    this.getDirectoryWorkspaces().push(workspace);
    this.settings.selectedWorkspaceId = workspace.id;
    this.settings.targetFolder = workspace.targetFolder;
    await this.saveSettings();
    return workspace;
  }

  async selectDirectoryPath(directoryPath) {
    await this.ensureDirectoryPath(directoryPath);
  }

  async selectParentFolder(parentFolder) {
    const parent = sanitizeRelativeFolder(parentFolder);
    if (!parent) {
      this.settings.parentFolder = "";
      this.settings.courseFolder = "";
      this.settings.selectedWorkspaceId = "";
      this.settings.targetFolder = "";
      await this.saveSettings();
      return;
    }
    const firstWorkspace = this.getDirectoryWorkspaces().find((item) =>
      sanitizeRelativeFolder(item.parentFolder) === parent
    );
    if (firstWorkspace) {
      this.applyDirectoryWorkspace(firstWorkspace.id);
      await this.saveSettings();
      return;
    }
    await this.ensureDirectoryWorkspace(parent, "");
  }

  async selectCourseFolder(courseFolder) {
    const parent = sanitizeRelativeFolder(this.settings.parentFolder);
    if (!parent) throw new Error("主目录必填。");
    await this.ensureDirectoryWorkspace(parent, sanitizeRelativeFolder(courseFolder));
  }

  async persistActiveDirectoryWorkspace() {
    if (!this.settings.selectedWorkspaceId) {
      await this.saveSettings();
      return null;
    }
    const workspaces = this.getDirectoryWorkspaces();
    const index = workspaces.findIndex((item) => item.id === this.settings.selectedWorkspaceId);
    if (index < 0) {
      await this.saveSettings();
      return null;
    }
    const workspace = this.collectDirectoryWorkspace(this.settings.selectedWorkspaceId);
    workspaces[index] = workspace;
    this.settings.targetFolder = workspace.targetFolder;
    await this.saveSettings();
    return workspace;
  }

  applyDirectoryWorkspace(workspaceId) {
    const workspace = this.getDirectoryWorkspaces().find((item) => item.id === workspaceId);
    if (!workspace) return false;

    this.settings.selectedWorkspaceId = workspace.id;
    this.settings.urlsText = workspace.urlsText || "";
    this.setDirectoryPath(this.getWorkspacePath(workspace));
    this.settings.startIndex = this.normalizePositiveInt(workspace.startIndex);
    this.settings.endIndex = this.normalizePositiveInt(workspace.endIndex);
    this.settings.maxWorkers = this.normalizePositiveInt(workspace.maxWorkers) || DEFAULT_SETTINGS.maxWorkers;
    this.settings.promptMode = this.normalizePromptMode(workspace.promptMode);
    this.settings.userPrompt = workspace.userPrompt || PROMPT_PRESETS[this.settings.promptMode].userPrompt;
    this.settings.outputRules = workspace.outputRules || PROMPT_PRESETS[this.settings.promptMode].outputRules || DEFAULT_OUTPUT_RULES;
    this.settings.downloadAllParts = false;
    return true;
  }

  async deleteDirectoryWorkspace(workspaceId) {
    this.settings.directoryWorkspaces = this.getDirectoryWorkspaces().filter((item) => item.id !== workspaceId);
    if (this.settings.selectedWorkspaceId === workspaceId) {
      this.settings.selectedWorkspaceId = "";
    }
    await this.saveSettings();
  }

  async deleteParentFolder(parentFolder) {
    const parent = sanitizeRelativeFolder(parentFolder);
    this.settings.directoryWorkspaces = this.getDirectoryWorkspaces().filter((item) =>
      sanitizeRelativeFolder(item.parentFolder) !== parent
    );
    if (sanitizeRelativeFolder(this.settings.parentFolder) === parent) {
      this.settings.selectedWorkspaceId = "";
      const next = this.settings.directoryWorkspaces[0];
      if (next) {
        this.applyDirectoryWorkspace(next.id);
      } else {
        this.settings.parentFolder = "";
        this.settings.courseFolder = "";
        this.settings.targetFolder = this.getCombinedTargetFolder();
      }
    }
    await this.saveSettings();
  }

  async deleteCourseFolder(parentFolder, courseFolder) {
    const parent = sanitizeRelativeFolder(parentFolder);
    const course = sanitizeRelativeFolder(courseFolder);
    this.settings.directoryWorkspaces = this.getDirectoryWorkspaces().filter((item) =>
      !(sanitizeRelativeFolder(item.parentFolder) === parent && sanitizeRelativeFolder(item.courseFolder) === course)
    );
    if (sanitizeRelativeFolder(this.settings.parentFolder) === parent && sanitizeRelativeFolder(this.settings.courseFolder) === course) {
      const next = this.findDirectoryWorkspace(parent, "") || this.getDirectoryWorkspaces().find((item) => sanitizeRelativeFolder(item.parentFolder) === parent);
      if (next) {
        this.applyDirectoryWorkspace(next.id);
      } else {
        await this.ensureDirectoryWorkspace(parent, "");
      }
    }
    await this.saveSettings();
  }

  async deleteDirectoryPath(directoryPath) {
    const target = sanitizeRelativeFolder(directoryPath);
    this.settings.directoryWorkspaces = this.getDirectoryWorkspaces().filter((item) =>
      this.getWorkspacePath(item) !== target && !this.getWorkspacePath(item).startsWith(`${target}/`)
    );
    const current = this.getCombinedTargetFolder();
    if (current === target || current.startsWith(`${target}/`)) {
      this.settings.selectedWorkspaceId = "";
      const next = this.settings.directoryWorkspaces[0];
      if (next) {
        this.applyDirectoryWorkspace(next.id);
      } else {
        this.setDirectoryPath("");
      }
    }
    await this.saveSettings();
  }

  async deleteCurrentDirectoryWithConfirm() {
    const targetFolder = this.getCombinedTargetFolder();
    if (!targetFolder) throw new Error("请先选择学习路径。");

    const label = `学习路径「${targetFolder}」`;
    const cachePath = this.getPluginWorkspaceOutputPath(targetFolder);
    const cacheHint = cachePath && fs.existsSync(cachePath) ? `\n同时会删除插件缓存文件夹：${cachePath}` : "\n当前没有找到对应插件缓存文件夹。";

    const confirmed = await confirmWithModal(
      this.app,
      "删除学习路径",
      `确定删除${label}吗？\n会删除插件里的该路径及其子路径配置。${cacheHint}\n不会删除 Obsidian 中你整理过的笔记。`,
      "删除"
    );
    if (!confirmed) {
      return false;
    }

    await this.deleteDirectoryPath(targetFolder);
    this.deletePluginCacheDirectory(targetFolder);
    new Notice(`${label}已删除。`);
    return true;
  }

  migrateFolderSettings() {
    const oldDefaultFolder = "AI 学习助手";
    let target = sanitizeRelativeFolder(this.settings.targetFolder || "");
    if (target === oldDefaultFolder && !this.settings.parentFolder && !this.settings.courseFolder) {
      target = "";
    }
    if (sanitizeRelativeFolder(this.settings.parentFolder) === oldDefaultFolder && !this.settings.courseFolder) {
      this.settings.parentFolder = "";
    }
    if (!this.settings.parentFolder && !this.settings.courseFolder) {
      const parts = target.split("/").filter(Boolean);
      if (parts.length > 1) {
        this.settings.parentFolder = parts.slice(0, -1).join("/");
        this.settings.courseFolder = parts[parts.length - 1];
      } else {
        this.settings.parentFolder = target;
        this.settings.courseFolder = "";
      }
    }
    this.settings.parentFolder = sanitizeRelativeFolder(this.settings.parentFolder);
    this.settings.courseFolder = sanitizeRelativeFolder(this.settings.courseFolder);
    this.setDirectoryPath(sanitizeRelativeFolder(this.settings.targetFolder) || joinRelativeFolders(this.settings.parentFolder, this.settings.courseFolder));
    if (!Array.isArray(this.settings.directoryWorkspaces)) {
      this.settings.directoryWorkspaces = [];
    }
    if (Array.isArray(this.settings.learningProfiles) && this.settings.learningProfiles.length && !this.settings.directoryWorkspaces.length) {
      this.settings.directoryWorkspaces = this.settings.learningProfiles.map((profile) => {
        const parentFolder = sanitizeRelativeFolder(profile.parentFolder);
        const courseFolder = sanitizeRelativeFolder(profile.courseFolder);
        const targetFolder = joinRelativeFolders(parentFolder, courseFolder);
        return Object.assign({}, profile, {
          id: profile.id || String(Date.now()),
          name: targetFolder,
          targetFolder,
          parentFolder,
          courseFolder
        });
      });
      this.settings.selectedWorkspaceId = this.settings.selectedProfileId || this.settings.selectedWorkspaceId || "";
    }
    this.settings.directoryWorkspaces = this.getDirectoryWorkspaces().map((workspace) => {
      const targetFolder = this.getWorkspacePath(workspace);
      const parts = this.splitDirectoryPath(targetFolder);
      const promptMode = this.normalizePromptMode(workspace.promptMode);
      const preset = PROMPT_PRESETS[promptMode] || PROMPT_PRESETS[DEFAULT_SETTINGS.promptMode];
      return Object.assign({}, workspace, {
        name: targetFolder,
        targetFolder,
        parentFolder: parts.parentFolder,
        courseFolder: parts.courseFolder,
        promptMode,
        userPrompt: workspace.userPrompt || preset.userPrompt,
        outputRules: workspace.outputRules || preset.outputRules || DEFAULT_OUTPUT_RULES
      });
    });
    this.settings.promptMode = this.normalizePromptMode(this.settings.promptMode);
    const currentPreset = PROMPT_PRESETS[this.settings.promptMode] || PROMPT_PRESETS[DEFAULT_SETTINGS.promptMode];
    this.settings.userPrompt = this.settings.userPrompt || currentPreset.userPrompt;
    this.settings.outputRules = this.settings.outputRules || currentPreset.outputRules || DEFAULT_OUTPUT_RULES;
    this.settings.systemPrompt = this.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  getCombinedTargetFolder() {
    return sanitizeRelativeFolder(this.settings.targetFolder) || joinRelativeFolders(
      this.settings.parentFolder,
      this.settings.courseFolder
    );
  }

  getRuntimePath() {
    if (this.settings.projectPath && this.settings.projectPath.trim()) {
      return this.settings.projectPath.trim();
    }
    const vaultBasePath = this.app.vault.adapter.basePath || "";
    const manifestDir = this.manifest.dir || path.join(".obsidian", "plugins", this.manifest.id);
    return path.resolve(vaultBasePath, manifestDir);
  }

  getModelConfigPath() {
    return path.resolve(this.getRuntimePath(), "config", "llm_models.json");
  }

  loadModels() {
    try {
      const configPath = this.getModelConfigPath();
      if (!fs.existsSync(configPath)) return [];
      const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      return Array.isArray(data.models) ? data.models : [];
    } catch (error) {
      console.error("加载模型配置失败:", error);
      return [];
    }
  }

  saveModels(models) {
    const configPath = this.getModelConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ models }, null, 2), "utf-8");
  }

  getCookieDisplayName() {
    if (this.settings.biliUserName) return this.settings.biliUserName;
    if (this.settings.sessdata) return "已配置，未验证";
    return "未配置";
  }

  refreshCookieUserName(onResolved) {
    if (!this.settings.sessdata || this.settings.biliUserName || this.biliUserLookupInFlight) return;
    this.biliUserLookupInFlight = true;
    this.fetchBiliUserName()
      .then((name) => {
        if (typeof onResolved === "function") onResolved(name);
      })
      .catch(() => {})
      .finally(() => {
        this.biliUserLookupInFlight = false;
      });
  }

  getUrls() {
    return String(this.settings.urlsText || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  collectRunState() {
    return {
      urls: this.getUrls(),
      parentFolder: this.getCombinedTargetFolder(),
      targetFolder: this.getCombinedTargetFolder(),
      workspaceName: this.getCombinedTargetFolder(),
      selectedModel: this.settings.selectedModel || "",
      startIndex: this.normalizePositiveInt(this.settings.startIndex),
      endIndex: this.normalizePositiveInt(this.settings.endIndex),
      maxWorkers: this.normalizePositiveInt(this.settings.maxWorkers) || DEFAULT_SETTINGS.maxWorkers,
      sessdata: extractCookieValue(this.settings.sessdata, "SESSDATA") || this.settings.sessdata || "",
      biliJct: extractCookieValue(this.settings.biliJct, "bili_jct") || this.settings.biliJct || "",
      buvid3: extractCookieValue(this.settings.buvid3, "buvid3") || this.settings.buvid3 || "",
      asrModelSize: this.settings.asrModelSize || DEFAULT_SETTINGS.asrModelSize,
      asrDevice: this.settings.asrDevice || DEFAULT_SETTINGS.asrDevice,
      asrComputeType: this.settings.asrComputeType || DEFAULT_SETTINGS.asrComputeType,
      promptMode: this.normalizePromptMode(this.settings.promptMode),
      systemPrompt: this.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      userPrompt: this.settings.userPrompt || "",
      outputRules: this.settings.outputRules || DEFAULT_OUTPUT_RULES,
      downloadAllParts: false
    };
  }

  validateRunState(state) {
    if (!state.urls.length) return "请先配置至少一个 Bilibili 视频网址。";
    if (!state.parentFolder) return "请先选择学习路径。";
    if (!state.targetFolder) return "请先配置目标目录。";
    if (!this.getNotesOutputPath(state.targetFolder)) {
      return "目标目录必须位于当前 Obsidian 仓库内，请使用相对路径。";
    }
    if (!state.selectedModel) return "请先选择模型。";
    if (state.startIndex && state.endIndex && Number.parseInt(state.startIndex, 10) > Number.parseInt(state.endIndex, 10)) {
      return "起始序号不能大于终止序号。";
    }
    const selectedModel = this.loadModels().find((model) => model.name === state.selectedModel);
    if (!selectedModel) {
      return "当前选择的模型不存在，请在设置页检查模型 API 配置。";
    }
    if (!selectedModel.model_name || !selectedModel.api_base || !selectedModel.api_key) {
      return "当前模型配置不完整，请在设置页填写模型标识、API 地址和 API 密钥。";
    }
    return "";
  }

  getNotesOutputPath(targetFolder) {
    const vaultBasePath = this.app.vault.adapter.basePath || "";
    const cleaned = sanitizeRelativeFolder(targetFolder);
    if (!vaultBasePath || !cleaned || path.isAbsolute(cleaned)) return "";

    const resolved = path.resolve(vaultBasePath, cleaned);
    const relative = path.relative(vaultBasePath, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
    return resolved;
  }

  getExistingCourseStatus(stateOrTargetFolder) {
    const targetFolder = typeof stateOrTargetFolder === "string"
      ? stateOrTargetFolder
      : stateOrTargetFolder?.targetFolder;
    const expectedCount = typeof stateOrTargetFolder === "string"
      ? null
      : this.getExpectedSelectedCount(stateOrTargetFolder);
    const pluginOutput = this.getPluginWorkspaceOutputPath(targetFolder);
    if (!pluginOutput || !fs.existsSync(pluginOutput)) {
      return { exists: false, markdownCount: 0, expectedCount, generatedCount: 0, matchedVideos: [] };
    }
    const markdownCount = this.countMarkdownFiles(pluginOutput);
    const matchedVideos = this.getGeneratedItemsInSelectedRange(pluginOutput, stateOrTargetFolder, expectedCount);
    return {
      exists: matchedVideos.length > 0,
      markdownCount,
      expectedCount,
      generatedCount: matchedVideos.length,
      matchedVideos
    };
  }

  getExpectedSelectedCount(state) {
    const startText = this.normalizePositiveInt(state?.startIndex);
    const endText = this.normalizePositiveInt(state?.endIndex);
    const start = startText ? Number.parseInt(startText, 10) : null;
    const end = endText ? Number.parseInt(endText, 10) : null;

    if (start && end && start <= end) return end - start + 1;
    if (!state?.downloadAllParts && Array.isArray(state?.urls) && state.urls.length) return state.urls.length;
    return null;
  }

  formatMatchedVideoList(matchedVideos) {
    const videos = Array.isArray(matchedVideos) ? matchedVideos : [];
    if (!videos.length) return "- 已有生成结果";
    const visible = videos.slice(0, 10).map((item, index) => {
      const prefix = item.sequence ? `${item.sequence}. ` : `${index + 1}. `;
      return `- ${prefix}${item.title || "未命名视频"}`;
    });
    if (videos.length > visible.length) {
      visible.push(`- 还有 ${videos.length - visible.length} 个已生成视频未显示`);
    }
    return visible.join("\n");
  }

  getPluginWorkspaceOutputPath(targetFolder) {
    const cleaned = sanitizeRelativeFolder(targetFolder);
    if (!cleaned || path.isAbsolute(cleaned) || cleaned.split("/").includes("..")) return "";
    return path.resolve(this.getRuntimePath(), "subtitles", cleaned);
  }

  deletePluginCacheDirectory(targetFolder) {
    const cachePath = this.getPluginWorkspaceOutputPath(targetFolder);
    if (!cachePath || !fs.existsSync(cachePath)) return false;

    const subtitlesRoot = path.resolve(this.getRuntimePath(), "subtitles");
    const relative = path.relative(subtitlesRoot, cachePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("缓存目录解析异常，已取消删除。");
    }
    fs.rmSync(cachePath, { recursive: true, force: true });
    return true;
  }

  countMarkdownFiles(directory) {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          count += this.countMarkdownFiles(fullPath);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          count += 1;
        }
      }
    } catch (error) {
      console.error("检查插件课程缓存失败:", error);
    }
    return count;
  }

  getGeneratedItemsInSelectedRange(directory, state, expectedCount) {
    if (!expectedCount) return [];
    const startText = this.normalizePositiveInt(state?.startIndex);
    const endText = this.normalizePositiveInt(state?.endIndex);
    const start = startText ? Number.parseInt(startText, 10) : null;
    const end = endText ? Number.parseInt(endText, 10) : null;

    if (!start || !end || start > end) {
      return this.collectMarkdownTitles(directory);
    }

    const markdownKeys = this.collectMarkdownTitleKeys(directory);
    if (!markdownKeys.size) return [];

    const matchedIndexes = new Set();
    const matchedVideos = [];
    for (const infoPath of this.collectVideoInfoFiles(directory)) {
      try {
        const videoInfo = JSON.parse(fs.readFileSync(infoPath, "utf8"));
        this.collectVideoInfoEntries(videoInfo).forEach((entry, index) => {
          const sequence = index + 1;
          if (sequence < start || sequence > end) return;
          const keys = [
            this.normalizeCacheTitle(entry.title),
            this.normalizeCacheTitle(entry.part),
            this.normalizeCacheTitle(entry.arcTitle)
          ].filter(Boolean);
          if (keys.some((key) => markdownKeys.has(key))) {
            if (!matchedIndexes.has(sequence)) {
              matchedIndexes.add(sequence);
              matchedVideos.push({
                sequence,
                title: entry.title || entry.arcTitle || entry.part || `第 ${sequence} 个视频`
              });
            }
          }
        });
      } catch (error) {
        console.error("读取视频缓存信息失败", error);
      }
    }
    return matchedVideos;
  }

  collectVideoInfoFiles(directory) {
    const files = [];
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          files.push(...this.collectVideoInfoFiles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith("_video_info.json")) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error("扫描视频缓存信息失败", error);
    }
    return files;
  }

  collectMarkdownTitleKeys(directory) {
    const keys = new Set();
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          for (const key of this.collectMarkdownTitleKeys(fullPath)) keys.add(key);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          const baseName = path.basename(entry.name, path.extname(entry.name));
          const parentName = path.basename(path.dirname(fullPath));
          const baseKey = this.normalizeCacheTitle(baseName);
          const parentKey = this.normalizeCacheTitle(parentName);
          if (baseKey) keys.add(baseKey);
          if (parentKey) keys.add(parentKey);
        }
      }
    } catch (error) {
      console.error("扫描 Markdown 缓存失败", error);
    }
    return keys;
  }

  collectMarkdownTitles(directory) {
    const titles = [];
    try {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          titles.push(...this.collectMarkdownTitles(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          titles.push({ title: path.basename(entry.name, path.extname(entry.name)) });
        }
      }
    } catch (error) {
      console.error("鎵弿 Markdown 缂撳瓨澶辫触", error);
    }
    return titles;
  }

  collectVideoInfoEntries(videoInfo) {
    const entries = [];
    const sections = videoInfo?.ugc_season?.sections || [];
    sections.forEach((section) => {
      (section.episodes || []).forEach((episode) => {
        const pages = episode.pages || [];
        if (pages.length > 1) {
          pages.forEach((page) => {
            entries.push({
              title: page.title || page.part || episode.title,
              part: page.part,
              arcTitle: episode.arc?.title || episode.title
            });
          });
          return;
        }
        entries.push({
          title: episode.title || episode.arc?.title,
          part: episode.page?.part,
          arcTitle: episode.arc?.title
        });
      });
    });

    if (entries.length) return entries;
    return (videoInfo?.pages || []).map((page) => ({
      title: page.title || page.part || videoInfo.title,
      part: page.part,
      arcTitle: videoInfo.title
    }));
  }

  normalizeCacheTitle(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/[_\-.，。！？；：、,.;!?\s]+/g, "")
      .trim();
  }

  getPythonCommand(runtimePath = this.getRuntimePath()) {
    if (this.settings.pythonCommand && this.settings.pythonCommand.trim()) {
      return this.settings.pythonCommand.trim();
    }

    const bundledPython = path.resolve(runtimePath, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(bundledPython)) {
      return `"${bundledPython}"`;
    }
    return "uv run python";
  }

  normalizePositiveInt(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return "";
    return String(parsed);
  }

  normalizePromptMode(value) {
    const mode = String(value || "").trim();
    return PROMPT_MODE_OPTIONS.some(([key]) => key === mode) ? mode : DEFAULT_SETTINGS.promptMode;
  }

  formatRangeCount(startValue, endValue) {
    const startText = this.normalizePositiveInt(startValue);
    const endText = this.normalizePositiveInt(endValue);
    const start = startText ? Number.parseInt(startText, 10) : null;
    const end = endText ? Number.parseInt(endText, 10) : null;

    if (start && end && start <= end) return `范围数量：${end - start + 1}`;
    if (start && end && start > end) return "范围数量：起止需调整";
    if (start) return `范围：从第 ${start} 个开始`;
    if (end) return `范围：至第 ${end} 个`;
    return "范围：不限";
  }

  buildCommand(state, options = {}) {
    if (!state.urls.length) return { display: "", command: "" };

    const runtimePath = this.getRuntimePath();
    const notesOutput = this.getNotesOutputPath(state.targetFolder);
    const projectOutput = path.resolve(runtimePath, "subtitles");
    const ffmpegPath = path.resolve(runtimePath, "tools", "ffmpeg", "bin", "ffmpeg.exe");
    const resultFile = path.resolve(runtimePath, ".tmp", `ai-learning-result-${Date.now()}.json`);
    const promptConfigFile = options.writePromptConfig
      ? (options.promptConfigFile || path.resolve(runtimePath, ".tmp", `ai-learning-prompt-${Date.now()}.json`))
      : "";
    const promptConfig = {
      mode: this.normalizePromptMode(state.promptMode),
      system_prompt: state.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      user_prompt: state.userPrompt || "",
      output_rules: state.outputRules || DEFAULT_OUTPUT_RULES
    };
    if (options.writePromptConfig) {
      fs.mkdirSync(path.dirname(promptConfigFile), { recursive: true });
      fs.writeFileSync(promptConfigFile, JSON.stringify(promptConfig, null, 2), "utf-8");
    }

    const args = [
      "-u",
      "cli.py",
      "generate",
      ...state.urls,
      "--output",
      projectOutput,
      "--notes-output",
      notesOutput,
      "--workspace-name",
      state.workspaceName,
      "--result-file",
      resultFile
    ];
    if (promptConfigFile) args.push("--prompt-config", promptConfigFile);

    if (state.selectedModel) args.push("--model-name", state.selectedModel);
    if (state.startIndex) args.push("--start-index", state.startIndex);
    if (state.endIndex) args.push("--end-index", state.endIndex);
    if (state.maxWorkers) args.push("--max-workers", state.maxWorkers);
    if (state.asrModelSize) args.push("--asr-model-size", state.asrModelSize);
    if (state.asrDevice) args.push("--asr-device", state.asrDevice);
    if (state.asrComputeType) args.push("--asr-compute-type", state.asrComputeType);
    if (state.sessdata) args.push("--sessdata", state.sessdata);
    if (state.biliJct) args.push("--bili-jct", state.biliJct);
    if (state.buvid3) args.push("--buvid3", state.buvid3);
    if (ffmpegPath) args.push("--ffmpeg-path", ffmpegPath);
    if (state.downloadAllParts) args.push("--download-all-parts");

    const quote = (value) => JSON.stringify(String(value));
    const pythonCommand = this.getPythonCommand(runtimePath);
    const command = [pythonCommand, ...args.map(quote)].join(" ");
    const displayArgs = args.map((arg, index) => {
      const previous = args[index - 1];
      if (["--sessdata", "--bili-jct", "--buvid3"].includes(previous)) {
        return "***";
      }
      return arg;
    });
    return {
      display: [pythonCommand, ...displayArgs.map(quote)].join(" "),
      command,
      resultFile,
      promptConfigFile
    };
  }

  runGenerate(state, onOutput) {
    const built = this.buildCommand(state, { writePromptConfig: true });
    if (!built.command) return Promise.reject(new Error("请先配置至少一个视频 URL。"));

    return new Promise((resolve, reject) => {
      if (built.resultFile) {
        fs.mkdirSync(path.dirname(built.resultFile), { recursive: true });
      }
      const child = spawn(built.command, {
        cwd: this.getRuntimePath(),
        env: Object.assign({}, process.env, {
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONUNBUFFERED: "1",
          UV_CACHE_DIR: path.resolve(this.getRuntimePath(), ".uv-cache"),
          UV_PYTHON_INSTALL_DIR: path.resolve(this.getRuntimePath(), ".uv-python"),
          UV_MANAGED_PYTHON: process.env.UV_MANAGED_PYTHON || "1",
          UV_PYTHON: process.env.UV_PYTHON || "3.12"
        }),
        shell: true,
        windowsHide: true
      });

      let stdout = "";
      let stderr = "";
      this.currentChild = child;

      child.stdout.on("data", (chunk) => {
        const text = Buffer.from(chunk).toString("utf8");
        stdout += text;
        onOutput(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = Buffer.from(chunk).toString("utf8");
        stderr += text;
        onOutput(text);
      });

      child.on("error", (error) => {
        this.currentChild = null;
        this.cleanupTempFile(built.promptConfigFile);
        reject(error);
      });
      child.on("close", (code) => {
        this.currentChild = null;
        this.cleanupTempFile(built.promptConfigFile);
        const result = this.parseCliResult(stdout) || this.readCliResultFile(built.resultFile);
        if (result) {
          if (!result.success && !result.error) {
            result.error = `CLI 退出码：${code}`;
          }
          if (!result.traceback && stderr) {
            result.traceback = stderr;
          }
          resolve(result);
          return;
        }
        const output = [stderr, stdout].filter(Boolean).join("\n");
        reject(new Error(`CLI 退出码：${code}。\n${output || "进程没有输出，可能在启动前失败或被系统终止。"}`));
      });
    });
  }

  cleanupTempFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      console.warn("清理临时文件失败:", error);
    }
  }

  stopGenerate() {
    const child = this.currentChild;
    if (!child || child.killed) return;

    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
      return;
    }
    child.kill("SIGTERM");
  }

  async fetchBiliUserName() {
    const cookies = [];
    if (this.settings.sessdata) cookies.push(`SESSDATA=${this.settings.sessdata}`);
    if (this.settings.biliJct) cookies.push(`bili_jct=${this.settings.biliJct}`);
    if (this.settings.buvid3) cookies.push(`buvid3=${this.settings.buvid3}`);
    if (!cookies.length) {
      throw new Error("请先填写 SESSDATA。");
    }

    const payload = await new Promise((resolve, reject) => {
      const request = https.get("https://api.bilibili.com/x/web-interface/nav", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.bilibili.com/",
          "Cookie": cookies.join("; "),
        },
        timeout: 10000,
      }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error("Bilibili 返回内容无法解析。"));
          }
        });
      });
      request.on("timeout", () => {
        request.destroy(new Error("验证 Cookie 超时。"));
      });
      request.on("error", reject);
    });

    if (payload.code !== 0) {
      throw new Error(payload.message || "Cookie 无效或已过期。");
    }
    const userName = payload.data?.uname || "";
    if (!userName) {
      throw new Error("未能读取 Bilibili 用户名。");
    }
    this.settings.biliUserName = userName;
    await this.saveSettings();
    return userName;
  }

  parseCliResult(stdout) {
    const start = stdout.lastIndexOf("__AI_LEARNING_RESULT_START__");
    const end = stdout.lastIndexOf("__AI_LEARNING_RESULT_END__");
    if (start === -1 || end === -1 || end <= start) return null;

    const jsonText = stdout
      .slice(start + "__AI_LEARNING_RESULT_START__".length, end)
      .trim();
    try {
      return JSON.parse(jsonText);
    } catch (error) {
      return null;
    }
  }

  readCliResultFile(resultFile) {
    if (!resultFile || !fs.existsSync(resultFile)) return null;
    try {
      const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
      try {
        fs.unlinkSync(resultFile);
      } catch (error) {
        console.warn("清理临时结果文件失败:", error);
      }
      return result;
    } catch (error) {
      return null;
    }
  }

  async openFirstGeneratedNote(result) {
    const copied = result.copied_notes || [];
    if (!copied.length) return "";

    const vaultBasePath = this.app.vault.adapter.basePath || "";
    const first = copied[0];
    let relativePath = path.relative(vaultBasePath, first);
    if (relativePath.startsWith("..")) return "";

    relativePath = normalizePath(relativePath.replace(/\\/g, "/"));
    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!file) {
      await this.app.workspace.openLinkText(relativePath, "", true);
      return relativePath;
    }

    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
    return relativePath;
  }
};

class AssistantSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Bili Note" });

    this.displayRuntime(containerEl);
    this.displayPrompt(containerEl);
    this.displayModels(containerEl);
    this.displayAsr(containerEl);
    this.displayCookies(containerEl);
  }

  displayRuntime(containerEl) {
    containerEl.createEl("h3", { text: "运行环境" });

    new Setting(containerEl)
      .setName("项目路径")
      .setDesc("可选。留空时使用插件目录内置的 Python 文件运行。")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getRuntimePath())
          .setValue(this.plugin.settings.projectPath)
          .onChange(async (value) => {
            this.plugin.settings.projectPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Python 命令")
      .setDesc("可选。留空时使用内置 .venv 中的 Python。")
      .addText((text) =>
        text
          .setPlaceholder(this.plugin.getPythonCommand())
          .setValue(this.plugin.settings.pythonCommand)
          .onChange(async (value) => {
            this.plugin.settings.pythonCommand = value.trim();
            await this.plugin.saveSettings();
          })
      );
  }

  displayPrompt(containerEl) {
    containerEl.createEl("h3", { text: "提示词" });

    const systemPromptSetting = new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("全局生效。目录里的用户提示词和输出规则会在运行时追加。")
      .addTextArea((text) => {
        text.inputEl.rows = 5;
        text.inputEl.addClass("ala-system-prompt-input");
        text
          .setPlaceholder(DEFAULT_SYSTEM_PROMPT)
          .setValue(this.plugin.settings.systemPrompt || DEFAULT_SYSTEM_PROMPT)
          .onChange(async (value) => {
            this.plugin.settings.systemPrompt = value.trim();
            await this.plugin.saveSettings();
          });
      });
    systemPromptSetting.settingEl.addClass("ala-system-prompt-setting");
  }

  displayModels(containerEl) {
    containerEl.createEl("h3", { text: "模型 API" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "这里会写入 config/llm_models.json，运行时通过模型名称传给 Python 流水线。"
    });

    const models = this.plugin.loadModels();
    new Setting(containerEl)
      .setName("默认模型")
      .setDesc("侧边栏运行时使用这里选择的模型。")
      .addDropdown((dropdown) => {
        dropdown.addOption("", models.length ? "请选择模型" : "请先添加模型");
        for (const model of models) {
          dropdown.addOption(model.name, model.name || "未命名模型");
        }
        dropdown
          .setValue(this.plugin.settings.selectedModel || "")
          .onChange(async (value) => {
            this.plugin.settings.selectedModel = value;
            await this.plugin.saveSettings();
          });
      });

    models.forEach((model) => this.displayModelSetting(containerEl, model));

    new Setting(containerEl)
      .setName("添加模型")
      .setDesc("新增一个 OpenAI 兼容接口模型。")
      .addButton((button) =>
        button
          .setButtonText("添加")
          .setCta()
          .onClick(() => {
            const next = Object.assign({}, DEFAULT_MODEL, {
              id: String(Date.now()),
              name: `模型 ${models.length + 1}`
            });
            this.plugin.saveModels([...models, next]);
            this.display();
          })
      );
  }

  displayModelSetting(containerEl, model) {
    const detail = containerEl.createDiv({ cls: "ala-settings-block" });
    detail.createEl("h4", { text: model.name || "未命名模型" });

    new Setting(detail)
      .setName("显示名称")
      .addText((text) =>
        text
          .setPlaceholder("例如：deepseek-v4-pro")
          .setValue(model.name || "")
          .onChange((value) => this.updateModel(model.id, { name: value.trim() }))
      );

    new Setting(detail)
      .setName("模型标识")
      .setDesc("服务商提供的 model 参数。")
      .addText((text) =>
        text
          .setPlaceholder("例如：deepseek-chat")
          .setValue(model.model_name || "")
          .onChange((value) => this.updateModel(model.id, { model_name: value.trim() }))
      );

    new Setting(detail)
      .setName("API 地址")
      .setDesc("OpenAI 兼容接口的 base URL。")
      .addText((text) =>
        text
          .setPlaceholder("https://api.example.com/v1")
          .setValue(model.api_base || "")
          .onChange((value) => this.updateModel(model.id, { api_base: value.trim() }))
      );

    new Setting(detail)
      .setName("API 密钥")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(model.api_key || "")
          .onChange((value) => this.updateModel(model.id, { api_key: value.trim() }));
      });

    new Setting(detail)
      .setName("作为侧边栏默认模型")
      .addButton((button) =>
        button
          .setButtonText(this.plugin.settings.selectedModel === model.name ? "当前默认" : "设为默认")
          .setDisabled(this.plugin.settings.selectedModel === model.name)
          .onClick(async () => {
            this.plugin.settings.selectedModel = model.name;
            await this.plugin.saveSettings();
            this.display();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("删除")
          .onClick(async () => {
            const models = this.plugin.loadModels().filter((item) => item.id !== model.id);
            this.plugin.saveModels(models);
            if (this.plugin.settings.selectedModel === model.name) {
              this.plugin.settings.selectedModel = models[0]?.name || "";
              await this.plugin.saveSettings();
            }
            this.display();
          })
      );
  }

  updateModel(id, patch) {
    const models = this.plugin.loadModels().map((model) =>
      model.id === id ? Object.assign({}, model, patch) : model
    );
    this.plugin.saveModels(models);
  }

  displayAsr(containerEl) {
    containerEl.createEl("h3", { text: "本地字幕转写" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "当视频没有在线字幕时，会使用 faster-whisper 进行本地ASR转写；模型会自动下载到插件目录的 models 文件夹。它和上面的 LLM 模型 API 不是同一个配置。"
    });

    new Setting(containerEl)
      .setName("ASR 模型大小")
      .setDesc("越小越快，准确率越低。建议先用 tiny 或 base 测通。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("tiny", "tiny（最快）")
          .addOption("base", "base（较快）")
          .addOption("small", "small（默认）")
          .addOption("medium", "medium（较慢）")
          .addOption("large-v3", "large-v3（最慢）")
          .setValue(this.plugin.settings.asrModelSize || DEFAULT_SETTINGS.asrModelSize)
          .onChange(async (value) => {
            this.plugin.settings.asrModelSize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ASR 运行设备")
      .setDesc("auto 默认使用 CPU，兼容性最好；CUDA 需要本机环境匹配，需手动选择。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "auto")
          .addOption("cpu", "cpu")
          .addOption("cuda", "cuda")
          .setValue(this.plugin.settings.asrDevice || DEFAULT_SETTINGS.asrDevice)
          .onChange(async (value) => {
            this.plugin.settings.asrDevice = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("ASR 计算类型")
      .setDesc("auto 会在 CPU 使用 int8，在 CUDA 使用 float16。优先保持 auto。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "auto")
          .addOption("int8", "int8")
          .addOption("float16", "float16")
          .addOption("float32", "float32")
          .setValue(this.plugin.settings.asrComputeType || DEFAULT_SETTINGS.asrComputeType)
          .onChange(async (value) => {
            this.plugin.settings.asrComputeType = value;
            await this.plugin.saveSettings();
          })
      );
  }

  displayCookies(containerEl) {
    containerEl.createEl("h3", { text: "Bilibili Cookie" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "这里填写的 Cookie 会在运行时直接传给后端；SESSDATA 通常是下载 AI 字幕所需的关键字段。"
    });

    new Setting(containerEl)
      .setName("当前用户")
      .setDesc(this.plugin.settings.biliUserName ? `已验证：${this.plugin.settings.biliUserName}` : "尚未验证 Cookie。")
      .addButton((button) =>
        button
          .setButtonText("验证并读取用户名")
          .onClick(async () => {
            try {
              button.setButtonText("验证中...");
              button.setDisabled(true);
              const userName = await this.plugin.fetchBiliUserName();
              new Notice(`Cookie 验证成功：${userName}`);
              this.display();
            } catch (error) {
              new Notice(error.message || String(error));
              button.setButtonText("验证并读取用户名");
              button.setDisabled(false);
            }
          })
      );

    new Setting(containerEl)
      .setName("SESSDATA")
      .setDesc("Bilibili 登录 Cookie，下载 AI 字幕通常需要它。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("粘贴 SESSDATA")
          .setValue(this.plugin.settings.sessdata)
          .onChange(async (value) => {
            this.plugin.settings.sessdata = value.trim();
            this.plugin.settings.biliUserName = "";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("bili_jct")
      .setDesc("后端支持的 Bilibili CSRF token，可选。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("粘贴 bili_jct")
          .setValue(this.plugin.settings.biliJct)
          .onChange(async (value) => {
            this.plugin.settings.biliJct = value.trim();
            this.plugin.settings.biliUserName = "";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("buvid3")
      .setDesc("后端支持的浏览器身份 Cookie，可选。")
      .addText((text) =>
        text
          .setPlaceholder("粘贴 buvid3")
          .setValue(this.plugin.settings.buvid3)
          .onChange(async (value) => {
            this.plugin.settings.buvid3 = value.trim();
            this.plugin.settings.biliUserName = "";
            await this.plugin.saveSettings();
          })
      );
  }
}

