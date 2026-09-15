// ============================================================
// Codeforge — AI coding companion
// Everything runs client-side. The only network call is to
// Google's Gemini API, made directly from the browser using
// the key you provide in Settings.
// ============================================================
(() => {
  "use strict";

  // ---------- Storage helpers ----------
  const LS = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
    },
    remove(key) { try { localStorage.removeItem(key); } catch {} }
  };

  const STORE_KEYS = {
    apiKey: "cf_api_key",
    model: "cf_model",
    theme: "cf_theme",
    systemPrompt: "cf_system_prompt",
    files: "cf_files_v1",
    activeFile: "cf_active_file",
    chats: "cf_chats_v1",
    chatWidth: "cf_chat_width"
  };

  // ---------- Language mode mapping ----------
  const LANG_MODES = {
    javascript: { mode: "javascript", ext: "js" },
    jsx: { mode: { name: "javascript", jsx: true }, ext: "jsx" },
    python: { mode: "python", ext: "py" },
    htmlmixed: { mode: "htmlmixed", ext: "html" },
    css: { mode: "css", ext: "css" },
    "clike-c": { mode: { name: "clike", useCPP: false }, ext: "c" },
    "clike-cpp": { mode: "text/x-c++src", ext: "cpp" },
    "clike-java": { mode: "text/x-java", ext: "java" },
    shell: { mode: "shell", ext: "sh" },
    markdown: { mode: "markdown", ext: "md" },
    plain: { mode: null, ext: "txt" }
  };

  const DEFAULT_FILE_CONTENT =
