(function (global) {
  "use strict";
  const { BrowserCodexClient } = global.ZoteroCodexModules.CodexClient;
  const Protocol = global.ZoteroCodexModules.Protocol;
  async function request(url, body) {
    const response = await fetch(url, { cache: "no-store", ...(body === undefined ? {} : {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `API 请求失败：${response.status}`);
    return value;
  }
  // Reuse the sidebar's client interface, not Codex's process or transport.
  class CompatibleApiClient extends BrowserCodexClient {
    async connect() {
      if (this.process) return this;
      if (this.connecting) return this.connecting;
      this.connecting = (async () => {
        this.config = await request("/api/compatible/config");
        this.process = {}; this.binaryPath = "OpenAI 兼容 API"; this.account = null;
        this.emit({ type: "connected", binaryPath: this.binaryPath });
        this.startEventLoop(); return this;
      })().finally(() => { this.connecting = null; });
      return this.connecting;
    }
    async request(method, params = {}) {
      await this.connect();
      return (await request("/api/compatible/rpc", { method, parameters: params })).result;
    }
    startEventLoop() {
      if (this.polling) return;
      this.polling = true;
      void (async () => {
        while (this.polling) {
          try {
            const data = await request(`/api/compatible/events?after=${this.lastSequence}`);
            this.lastSequence = Math.max(this.lastSequence, data.last || 0);
            for (const event of data.events || []) this.emit({ type: event.type, method: event.method, params: event.parameters });
          } catch (error) { this.log("API 事件连接中断", error); await new Promise(resolve => setTimeout(resolve, 1200)); }
        }
      })();
    }
    async listModels() {
      await this.connect();
      const model = this.config.model || "请在设置中填写 API 模型";
      return [{ id: model, model, displayName: model, supportedReasoningEfforts: [] }];
    }
    async listSkills() { return []; }
    async startThread({ cwd, title } = {}) {
      const result = await this.request("thread/start", { cwd, title });
      this.loadedThreads.add(result.thread.id); return result.thread;
    }
    async startTurn({ threadID, text, images, context } = {}) {
      const result = await this.request("turn/start", {
        threadId: threadID, input: Protocol.buildTurnInput(text, images), context,
        includePaper: Boolean(this.getPreference("includeItemContext")),
      });
      return result.turn;
    }
    async translateText(text) { return (await request("/api/compatible/translate", { text })).text; }
    async archiveThread(id) { await super.archiveThread(id); this.emit({ type: "notification", method: "thread/archived", params: { threadId: id } }); }
    async deleteThread(id) { await super.deleteThread(id); this.emit({ type: "notification", method: "thread/deleted", params: { threadId: id } }); }
  }
  const scopedKeys = new Set(["paperThreads", "lastThreadId", "model", "reasoningEffort", "includeItemContext", "paperOnlyChats"]);
  const scopedName = key => `api${key[0].toUpperCase()}${key.slice(1)}`;
  function preferences(get, set) {
    return {
      get: key => scopedKeys.has(key) ? get(scopedName(key)) ?? ({ paperThreads: "{}", lastThreadId: "", model: "", reasoningEffort: "", includeItemContext: true, paperOnlyChats: true })[key] : get(key),
      set: (key, value) => set(scopedKeys.has(key) ? scopedName(key) : key, value),
    };
  }
  function installSettings(view, provider) {
    const doc = view.doc, content = view.elements.settingsView.querySelector(".zcs-settings-content");
    const form = doc.createElement("form"); form.className = "pb-api-settings";
    form.innerHTML = `<strong>AI 连接方式</strong>
      <label>当前通道<select name="provider"><option value="codex">Codex（默认）</option><option value="api">自定义 API（OpenAI 兼容）</option></select></label>
      <div class="pb-api-fields" hidden>
        <label>Base URL<input name="baseUrl" type="url" placeholder="https://服务地址/v1" autocomplete="off"></label>
        <label>API Key<input name="apiKey" type="password" autocomplete="new-password" placeholder="本机服务可留空"></label><small>更换服务主机时需重新填写密钥；不会把原服务的密钥发送给新服务。</small>
        <label>模型名称<input name="model" placeholder="服务商提供的模型 ID" autocomplete="off"></label>
        <details><summary>上下文设置</summary><label>论文和历史文字的字符上限<input name="maxContextCharacters" type="number" min="4000" max="1000000" value="120000"></label><small>超过上限会提示，不会静默截断。字符数不等于模型的 token 数；图片也会占用模型上下文。</small></details>
        <small>使用 Chat Completions 接口。论文文本自动提供；图片需模型支持。密钥仅在本机加密保存。此通道不执行 Codex 技能和命令。</small>
        <button type="button" class="pb-api-clear-key">清除已保存的密钥</button>
      </div>
      <button type="submit">保存并应用</button><p role="status" class="pb-api-status"></p>`;
    const style = doc.createElement("style"); style.textContent = `.pb-api-settings{display:grid;gap:12px;margin-bottom:20px;padding:14px;border:1px solid #dce1e8;border-radius:10px;background:#fff}.pb-api-settings label,.pb-api-fields{display:grid;gap:6px}.pb-api-fields{gap:12px}.pb-api-settings input,.pb-api-settings select{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cdd5df;border-radius:6px;background:#fff;color:#334155}.pb-api-settings small{font-size:11px;line-height:1.6;color:#64748b}.pb-api-settings button{padding:8px;border:1px solid #cdd5df;border-radius:6px;background:#f5f7fa;color:#334155;cursor:pointer}.pb-api-settings [hidden]{display:none!important}.pb-api-status{margin:0;font-size:12px;line-height:1.6;white-space:pre-wrap}`;
    form.append(style); content.prepend(form);
    const fields = form.querySelector(".pb-api-fields"), status = form.querySelector(".pb-api-status");
    form.elements.provider.value = provider;
    let loaded = false, clearKey = false;
    const load = async () => {
      if (loaded) return;
      try {
        const config = await request("/api/compatible/config");
        form.elements.baseUrl.value = config.baseUrl || ""; form.elements.model.value = config.model || "";
        form.elements.maxContextCharacters.value = config.maxContextCharacters;
        if (config.hasKey) form.elements.apiKey.placeholder = "密钥已保存；留空保留原值";
        loaded = true;
      } catch (error) { status.textContent = error.message; }
    };
    const update = () => { fields.hidden = form.elements.provider.value !== "api"; if (!fields.hidden) void load(); };
    form.elements.provider.addEventListener("change", update); update();
    form.querySelector(".pb-api-clear-key").onclick = () => { clearKey = true; form.elements.apiKey.value = ""; status.textContent = "保存后将清除密钥。"; };
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (view.running || view.manager.runningTurns.size || view.creatingTask) { status.textContent = "请先等待当前回复完成或停止回复，再切换连接。"; return; }
      const next = form.elements.provider.value;
      const button = form.querySelector('[type="submit"]'); button.disabled = true;
      try {
        if (next === "api") {
          if (!loaded) throw new Error("连接设置尚未读取成功，请重新打开设置。");
          if (!form.elements.baseUrl.value.trim() || !form.elements.model.value.trim()) throw new Error("请填写 Base URL 和模型名称。");
          await request("/api/compatible/config", { baseUrl: form.elements.baseUrl.value, apiKey: form.elements.apiKey.value,
            model: form.elements.model.value, maxContextCharacters: Number(form.elements.maxContextCharacters.value), clearKey });
        }
        await request("/api/ai/preferences", { preferences: { aiProvider: next } });
        localStorage.setItem("ai-literature-reader.codex.aiProvider", next);
        // Explicit channel changes reload the client, leaving its old runtime/history untouched.
        global.location.reload();
      } catch (error) { status.textContent = error.message; button.disabled = false; }
    });
    if (provider === "api") {
      view.elements.root.dataset.provider = "api";
      const connection = view.elements.connectionCard;
      connection.hidden = true; if (connection.previousElementSibling) connection.previousElementSibling.hidden = true;
      if (connection.nextElementSibling?.classList.contains("zcs-settings-note")) connection.nextElementSibling.hidden = true;
      view.elements.generateImageOption.hidden = true;
      view.elements.root.querySelectorAll(".zcs-permissions-trigger").forEach(el => { el.hidden = true; });
      view.elements.root.setAttribute("aria-label", "OpenAI 兼容 API");
      const heading = doc.querySelector(".ai-panel-heading");
      if (heading) { heading.querySelector("strong").textContent = "自定义 API"; heading.querySelector("small").textContent = "论文上下文自动提供"; }
      const renderEmpty = view.renderEmpty.bind(view);
      view.renderEmpty = (...args) => {
        renderEmpty(...args);
        const title = view.elements.transcript.querySelector('.zcs-empty-title[data-l10n-id="zotero-codex-start-reading"]');
        if (title) { title.removeAttribute("data-l10n-id"); title.textContent = "阅读与讨论论文"; }
      };
      const notice = doc.createElement("p"); notice.className = "pb-api-error"; notice.hidden = true;
      notice.setAttribute("role", "alert"); notice.style.cssText = "margin:0;padding:8px 12px;color:#a34235;font-size:12px;white-space:pre-wrap";
      view.elements.composer.before(notice);
      const showError = view.showError.bind(view), send = view.send.bind(view);
      view.showError = error => { notice.textContent = String(error?.message || error); notice.hidden = false; showError(error); };
      view.send = (...args) => { notice.hidden = true; return send(...args); };
    }
  }
  async function translateText(text, codex) {
    const settings = await request("/api/ai/preferences");
    return settings.preferences?.aiProvider === "api" ? new CompatibleApiClient().translateText(text) : codex.translateText(text);
  }
  global.PaperBenchApi = { CompatibleApiClient, preferences, installSettings, translateText };
})(globalThis);
