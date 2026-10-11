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
  const getPreference = key => {
    const raw = localStorage.getItem(keyPrefix + key);
    if (raw == null) return defaults[key];
    if (raw === "true" || raw === "false") return raw === "true";
    return raw;
  };
  const setPreference = (key, value) => localStorage.setItem(keyPrefix + key, String(value));
  const log = (message, error) => console.warn(message, error || "");

  const { BrowserCodexClient } = global.ZoteroCodexModules.CodexClient;
  const { SidebarManager, SidebarView } = global.ZoteroCodexModules.Sidebar;
  const client = new BrowserCodexClient({ getPreference, log });
  const manager = new SidebarManager({ client, getPreference, setPreference, log });
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
      workingDirectory: paper.workingDirectory,
    };
  }

  async function mount(root) {
    if (view) return view;
    view = new SidebarView(manager, { doc: document, body: root, item: { id: 0, key: "none" }, tabType: "reader" });
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

  function addTextSelection(text) {
    if (!view?.context || !String(text || "").trim()) return false;
    manager.setLiveSelection(view.context.attachmentID, {
      id: global.crypto?.randomUUID?.() || `md-${Date.now()}`,
      text: String(text).trim(),
      pageLabel: "Markdown",
      pageNumber: "",
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

  function focus() { view?.elements?.input?.focus(); }

  global.AILiteratureChat = { mount, setPaper, addTextSelection, addLocalImage, focus, get view() { return view; } };
})(globalThis);