`// Welcome to Codeforge.
// Write or paste code here, then ask the assistant on the right
// for help — it can see this file automatically.

function greet(name) {
  return \`Hello, \${name}!\`;
}

console.log(greet("world"));
`;

  // ---------- State ----------
  let files = LS.get(STORE_KEYS.files, null) || [
    { id: cryptoId(), name: "scratch.js", lang: "javascript", content: DEFAULT_FILE_CONTENT, dirty: false }
  ];
  let activeFileId = LS.get(STORE_KEYS.activeFile, null) || files[0].id;
  let chats = LS.get(STORE_KEYS.chats, {}); // per-file chat history { fileId: [{role, text}] }
  let editor = null;
  let suppressChange = false;
  let currentAbortController = null;
  let previewOpen = false;
  let previewDebounceTimer = null;

  function cryptoId() {
    return (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  }

  function getActiveFile() {
    return files.find(f => f.id === activeFileId) || files[0];
  }

  function persistFiles() {
    LS.set(STORE_KEYS.files, files);
    LS.set(STORE_KEYS.activeFile, activeFileId);
  }
  function persistChats() { LS.set(STORE_KEYS.chats, chats); }

  // ---------- DOM refs ----------
  const $ = sel => document.querySelector(sel);
  const tabbar = $("#tabbar");
  const editorHost = $("#editorHost");
  const langSelect = $("#langSelect");
  const editorStatus = $("#editorStatus");
  const runBtn = $("#runBtn");
  const previewPanel = $("#previewPanel");
  const previewFrame = $("#previewFrame");
  const chatLog = $("#chatLog");
  const chatEmpty = $("#chatEmpty");
  const chatForm = $("#chatForm");
  const chatInput = $("#chatInput");
  const sendBtn = $("#sendBtn");
  const includeContext = $("#includeContext");
  const apiStatus = $("#apiStatus");
  const modelLabel = $("#modelLabel");
  const connState = $("#connState");

  // ---------- Toast ----------
  let toastTimer = null;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
  }

  function extForLang(lang) {
    return LANG_MODES[lang]?.ext || "txt";
  }
  function baseName(name) {
    const idx = name.lastIndexOf(".");
    return idx > 0 ? name.slice(0, idx) : name;
  }
  function renameExtensionForLang(f, lang) {
    f.name = baseName(f.name) + "." + extForLang(lang);
  }

  // ============================================================
  // HTML preview ("Run")
  // ============================================================
  function updateRunButtonVisibility() {
    const f = getActiveFile();
    runBtn.hidden = f.lang !== "htmlmixed";
  }

  function renderPreview() {
    const f = getActiveFile();
    // srcdoc gives the iframe an isolated, unique origin — the sandboxed
    // preview can never read or touch the parent app (no allow-same-origin).
    previewFrame.srcdoc = f.content;
  }

  function openPreview() {
    previewPanel.hidden = false;
    previewOpen = true;
    runBtn.classList.add("active");
    renderPreview();
    if (editor) editor.refresh();
  }

  function closePreview() {
    previewPanel.hidden = true;
    previewOpen = false;
    runBtn.classList.remove("active");
    if (editor) editor.refresh();
  }

  function initPreview() {
    runBtn.addEventListener("click", () => {
      if (previewOpen) closePreview(); else openPreview();
    });
    $("#closePreviewBtn").addEventListener("click", closePreview);
    $("#refreshPreviewBtn").addEventListener("click", renderPreview);
    $("#openPreviewTabBtn").addEventListener("click", () => {
      const f = getActiveFile();
      const blob = new Blob([f.content], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
  }

  // ============================================================
  // Editor
  // ============================================================
  function initEditor() {
    const file = getActiveFile();
    editor = CodeMirror(editorHost, {
      value: file.content,
      mode: LANG_MODES[file.lang]?.mode || null,
      theme: (LS.get(STORE_KEYS.theme, "forge-dark")),
      lineNumbers: true,
      lineWrapping: false,
      tabSize: 2,
      indentUnit: 2,
      matchBrackets: true,
      autoCloseBrackets: true,
      styleActiveLine: true,
      viewportMargin: 500
    });

    editor.on("change", () => {
      if (suppressChange) return;
      const f = getActiveFile();
      f.content = editor.getValue();
      f.dirty = true;
      persistFiles();
      renderTabs();
      debouncedSaveIndicator();
      if (previewOpen && f.lang === "htmlmixed") {
        clearTimeout(previewDebounceTimer);
        previewDebounceTimer = setTimeout(renderPreview, 400);
      }
    });

    editor.on("cursorActivity", () => {
      const pos = editor.getCursor();
      editorStatus.textContent = `Ln ${pos.line + 1}, Col ${pos.ch + 1}`;
    });

    langSelect.value = file.lang;
    langSelect.addEventListener("change", () => {
      const f = getActiveFile();
      f.lang = langSelect.value;
      f.dirty = true;
      renameExtensionForLang(f, f.lang);
      const def = LANG_MODES[f.lang];
      editor.setOption("mode", def?.mode || null);
      persistFiles();
      renderTabs();
      updateRunButtonVisibility();
      if (previewOpen) {
        if (f.lang === "htmlmixed") renderPreview();
        else closePreview();
      }
    });
  }

  let saveIndicatorTimer = null;
  function debouncedSaveIndicator() {
    clearTimeout(saveIndicatorTimer);
    saveIndicatorTimer = setTimeout(() => {
      const f = getActiveFile();
      f.dirty = false;
      persistFiles();
      renderTabs();
    }, 600);
  }

  function switchToFile(id) {
    activeFileId = id;
    const f = getActiveFile();
    suppressChange = true;
    editor.setValue(f.content);
    suppressChange = false;
    langSelect.value = f.lang;
    editor.setOption("mode", LANG_MODES[f.lang]?.mode || null);
    editor.focus();
    persistFiles();
    renderTabs();
    renderChat();
    updateRunButtonVisibility();
    if (previewOpen) {
      if (f.lang === "htmlmixed") renderPreview();
      else closePreview();
    }
  }

  function newFile() {
    const n = files.length + 1;
    const lang = "javascript";
    const f = { id: cryptoId(), name: `untitled-${n}.${extForLang(lang)}`, lang, content: "", dirty: false };
    files.push(f);
    switchToFile(f.id);
  }

  function closeFile(id) {
    const idx = files.findIndex(f => f.id === id);
    if (idx === -1) return;
    if (files.length === 1) {
      files[0] = { id: cryptoId(), name: "scratch.js", lang: "javascript", content: "", dirty: false };
      activeFileId = files[0].id;
      delete chats[id];
      suppressChange = true;
      editor.setValue(files[0].content);
      suppressChange = false;
      langSelect.value = files[0].lang;
      editor.setOption("mode", LANG_MODES[files[0].lang]?.mode || null);
      persistFiles(); persistChats(); renderTabs(); renderChat();
      updateRunButtonVisibility();
      closePreview();
      return;
    }
    files.splice(idx, 1);
    delete chats[id];
    persistChats();
    if (activeFileId === id) {
      const next = files[Math.max(0, idx - 1)];
      switchToFile(next.id);
    } else {
      persistFiles();
      renderTabs();
    }
  }

  function renameFile(id) {
    const f = files.find(x => x.id === id);
    if (!f) return;
    const next = prompt("Rename file", f.name);
    if (next && next.trim()) {
      f.name = next.trim();
      persistFiles();
      renderTabs();
    }
  }

  function renderTabs() {
    tabbar.innerHTML = "";
    for (const f of files) {
      const tab = document.createElement("div");
      tab.className = "tab" + (f.id === activeFileId ? " active" : "") + (f.dirty ? " unsaved" : "");
      tab.title = f.name;

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = f.name;
      tab.appendChild(name);

      const dot = document.createElement("span");
      dot.className = "tab-dot";
      tab.appendChild(dot);

      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = "&times;";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeFile(f.id); });
      tab.appendChild(close);

      tab.addEventListener("click", () => switchToFile(f.id));
      tab.addEventListener("dblclick", () => renameFile(f.id));
      tabbar.appendChild(tab);
    }
  }

  function downloadCurrentFile() {
    const f = getActiveFile();
    const blob = new Blob([f.content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name || "file.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ============================================================
  // Resizer (drag to resize chat pane)
  // ============================================================
  function initResizer() {
    const resizer = $("#resizer");
    const chatPane = $("#chatPane");
    let dragging = false;

    const savedWidth = LS.get(STORE_KEYS.chatWidth, null);
    if (savedWidth) chatPane.style.width = savedWidth + "px";

    resizer.addEventListener("pointerdown", (e) => {
      dragging = true;
      resizer.classList.add("active");
      resizer.setPointerCapture(e.pointerId);
    });
    resizer.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const workspaceRect = document.querySelector(".workspace").getBoundingClientRect();
      let newWidth = workspaceRect.right - e.clientX;
      newWidth = Math.max(280, Math.min(newWidth, workspaceRect.width * 0.7));
      chatPane.style.width = newWidth + "px";
    });
    function stopDrag() {
      if (!dragging) return;
      dragging = false;
      resizer.classList.remove("active");
      LS.set(STORE_KEYS.chatWidth, parseInt(chatPane.style.width, 10));
      if (editor) editor.refresh();
    }
    resizer.addEventListener("pointerup", stopDrag);
    resizer.addEventListener("pointercancel", stopDrag);

    resizer.addEventListener("keydown", (e) => {
      const step = 24;
      let w = chatPane.getBoundingClientRect().width;
      if (e.key === "ArrowLeft") w += step;
      else if (e.key === "ArrowRight") w -= step;
      else return;
      e.preventDefault();
      chatPane.style.width = w + "px";
      LS.set(STORE_KEYS.chatWidth, w);
      if (editor) editor.refresh();
    });
  }

  // ============================================================
  // Settings modal
  // ============================================================
  function initSettings() {
    const backdrop = $("#settingsBackdrop");
    const openBtn = $("#settingsBtn");
    const closeBtn = $("#closeSettingsBtn");
    const saveBtn = $("#saveSettingsBtn");
    const clearBtn = $("#clearKeyBtn");
    const keyInput = $("#apiKeyInput");
    const toggleVis = $("#toggleKeyVisibility");
    const modelSelect = $("#modelSelect");
    const themeSelect = $("#themeSelect");
    const systemPromptInput = $("#systemPromptInput");

    function open() {
      keyInput.value = LS.get(STORE_KEYS.apiKey, "") || "";
      modelSelect.value = LS.get(STORE_KEYS.model, "gemini-3.8-flash");
      themeSelect.value = LS.get(STORE_KEYS.theme, "forge-dark");
      systemPromptInput.value = LS.get(STORE_KEYS.systemPrompt, "") || "";
      backdrop.hidden = false;
      keyInput.focus();
    }
    function close() { backdrop.hidden = true; }

    openBtn.addEventListener("click", open);
    closeBtn.addEventListener("click", close);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !backdrop.hidden) close(); });

    toggleVis.addEventListener("click", () => {
      keyInput.type = keyInput.type === "password" ? "text" : "password";
    });

    saveBtn.addEventListener("click", () => {
      const key = keyInput.value.trim();
      LS.set(STORE_KEYS.apiKey, key);
      LS.set(STORE_KEYS.model, modelSelect.value);
      LS.set(STORE_KEYS.theme, themeSelect.value);
      LS.set(STORE_KEYS.systemPrompt, systemPromptInput.value);
      applyTheme(themeSelect.value);
      updateStatusBar();
      close();
      toast("Settings saved");
    });

    clearBtn.addEventListener("click", () => {
      LS.remove(STORE_KEYS.apiKey);
      keyInput.value = "";
      updateStatusBar();
      toast("API key removed");
    });
  }

  function applyTheme(themeName) {
    document.body.dataset.theme = themeName;
    if (editor) editor.setOption("theme", themeName);
  }

  function updateStatusBar() {
    const key = LS.get(STORE_KEYS.apiKey, "");
    if (key) {
      apiStatus.textContent = "API key set";
      apiStatus.className = "status-pill status-ready";
    } else {
      apiStatus.textContent = "No API key set";
      apiStatus.className = "status-pill status-missing";
    }
    modelLabel.textContent = LS.get(STORE_KEYS.model, "gemini-3.8-flash");
  }

  // ============================================================
  // Confirm dialog (generic)
  // ============================================================
  function confirmDialog(text) {
    return new Promise((resolve) => {
      const backdrop = $("#confirmBackdrop");
      $("#confirmText").textContent = text;
      backdrop.hidden = false;
      const ok = $("#confirmOkBtn");
      const cancel = $("#confirmCancelBtn");
      function cleanup(result) {
        backdrop.hidden = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        resolve(result);
      }
      function onOk() { cleanup(true); }
      function onCancel() { cleanup(false); }
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
    });
  }

  // ============================================================
  // Chat rendering
  // ============================================================
  function getFileChat() {
    const id = activeFileId;
    if (!chats[id]) chats[id] = [];
    return chats[id];
  }

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Very small markdown-ish renderer: fenced code blocks + inline code + paragraphs
  function renderMarkdownish(text) {
    const wrap = document.createElement("div");
    wrap.className = "msg-bubble";
    const fenceRe = /```([\w+-]*)\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;
    let hasBlock = false;

    function appendText(chunk) {
      if (!chunk) return;
      const p = document.createElement("p");
      // inline code spans
      const parts = chunk.split(/(`[^`\n]+`)/g);
      parts.forEach(part => {
        if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
          const code = document.createElement("code");
          code.textContent = part.slice(1, -1);
          p.appendChild(code);
        } else {
          p.appendChild(document.createTextNode(part));
        }
      });
      wrap.appendChild(p);
    }

    while ((match = fenceRe.exec(text)) !== null) {
      hasBlock = true;
      const before = text.slice(lastIndex, match.index);
      if (before.trim()) appendText(before.trim());

      const lang = match[1] || "";
      const code = match[2].replace(/\n$/, "");
      const block = document.createElement("div");
      block.className = "code-block";
      const head = document.createElement("div");
      head.className = "code-block-head";
      const label = document.createElement("span");
      label.textContent = lang || "code";
      head.appendChild(label);
      const actions = document.createElement("div");
      actions.className = "code-block-actions";
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", () => {
        navigator.clipboard?.writeText(code).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => copyBtn.textContent = "Copy", 1200);
        });
      });
      const insertBtn = document.createElement("button");
      insertBtn.type = "button";
      insertBtn.textContent = "Insert";
      insertBtn.addEventListener("click", () => {
        if (!editor) return;
        editor.replaceSelection(code);
        editor.focus();
        toast("Inserted into editor");
      });
      actions.appendChild(copyBtn);
      actions.appendChild(insertBtn);
      head.appendChild(actions);
      block.appendChild(head);
      const pre = document.createElement("pre");
      pre.textContent = code;
      block.appendChild(pre);
      wrap.appendChild(block);

      lastIndex = fenceRe.lastIndex;
    }
    const rest = text.slice(lastIndex);
    if (rest.trim() || !hasBlock) appendText(rest);

    return wrap;
  }

  function renderChat() {
    const history = getFileChat();
    chatLog.innerHTML = "";
    if (history.length === 0) {
      chatLog.appendChild(chatEmpty.cloneNode(true));
      return;
    }
    for (const m of history) {
      chatLog.appendChild(buildMsgEl(m.role, m.text));
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  function buildMsgEl(role, text) {
    const el = document.createElement("div");
    el.className = "msg " + role;
    const roleLabel = document.createElement("div");
    roleLabel.className = "msg-role";
    roleLabel.textContent = role === "user" ? "You" : "Codeforge";
    el.appendChild(roleLabel);
    el.appendChild(renderMarkdownish(text || ""));
    return el;
  }

  // ============================================================
  // Gemini API
  // ============================================================
  function buildLanguageName(lang) {
    const names = {
      javascript: "JavaScript", jsx: "JSX/React", python: "Python",
      htmlmixed: "HTML", css: "CSS", "clike-c": "C", "clike-cpp": "C++",
      "clike-java": "Java", shell: "Shell", markdown: "Markdown", plain: "text"
    };
    return names[lang] || lang;
  }

  function buildPrompt(userText) {
    const f = getActiveFile();
    const systemPrompt = LS.get(STORE_KEYS.systemPrompt, "");
    let context = "";
    if (includeContext.checked && f.content.trim()) {
      context = `The user is editing a ${buildLanguageName(f.lang)} file named "${f.name}". Current contents:\n\`\`\`${f.lang}\n${f.content}\n\`\`\`\n\n`;
    }
    const base = "You are Codeforge, a concise, expert coding assistant embedded in a code editor. Give direct, correct answers. Prefer showing code in fenced code blocks. Avoid unnecessary preamble.";
    const sys = [base, systemPrompt].filter(Boolean).join("\n\n");
    return { sys, context, userText };
  }

  async function callGemini(userText, onChunk, history) {
    const apiKey = LS.get(STORE_KEYS.apiKey, "");
    if (!apiKey) {
      throw new Error("NO_KEY");
    }
    const model = LS.get(STORE_KEYS.model, "gemini-3.8-flash");
    const { sys, context } = buildPrompt(userText);

    // Build contents from the explicit history passed in (excludes the
    // still-empty streaming placeholder the caller appended for display).
    const contents = history.map(m => ({
      role: m.role === "user" ? "user" : "model",
      parts: [{ text: m.text }]
    }));
    // Prepend file context to the latest user turn only, without mutating stored text
    if (context && contents.length) {
      const last = contents[contents.length - 1];
      if (last.role === "user") {
        last.parts = [{ text: context + last.parts[0].text }];
      }
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

    currentAbortController = new AbortController();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: currentAbortController.signal,
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: sys }] },
        generationConfig: { temperature: 0.4 }
      })
    });

    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = j.error?.message || ""; } catch {}
      const err = new Error(detail || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr || jsonStr === "[DONE]") continue;
        try {
          const obj = JSON.parse(jsonStr);
          const parts = obj.candidates?.[0]?.content?.parts || [];
          const textChunk = parts.map(p => p.text || "").join("");
          if (textChunk) {
            full += textChunk;
            onChunk(full);
          }
        } catch { /* ignore partial JSON */ }
      }
    }
    return full;
  }

  // ============================================================
  // Chat submit
  // ============================================================
  async function handleSend(e) {
    e.preventDefault();
    if (sendBtn.dataset.mode === "stop") {
      currentAbortController?.abort();
      return;
    }
    const text = chatInput.value.trim();
    if (!text) return;

    const apiKey = LS.get(STORE_KEYS.apiKey, "");
    if (!apiKey) {
      $("#settingsBtn").click();
      toast("Add a Gemini API key first");
      return;
    }

    const history = getFileChat();
    history.push({ role: "user", text });
    persistChats();
    renderChat();
    chatInput.value = "";
    autoGrow(chatInput);
    setSending(true);

    // streaming assistant placeholder
    const placeholder = { role: "assistant", text: "" };
    history.push(placeholder);
    persistChats();
    const el = buildMsgEl("assistant", "");
    el.classList.add("streaming");
    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
      const sendHistory = history.slice(0, -1); // exclude the empty streaming placeholder
      await callGemini(text, (partial) => {
        placeholder.text = partial;
        const bubble = el.querySelector(".msg-bubble");
        const fresh = renderMarkdownish(partial);
        bubble.replaceWith(fresh);
        chatLog.scrollTop = chatLog.scrollHeight;
      }, sendHistory);
      el.classList.remove("streaming");
      persistChats();
    } catch (err) {
      el.classList.remove("streaming");
      let msg = "Something went wrong reaching Gemini.";
      if (err.message === "NO_KEY") {
        msg = "No API key set. Open Settings to add one.";
      } else if (err.status === 400) {
        msg = "Request rejected (400). Check your API key or model choice.";
      } else if (err.status === 403) {
        msg = "Key rejected (403). Verify the API key is valid and has access to this model.";
      } else if (err.status === 429) {
        msg = "Rate limited (429). Wait a moment and try again.";
      } else if (err.name === "AbortError") {
        msg = "Stopped.";
      } else if (err.message) {
        msg = err.message;
      }
      placeholder.text = msg;
      placeholder.error = true;
      el.classList.add("msg-error");
      const bubble = el.querySelector(".msg-bubble");
      bubble.textContent = msg;
      persistChats();
    } finally {
      setSending(false);
    }
  }

  function setSending(isSending) {
    if (isSending) {
      sendBtn.dataset.mode = "stop";
      sendBtn.title = "Stop";
      sendBtn.setAttribute("aria-label", "Stop generating");
      sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg>';
    } else {
      sendBtn.disabled = false;
      sendBtn.dataset.mode = "send";
      sendBtn.title = "Send";
      sendBtn.setAttribute("aria-label", "Send message");
      sendBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }
  }

  function autoGrow(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 160) + "px";
  }

  function initChat() {
    chatForm.addEventListener("submit", handleSend);
    chatInput.addEventListener("input", () => autoGrow(chatInput));
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        chatForm.requestSubmit();
      }
    });
    $("#clearChatBtn").addEventListener("click", async () => {
      if (getFileChat().length === 0) return;
      const ok = await confirmDialog("Clear this file's conversation? This can't be undone.");
      if (ok) {
        chats[activeFileId] = [];
        persistChats();
        renderChat();
      }
    });
  }

  // ============================================================
  // PWA install prompt
  // ============================================================
  function initInstall() {
    const btn = $("#installBtn");
    let deferredPrompt = null;
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      btn.hidden = false;
    });
    btn.addEventListener("click", async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      btn.hidden = true;
    });
    window.addEventListener("appinstalled", () => { btn.hidden = true; });
  }

  function initServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      connState.textContent = "offline: unsupported";
      return;
    }
    if (location.protocol === "file:") {
      connState.textContent = "offline-ready: needs http(s)";
      return;
    }
    navigator.serviceWorker.register("sw.js").then(() => {
      connState.textContent = navigator.onLine ? "offline-ready" : "offline";
    }).catch(() => {
      connState.textContent = "offline-ready: failed";
    });
    window.addEventListener("online", () => connState.textContent = "offline-ready");
    window.addEventListener("offline", () => connState.textContent = "offline");
  }

  // ============================================================
  // Wire up top-level buttons
  // ============================================================
  function initToolbar() {
    $("#newFileBtn").addEventListener("click", newFile);
    $("#downloadBtn").addEventListener("click", downloadCurrentFile);
  }

  // ============================================================
  // Boot
  // ============================================================
  // One-time migration: Google retired the 2.x Gemini model family this
  // model this app originally shipped with. If a returning user has an
  // old model id saved, move them to the current default instead of
  // silently failing every request.
  function migrateStoredModel() {
    const saved = LS.get(STORE_KEYS.model, null);
    if (saved && /^gemini-[12]\./.test(saved)) {
      LS.set(STORE_KEYS.model, "gemini-3.8-flash");
    }
  }

  function boot() {
    migrateStoredModel();
    applyTheme(LS.get(STORE_KEYS.theme, "forge-dark"));
    initEditor();
    renderTabs();
    renderChat();
    initResizer();
    initSettings();
    initChat();
    initToolbar();
    initPreview();
    updateRunButtonVisibility();
    initInstall();
    initServiceWorker();
    updateStatusBar();

    window.addEventListener("beforeunload", (e) => {
      const anyDirty = files.some(f => f.dirty);
      // Content is already persisted to localStorage on every change,
      // so this is just a courtesy — no data is actually at risk.
    });

    window.addEventListener("resize", () => { if (editor) editor.refresh(); });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
