(function (global) {
  "use strict";

  const defaults = {
    includeItemContext: true,
    paperOnlyChats: true,
    paperThreads: "{}",
    lastThreadId: "",
    model: "gpt-6-luna",
    reasoningEffort: "low",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
    networkAccess: false,
    showWorkProcess: true,
    sidebarHeight: 900,
    workingDirectory: "",
    codexPath: "",
    codexHome: "",
  };
  const keyPrefix = "ai-literature-reader.codex.";
  const persistentPreferences = {};
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const parsePreference = value => {
    if (value === "true" || value === "false") return value === "true";
    return value;
  };
  const getPreference = key => {
    const raw = hasOwn(persistentPreferences, key)
      ? persistentPreferences[key]
      : localStorage.getItem(keyPrefix + key);
    if (raw == null) return defaults[key];
    return parsePreference(raw);
  };
  const setPreference = (key, value) => {
    if (key === "paperPromptPresets") {
      // Only used to clear the old browser copy after migration to prompts/.
      delete persistentPreferences[key];
      localStorage.removeItem(keyPrefix + key);
      return;
    }
    const text = String(value);
    persistentPreferences[key] = text;
    localStorage.setItem(keyPrefix + key, text);
    const save = () => fetch("/api/ai/preferences", {
      method: "POST",
      cache: "no-store",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { [key]: text } }),
    });
    void save().catch(error => log("保存 Codex 对话设置失败", error));
  };
  const log = (message, error) => console.warn(message, error || "");

  async function loadPersistentPreferences() {
    try {
      const response = await fetch("/api/ai/preferences", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "读取 AI 设置失败");
      Object.assign(persistentPreferences, data.preferences || {});
      const migration = {};
      for (const key of Object.keys(defaults)) {
        const local = localStorage.getItem(keyPrefix + key);
        if (!hasOwn(persistentPreferences, key) && local != null) {
          persistentPreferences[key] = local;
          migration[key] = local;
        }
        else if (hasOwn(persistentPreferences, key)) {
          localStorage.setItem(keyPrefix + key, persistentPreferences[key]);
        }
      }
      if (Object.keys(migration).length) {
        await fetch("/api/ai/preferences", {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ preferences: migration }),
        });
      }
    }
    catch (error) {
      log("读取持久化 Codex 对话设置失败，将使用当前窗口设置", error);
    }
  }

  const { BrowserCodexClient } = global.ZoteroCodexModules.CodexClient;
  const { SidebarManager, SidebarView } = global.ZoteroCodexModules.Sidebar;
  let client = null;
  let manager = null;
  let view = null;
  let currentPaper = null;

  function contextFromPaper(paper) {
    return {
      itemID: paper.attachmentID,
      attachmentID: paper.attachmentID,
      itemKey: paper.itemKey,
      title: paper.name,
      creators: "",
      date: "",
      abstract: "",
      pdfPath: paper.pdfPath,
      markdownPath: paper.markdownPath,
      preferredTextPath: paper.preferredTextPath,
      workingDirectory: paper.workingDirectory,
    };
  }

  async function mount(root) {
    if (view) return view;
    await loadPersistentPreferences();
    const apiMode = getPreference("aiProvider") === "api";
    const prefs = apiMode ? global.PaperBenchApi.preferences(getPreference, setPreference) : { get: getPreference, set: setPreference };
    client = apiMode ? new global.PaperBenchApi.CompatibleApiClient({ getPreference: prefs.get, log }) : new BrowserCodexClient({ getPreference, log });
    manager = new SidebarManager({ client, getPreference: prefs.get, setPreference: prefs.set, log });
    if (apiMode) manager.paperDirectory = context => context?.workingDirectory || "";
    view = new SidebarView(manager, { doc: document, body: root, item: { id: 0, key: "none" }, tabType: "reader" });
    global.PaperBenchApi.installSettings(view, apiMode ? "api" : "codex");
    manager.views.set(root, view);
    view.refreshContext = async () => {
      if (!currentPaper) return null;
      const context = contextFromPaper(currentPaper);
      view.context = context;
      view.item = { id: context.itemID, key: context.itemKey };
      view.elements.contextMeta.textContent = context.title;
      view.elements.contextMeta.title = `${context.title}\n工作区：${context.workingDirectory}`;
      view.renderSelections();
      view.renderContextAttachment();
      return context;
    };
    await view.initialize();
    return view;
  }

  async function setPaper(paper) {
    currentPaper = paper;
    if (!view) return;
    manager.saveRuntimeDraft?.(view);
    view.contextEpoch += 1;
    view.contextTransitioning = true;
    view.threadID = "";
    view.thread = null;
    view.activePaperKey = "";
    view.images = [];
    const context = await view.refreshContext();
    await view.refreshThreads();
    await view.activatePaperConversation(view.contextEpoch);
    view.contextTransitioning = false;
    view.updateComposerState();
    manager.restoreRuntimeDraft?.(view);
    return context;
  }

  function addTextSelection(text, page) {
    if (!view?.context || !String(text || "").trim()) return false;
    manager.setLiveSelection(view.context.attachmentID, {
      id: global.crypto?.randomUUID?.() || `md-${Date.now()}`,
      text: String(text).trim(),
      pageLabel: page ? String(page) : "Markdown",
      pageNumber: page || "",
    });
    view.renderSelections();
    view.elements.input.focus();
    return true;
  }

  async function addLocalImage({ file, url }) {
    if (!view || !currentPaper || !file) return false;
    const result = await fetch(`/api/ai/image-path?paper=${encodeURIComponent(currentPaper.path)}&file=${encodeURIComponent(file)}`, { cache: "no-store" });
    const data = await result.json();
    if (!result.ok) throw new Error(data.error || "无法读取论文图片");
    if (view.images.length >= 10) throw new Error("最多附加 10 张图片。");
    view.images.push({
      id: global.crypto?.randomUUID?.() || `image-${Date.now()}`,
      name: data.name, size: data.size, type: data.type, path: data.path, url, detail: "auto",
    });
    view.renderContextAttachment();
    view.updateComposerState();
    view.elements.input.focus();
    return true;
  }

  async function addScreenshot(url, page) {
    if (!view || !currentPaper || view.running || view.contextTransitioning) return false;
    const paper = currentPaper;
    if (view.images.length >= 10) throw new Error('最多附加 10 张图片');
    const before = view.images.length;
    const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) throw new Error('截图格式无效');
    const bytes = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/png' });
    if (blob.size > 20 * 1024 * 1024) throw new Error('截图超过 20 MB，请缩小选区');
    if (paper !== currentPaper) return false;
    await view.addImageFiles([new File([blob], `PDF 第 ${page} 页截图.png`, { type: 'image/png' })]);
    return paper === currentPaper && view.images.length > before;
  }
  function focus() { view?.elements?.input?.focus(); }
  function setPreferredText(path) {
    if (currentPaper) currentPaper.preferredTextPath = path;
    if (view?.context) view.context.preferredTextPath = path;
  }

  global.AILiteratureChat = { mount, setPaper, addTextSelection, addLocalImage, addScreenshot, setPreferredText, focus, get view() { return view; } };
})(globalThis);
