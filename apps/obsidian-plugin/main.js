"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => MarkLabPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian4 = require("obsidian");

// src/active-note.ts
var import_obsidian = require("obsidian");
var ActiveNoteError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "ActiveNoteError";
    this.code = code;
  }
};
function hasFullPath(adapter) {
  return typeof adapter?.getFullPath === "function";
}
function resolveActiveMarkdownFilePath(app) {
  const activeFile = app.workspace.getActiveFile();
  if (!activeFile) {
    throw new ActiveNoteError("no_active_file", "Open a Markdown note before using MarkLab.");
  }
  return resolveMarkdownFilePath(app, activeFile);
}
function resolveMarkdownFilePath(app, file) {
  if (file.extension.toLowerCase() !== "md") {
    throw new ActiveNoteError("not_markdown", "MarkLab can only share Markdown notes.");
  }
  const adapter = app.vault.adapter;
  if (!hasFullPath(adapter)) {
    throw new ActiveNoteError("unsupported_vault_adapter", "This vault adapter cannot provide a desktop file path.");
  }
  return adapter.getFullPath((0, import_obsidian.normalizePath)(file.path));
}
function humanizeActiveNoteError(error) {
  if (error instanceof ActiveNoteError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

// src/cli-adapter.ts
var import_node_child_process = require("node:child_process");
var MarkLabCliError = class extends Error {
  code;
  details;
  exitCode;
  stderr;
  constructor(code, message, options = {}) {
    super(message);
    this.name = "MarkLabCliError";
    this.code = code;
    this.details = options.details;
    this.exitCode = options.exitCode ?? null;
    this.stderr = options.stderr ?? "";
  }
};
var DEFAULT_TIMEOUT_MS = 1e4;
function splitCommandLine(input) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;
  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (quote) throw new MarkLabCliError("invalid_target", "CLI command setting has an unmatched quote.");
  if (current) parts.push(current);
  return parts;
}
function commandParts(commandLine) {
  const parts = splitCommandLine(commandLine);
  return parts.length > 0 ? parts : ["marklab"];
}
function trimTrailingSlash(value) {
  return value.replace(/\/+$/u, "");
}
function relayEnvFromOverride(rawOverride) {
  const override = rawOverride?.trim();
  if (!override) return {};
  let url;
  try {
    url = new URL(override);
  } catch {
    throw new MarkLabCliError("invalid_target", "Hosted relay URL override must be an absolute http:// or https:// URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MarkLabCliError("invalid_target", "Hosted relay URL override must start with http:// or https://.");
  }
  url.hash = "";
  url.search = "";
  const normalizedPath = trimTrailingSlash(url.pathname === "/" ? "" : url.pathname);
  const basePath = normalizedPath.endsWith("/relay") ? trimTrailingSlash(normalizedPath.slice(0, -"/relay".length)) : normalizedPath;
  const baseUrl = trimTrailingSlash(`${url.protocol}//${url.host}${basePath}`);
  const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const relayPath = `${basePath}/relay`.replace(/\/{2,}/gu, "/");
  return {
    MARKLAB_PUBLIC_WEB_URL: baseUrl,
    MARKLAB_PUBLIC_API_URL: baseUrl,
    MARKLAB_PUBLIC_RELAY_WS_URL: `${websocketProtocol}//${url.host}${relayPath}`
  };
}
function mergedEnv(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === void 0) delete env[key];
  }
  return env;
}
var defaultCommandExecutor = (command, args, options) => {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeout;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    const child = (0, import_node_child_process.spawn)(command, args, {
      env: mergedEnv(options.env),
      shell: false,
      windowsHide: true
    });
    timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settle({ exitCode: null, signal: null, stdout, stderr, error, timedOut });
    });
    child.on("close", (exitCode, signal) => {
      settle({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
};
function parseJsonOutput(stdout, stderr, exitCode) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new MarkLabCliError("invalid_json", "MarkLab CLI returned invalid JSON.", {
      details: { stdout, stderr },
      exitCode,
      stderr
    });
  }
}
function commandUnavailableMessage(command) {
  return `MarkLab CLI is not available at "${command}". Check the plugin setting or install @marklab/cli.`;
}
var MarkLabCliAdapter = class {
  commandLine;
  relayUrlOverride;
  timeoutMs;
  executor;
  constructor(options) {
    this.commandLine = options.command || "marklab";
    this.relayUrlOverride = options.relayUrlOverride ?? "";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.executor = options.executor ?? defaultCommandExecutor;
  }
  async checkSetup() {
    const invocation = commandParts(this.commandLine);
    const [command, ...prefixArgs] = invocation;
    const result = await this.executor(command ?? "marklab", [...prefixArgs, "--help"], {
      env: {},
      timeoutMs: Math.min(this.timeoutMs, 5e3)
    });
    if (result.timedOut) {
      return { available: false, command: this.commandLine, message: "MarkLab CLI did not respond before the setup check timed out." };
    }
    if (result.error?.code === "ENOENT") {
      return { available: false, command: this.commandLine, message: commandUnavailableMessage(this.commandLine) };
    }
    if (result.exitCode !== 0) {
      return {
        available: false,
        command: this.commandLine,
        message: result.stderr.trim() || result.stdout.trim() || `MarkLab CLI exited with code ${result.exitCode ?? "unknown"}.`
      };
    }
    return { available: true, command: this.commandLine, message: "MarkLab CLI is available." };
  }
  status(filePath) {
    return this.runJson(["status", filePath, "--json"]);
  }
  shareState(filePath) {
    return this.runJson(["share-state", filePath, "--json"]);
  }
  createLink(filePath, role) {
    return this.runJson(["create-link", filePath, "--role", role, "--json"]);
  }
  async openBackground(filePath, options = {}) {
    const args = ["open", filePath, "--background"];
    if (options.openBrowser === false) args.push("--no-browser");
    await this.runText(args);
  }
  async stop(filePath) {
    await this.runText(["stop", filePath]);
  }
  async execute(args) {
    const invocation = commandParts(this.commandLine);
    const [command, ...prefixArgs] = invocation;
    return this.executor(command ?? "marklab", [...prefixArgs, ...args], {
      env: relayEnvFromOverride(this.relayUrlOverride),
      timeoutMs: this.timeoutMs
    });
  }
  async runText(args) {
    const result = await this.execute(args);
    this.throwIfCommandFailed(result);
    return result.stdout;
  }
  async runJson(args) {
    const result = await this.execute(args);
    if (result.timedOut) {
      throw new MarkLabCliError("timeout", "MarkLab CLI command timed out.", { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.error?.code === "ENOENT") {
      throw new MarkLabCliError("cli_unavailable", commandUnavailableMessage(this.commandLine), { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.exitCode !== 0) {
      if (result.stdout.trim()) {
        const parsed2 = parseJsonOutput(result.stdout, result.stderr, result.exitCode);
        if ("ok" in parsed2 && parsed2.ok === false) {
          throw new MarkLabCliError(parsed2.code ?? "command_failed", parsed2.message ?? "MarkLab CLI command failed.", {
            details: parsed2.details,
            stderr: result.stderr,
            exitCode: result.exitCode
          });
        }
      }
      throw new MarkLabCliError("command_failed", result.stderr.trim() || "MarkLab CLI command failed.", {
        stderr: result.stderr,
        exitCode: result.exitCode
      });
    }
    const parsed = parseJsonOutput(result.stdout, result.stderr, result.exitCode);
    if (!("ok" in parsed) || parsed.ok !== true) {
      throw new MarkLabCliError("invalid_json", "MarkLab CLI JSON did not include ok: true.", {
        details: parsed,
        stderr: result.stderr,
        exitCode: result.exitCode
      });
    }
    return parsed;
  }
  throwIfCommandFailed(result) {
    if (result.timedOut) {
      throw new MarkLabCliError("timeout", "MarkLab CLI command timed out.", { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.error?.code === "ENOENT") {
      throw new MarkLabCliError("cli_unavailable", commandUnavailableMessage(this.commandLine), { stderr: result.stderr, exitCode: result.exitCode });
    }
    if (result.exitCode !== 0) {
      throw new MarkLabCliError("command_failed", result.stderr.trim() || "MarkLab CLI command failed.", {
        stderr: result.stderr,
        exitCode: result.exitCode
      });
    }
  }
};
function humanizeCliError(error) {
  if (!(error instanceof MarkLabCliError)) {
    return error instanceof Error ? error.message : String(error);
  }
  switch (error.code) {
    case "cli_unavailable":
      return error.message;
    case "daemon_not_running":
    case "file_not_watched":
      return "This note is not currently hosted by MarkLab.";
    case "relay_unavailable":
      return "MarkLab could not reach the relay. Check your network or relay settings.";
    case "host_offline":
      return "The host is offline. Open MarkLab again on the host machine.";
    case "sync_paused":
    case "conflict_required":
      return "MarkLab sync is paused for this note. Inspect the conflict before continuing.";
    case "invalid_target":
      return error.message;
    case "timeout":
      return "MarkLab CLI did not respond before the command timed out.";
    default:
      return error.message;
  }
}

// src/handoff.ts
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replace(/'/gu, "'\\''")}'`;
}
function commandPrefix(cliCommand) {
  try {
    const parts = splitCommandLine(cliCommand);
    return parts.length > 0 ? parts : ["marklab"];
  } catch {
    return ["marklab"];
  }
}
function formatCommand(cliCommand, args) {
  return [...commandPrefix(cliCommand), ...args].map(shellQuote).join(" ");
}
function buildAiHandoffInstructions(input) {
  const { filePath, cliCommand } = input;
  const quotedFilePath = shellQuote(filePath);
  const statusCommand = formatCommand(cliCommand, ["status", filePath, "--json"]);
  const saveVersionCommand = formatCommand(cliCommand, ["save-version", filePath, "--message", "Before AI edit: <reason>", "--json"]);
  const waitCommand = formatCommand(cliCommand, ["wait", filePath, "--synced", "--timeout", "10000", "--json"]);
  const conflictCommand = formatCommand(cliCommand, ["conflict", filePath, "--json"]);
  return [
    "# MarkLab AI handoff",
    "",
    `Work on this local Markdown file: ${quotedFilePath}`,
    "",
    "The local `.md` file is the canonical document; edit that file directly. Do not use a hosted write API.",
    "",
    "Before broad edits, create a local MarkLab checkpoint:",
    "",
    `\`\`\`sh
${saveVersionCommand}
\`\`\``,
    "",
    "Check coordination state before editing:",
    "",
    `\`\`\`sh
${statusCommand}
\`\`\``,
    "",
    "After editing, wait for MarkLab sync:",
    "",
    `\`\`\`sh
${waitCommand}
\`\`\``,
    "",
    "If MarkLab reports `paused`, `hasConflict`, `host_offline`, `sync_paused`, or a conflict-required state, stop editing and inspect the conflict:",
    "",
    `\`\`\`sh
${conflictCommand}
\`\`\``,
    "",
    "Do not mutate hosted relay state, Yjs state, Postgres rows, Fly/Neon infrastructure, or any hosted AI write/edit endpoint directly."
  ].join("\n");
}

// src/settings.ts
var import_obsidian2 = require("obsidian");
var DEFAULT_SETTINGS = {
  cliCommand: "marklab",
  relayUrlOverride: "",
  defaultLinkRole: "view",
  backgroundHostingPreference: "ask",
  copyCreatedLinksAutomatically: true
};
function normalizeSettings(data) {
  const defaultLinkRole = data?.defaultLinkRole === "edit" ? "edit" : "view";
  const backgroundHostingPreference = data?.backgroundHostingPreference === "never" ? "never" : "ask";
  return {
    cliCommand: data?.cliCommand?.trim() || DEFAULT_SETTINGS.cliCommand,
    relayUrlOverride: data?.relayUrlOverride?.trim() || DEFAULT_SETTINGS.relayUrlOverride,
    defaultLinkRole,
    backgroundHostingPreference,
    copyCreatedLinksAutomatically: data?.copyCreatedLinksAutomatically ?? DEFAULT_SETTINGS.copyCreatedLinksAutomatically
  };
}
var MarkLabSettingTab = class extends import_obsidian2.PluginSettingTab {
  plugin;
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "MarkLab" });
    new import_obsidian2.Setting(containerEl).setName("CLI command").setDesc("Command used to run MarkLab. Use marklab by default, or a command such as npx -y @marklab/cli.").addText((text) => {
      text.setPlaceholder(DEFAULT_SETTINGS.cliCommand).setValue(this.plugin.settings.cliCommand).onChange(async (value) => {
        this.plugin.settings.cliCommand = value.trim() || DEFAULT_SETTINGS.cliCommand;
        this.plugin.rebuildCliAdapter();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Hosted relay URL override").setDesc("Optional self-hosted relay base URL. Leave blank to use the MarkLab CLI default.").addText((text) => {
      text.setPlaceholder("https://marklab-relay-alpha.fly.dev").setValue(this.plugin.settings.relayUrlOverride).onChange(async (value) => {
        this.plugin.settings.relayUrlOverride = value.trim();
        this.plugin.rebuildCliAdapter();
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Default link role").setDesc("Role used by Share current note.").addDropdown((dropdown) => {
      dropdown.addOption("view", "View").addOption("edit", "Edit").setValue(this.plugin.settings.defaultLinkRole).onChange(async (value) => {
        this.plugin.settings.defaultLinkRole = value === "edit" ? "edit" : "view";
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Background hosting").setDesc("Choose whether MarkLab can offer to start persistent background hosting for the active note.").addDropdown((dropdown) => {
      dropdown.addOption("ask", "Ask before starting").addOption("never", "Never start automatically").setValue(this.plugin.settings.backgroundHostingPreference).onChange(async (value) => {
        this.plugin.settings.backgroundHostingPreference = value === "never" ? "never" : "ask";
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian2.Setting(containerEl).setName("Copy created links automatically").setDesc("Copy new MarkLab relay links to the clipboard after creation.").addToggle((toggle) => {
      toggle.setValue(this.plugin.settings.copyCreatedLinksAutomatically).onChange(async (value) => {
        this.plugin.settings.copyCreatedLinksAutomatically = value;
        await this.plugin.saveSettings();
      });
    });
  }
};

// src/share-guard.ts
function sharingBlockReason(entry) {
  if (!entry || entry.daemon !== "running") return null;
  if (entry.hasConflict) return "MarkLab reports a conflict for this note. Inspect the conflict before creating a share link.";
  switch (entry.syncState) {
    case "paused":
    case "sync_paused":
      return "MarkLab sync is paused for this note. Resume or resolve sync before creating a share link.";
    case "host_offline":
      return "MarkLab reports the host as offline. Reopen MarkLab on the host before creating a share link.";
    case "error":
      return "MarkLab status is unavailable for this note. Check MarkLab before creating a share link.";
    default:
      return null;
  }
}

// src/sharing-modal.ts
var import_obsidian3 = require("obsidian");
function normalizeShareScope(value) {
  if (value === "multiple" || value === "vault") return value;
  return "single";
}
var MarkLabSharingModal = class extends import_obsidian3.Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
    this.role = options.defaultRole;
    this.selectedFilePath = options.markdownFiles.find((file) => file.isActive)?.filePath ?? options.markdownFiles[0]?.filePath ?? "";
    const defaultMultipleSelection = options.markdownFiles.filter((file) => file.isActive).map((file) => file.filePath);
    for (const filePath of defaultMultipleSelection.length > 0 ? defaultMultipleSelection : [this.selectedFilePath]) {
      if (filePath) this.selectedMultipleFilePaths.add(filePath);
    }
  }
  options;
  shareScope = "single";
  role;
  selectedFilePath;
  selectedMultipleFilePaths = /* @__PURE__ */ new Set();
  onOpen() {
    this.render();
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "MarkLab sharing" });
    contentEl.createEl("p", {
      text: "Create MarkLab relay links for Markdown files in this vault."
    });
    new import_obsidian3.Setting(contentEl).setName("Scope").setDesc("Single-page, multiple-page, and vault Markdown sharing are available as explicit scopes.").addDropdown((dropdown) => {
      dropdown.addOption("single", "Single Markdown page").addOption("multiple", "Multiple Markdown pages").addOption("vault", "Entire vault Markdown").setValue(this.shareScope).onChange((value) => {
        this.shareScope = normalizeShareScope(value);
        this.render();
      });
    });
    if (this.shareScope === "single") {
      this.renderSinglePage();
      return;
    }
    if (this.shareScope === "multiple") {
      this.renderMultiplePages();
      return;
    }
    this.renderVault();
  }
  renderSinglePage() {
    const { contentEl } = this;
    const selectedFile = this.options.markdownFiles.find((file) => file.filePath === this.selectedFilePath);
    contentEl.createEl("h3", { text: "Single Markdown page" });
    contentEl.createEl("p", {
      text: selectedFile?.isActive ? `Active note: ${selectedFile.label}` : "Choose the Markdown page to share. The vault file remains the canonical source."
    });
    new import_obsidian3.Setting(contentEl).setName("Markdown page").setDesc("Pick one Markdown file from this vault.").addDropdown((dropdown) => {
      for (const file of this.options.markdownFiles) {
        dropdown.addOption(file.filePath, file.isActive ? `${file.label} (active)` : file.label);
      }
      dropdown.setValue(this.selectedFilePath).onChange((value) => {
        this.selectedFilePath = value;
        this.render();
      });
    });
    new import_obsidian3.Setting(contentEl).setName("Link role").setDesc("Edit links allow collaborators to write. View links are read-only.").addDropdown((dropdown) => {
      dropdown.addOption("view", "View").addOption("edit", "Edit").setValue(this.role).onChange((value) => {
        this.role = value === "edit" ? "edit" : "view";
        this.render();
      });
    });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const createButton = actions.createEl("button", { text: `Create ${this.role} link` });
    createButton.addClass("mod-cta");
    createButton.addEventListener("click", () => {
      void this.createLink(createButton);
    });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.close();
    });
  }
  renderMultiplePages() {
    const { contentEl } = this;
    const selectedFiles = this.selectedMultipleFiles();
    contentEl.createEl("h3", { text: "Multiple Markdown pages" });
    contentEl.createEl("p", {
      text: "Create a shareable link set with one MarkLab relay link per selected Markdown page."
    });
    new import_obsidian3.Setting(contentEl).setName("Link role").setDesc("The same role is used for every selected page.").addDropdown((dropdown) => {
      dropdown.addOption("view", "View").addOption("edit", "Edit").setValue(this.role).onChange((value) => {
        this.role = value === "edit" ? "edit" : "view";
        this.render();
      });
    });
    const selectionControls = contentEl.createDiv({ cls: "marklab-share-selection-controls" });
    const selectAllButton = selectionControls.createEl("button", { text: "Select all" });
    selectAllButton.addEventListener("click", () => {
      this.selectedMultipleFilePaths.clear();
      for (const file of this.options.markdownFiles) this.selectedMultipleFilePaths.add(file.filePath);
      this.render();
    });
    const clearButton = selectionControls.createEl("button", { text: "Clear" });
    clearButton.addEventListener("click", () => {
      this.selectedMultipleFilePaths.clear();
      this.render();
    });
    const list = contentEl.createDiv({ cls: "marklab-share-file-list" });
    for (const file of this.options.markdownFiles) {
      const row = list.createEl("label");
      row.addClass("marklab-share-file-option");
      const checkbox = row.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = this.selectedMultipleFilePaths.has(file.filePath);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedMultipleFilePaths.add(file.filePath);
        } else {
          this.selectedMultipleFilePaths.delete(file.filePath);
        }
        this.render();
      });
      row.createEl("span", { text: file.isActive ? `${file.label} (active)` : file.label });
    }
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const createButton = actions.createEl("button", { text: `Create ${this.role} links (${selectedFiles.length})` });
    createButton.addClass("mod-cta");
    createButton.disabled = selectedFiles.length === 0;
    createButton.addEventListener("click", () => {
      void this.createLinkSet(createButton, selectedFiles, "multiple");
    });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.close();
    });
  }
  renderVault() {
    const { contentEl } = this;
    const files = this.options.markdownFiles;
    contentEl.createEl("h3", { text: "Entire vault Markdown" });
    contentEl.createEl("p", {
      text: `Create a shareable link set for all ${files.length} Markdown page${files.length === 1 ? "" : "s"} in this vault. Attachments and non-Markdown files are excluded.`
    });
    contentEl.createEl("p", {
      text: "You will be asked to confirm before MarkLab starts background hosting or creates relay links for the vault."
    });
    new import_obsidian3.Setting(contentEl).setName("Link role").setDesc("The same role is used for every Markdown page in the vault.").addDropdown((dropdown) => {
      dropdown.addOption("view", "View").addOption("edit", "Edit").setValue(this.role).onChange((value) => {
        this.role = value === "edit" ? "edit" : "view";
        this.render();
      });
    });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const createButton = actions.createEl("button", { text: `Create ${this.role} links (${files.length})` });
    createButton.addClass("mod-cta");
    createButton.disabled = files.length === 0;
    createButton.addEventListener("click", () => {
      void this.createLinkSet(createButton, files, "vault");
    });
    const closeButton = actions.createEl("button", { text: "Close" });
    closeButton.addEventListener("click", () => {
      this.close();
    });
  }
  async createLink(createButton) {
    if (!this.selectedFilePath) {
      new import_obsidian3.Notice("Choose a Markdown page before creating a MarkLab link.");
      return;
    }
    const previousText = createButton.textContent ?? `Create ${this.role} link`;
    createButton.disabled = true;
    createButton.textContent = "Creating link...";
    try {
      const created = await this.options.createSinglePageLink(this.selectedFilePath, this.role);
      if (created) {
        this.close();
        return;
      }
    } catch (error) {
      new import_obsidian3.Notice(error instanceof Error ? error.message : String(error));
    }
    createButton.disabled = false;
    createButton.textContent = previousText;
  }
  selectedMultipleFiles() {
    return this.options.markdownFiles.filter((file) => this.selectedMultipleFilePaths.has(file.filePath));
  }
  async createLinkSet(createButton, files, scope) {
    if (files.length === 0) {
      new import_obsidian3.Notice("Choose at least one Markdown page before creating MarkLab links.");
      return;
    }
    const previousText = createButton.textContent ?? `Create ${this.role} links`;
    createButton.disabled = true;
    createButton.textContent = "Creating links...";
    try {
      const created = await this.options.createLinkSet(files, this.role, scope);
      if (created) {
        this.close();
        return;
      }
    } catch (error) {
      new import_obsidian3.Notice(error instanceof Error ? error.message : String(error));
    }
    createButton.disabled = false;
    createButton.textContent = previousText;
  }
};

// src/main.ts
var TextModal = class extends import_obsidian4.Modal {
  constructor(app, title, paragraphs, selectableText) {
    super(app);
    this.title = title;
    this.paragraphs = paragraphs;
    this.selectableText = selectableText;
  }
  title;
  paragraphs;
  selectableText;
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    for (const paragraph of this.paragraphs) {
      contentEl.createEl("p", { text: paragraph });
    }
    if (this.selectableText) {
      const textarea = contentEl.createEl("textarea");
      textarea.value = this.selectableText;
      textarea.rows = Math.min(12, Math.max(3, this.selectableText.split("\n").length));
      textarea.readOnly = true;
      textarea.addClass("marklab-selectable-text");
      textarea.select();
    }
  }
};
var ConfirmModal = class extends import_obsidian4.Modal {
  constructor(app, title, message, confirmText, onResolve) {
    super(app);
    this.title = title;
    this.message = message;
    this.confirmText = confirmText;
    this.onResolve = onResolve;
  }
  title;
  message;
  confirmText;
  onResolve;
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });
    contentEl.createEl("p", { text: this.message });
    const actions = contentEl.createDiv({ cls: "modal-button-container" });
    const confirmButton = actions.createEl("button", { text: this.confirmText });
    confirmButton.addClass("mod-cta");
    confirmButton.addEventListener("click", () => {
      this.onResolve(true);
      this.close();
    });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => {
      this.onResolve(false);
      this.close();
    });
  }
  onClose() {
    this.onResolve(false);
  }
};
function confirmAction(app, title, message, confirmText) {
  return new Promise((resolve) => {
    let resolved = false;
    const modal = new ConfirmModal(app, title, message, confirmText, (confirmed) => {
      if (resolved) return;
      resolved = true;
      resolve(confirmed);
    });
    modal.open();
  });
}
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
function isLocalDaemonUrl(value) {
  try {
    const url = new URL(value);
    return url.pathname.startsWith("/local") && url.hash.includes("token=");
  } catch {
    return false;
  }
}
function statusLabel(entry, shareState) {
  if (!entry || entry.daemon === "missing") return "Not hosted";
  if (entry.hasConflict || entry.syncState === "paused") return "Paused or conflicted";
  if (entry.syncState === "host_offline") return "Host offline";
  if (entry.syncState === "error") return "Status unavailable";
  if (shareState?.shareState.relayRoomId || entry.relayRoomId) return "Hosting and synced";
  if (entry.daemon === "running") return "Open locally and synced";
  return entry.syncState;
}
var MarkLabPlugin = class extends import_obsidian4.Plugin {
  settings = DEFAULT_SETTINGS;
  cli = new MarkLabCliAdapter({ command: DEFAULT_SETTINGS.cliCommand });
  async onload() {
    this.settings = normalizeSettings(await this.loadData());
    this.rebuildCliAdapter();
    this.addSettingTab(new MarkLabSettingTab(this.app, this));
    const ribbonIcon = this.addRibbonIcon("share-2", "MarkLab sharing", () => {
      this.openSharingPanel();
    });
    ribbonIcon.addClass("marklab-ribbon-sharing");
    this.addCommand({
      id: "open-sharing-panel",
      name: "Open sharing panel",
      callback: () => {
        this.openSharingPanel();
      }
    });
    this.addCommand({
      id: "check-setup",
      name: "Check setup",
      callback: () => {
        void this.checkSetup(true);
      }
    });
    this.addCommand({
      id: "share-current-note",
      name: "Share current note",
      callback: () => {
        void this.shareCurrentNote();
      }
    });
    this.addCommand({
      id: "create-edit-link-current-note",
      name: "Create edit link for current note",
      callback: () => {
        void this.createLinkForCurrentNote("edit");
      }
    });
    this.addCommand({
      id: "create-view-link-current-note",
      name: "Create view link for current note",
      callback: () => {
        void this.createLinkForCurrentNote("view");
      }
    });
    this.addCommand({
      id: "show-current-note-status",
      name: "Show current note status",
      callback: () => {
        void this.showCurrentNoteStatus();
      }
    });
    this.addCommand({
      id: "open-current-note",
      name: "Open current note in MarkLab",
      callback: () => {
        void this.openCurrentNote();
      }
    });
    this.addCommand({
      id: "copy-ai-handoff-instructions",
      name: "Copy AI handoff instructions",
      callback: () => {
        void this.copyAiHandoffInstructions();
      }
    });
    this.addCommand({
      id: "stop-sharing-current-note",
      name: "Stop sharing current note",
      callback: () => {
        void this.stopSharingCurrentNote();
      }
    });
  }
  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }
  rebuildCliAdapter() {
    this.cli = new MarkLabCliAdapter({
      command: this.settings.cliCommand,
      relayUrlOverride: this.settings.relayUrlOverride
    });
  }
  async checkSetup(showSuccessNotice = false) {
    let setup;
    try {
      setup = await this.cli.checkSetup();
    } catch (error) {
      new TextModal(this.app, "MarkLab setup", [
        humanizeCliError(error),
        "Check the CLI command setting and try again."
      ]).open();
      return false;
    }
    if (setup.available) {
      if (showSuccessNotice) new import_obsidian4.Notice("MarkLab CLI is available.");
      return true;
    }
    new TextModal(this.app, "MarkLab setup", [
      setup.message,
      "Install the MarkLab CLI yourself, then update the CLI command setting if needed.",
      "Suggested command setting after install: marklab",
      "You can also use npx -y @marklab/cli as the command setting for testing."
    ]).open();
    return false;
  }
  activeMarkdownPath() {
    try {
      return resolveActiveMarkdownFilePath(this.app);
    } catch (error) {
      new import_obsidian4.Notice(humanizeActiveNoteError(error));
      return null;
    }
  }
  openSharingPanel() {
    const markdownFiles = this.markdownFileChoices();
    if (markdownFiles.length === 0) {
      new import_obsidian4.Notice("No Markdown pages are available to share with MarkLab.");
      return;
    }
    new MarkLabSharingModal(this.app, {
      defaultRole: this.settings.defaultLinkRole,
      markdownFiles,
      createSinglePageLink: (filePath, role) => this.createLinkForFile(filePath, role),
      createLinkSet: (files, role, scope) => this.createLinksForFiles(files, role, scope)
    }).open();
  }
  markdownFileChoices() {
    const activeFile = this.app.workspace.getActiveFile();
    return this.app.vault.getMarkdownFiles().map((file) => ({
      label: file.path,
      filePath: resolveMarkdownFilePath(this.app, file),
      isActive: file.path === activeFile?.path
    })).sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }
  async ensureHosted(filePath, options = {}) {
    const confirmBeforeHosting = options.confirmBeforeHosting ?? true;
    const openBrowser = options.openBrowser ?? true;
    const status = await this.cli.status(filePath);
    const entry = status.files[0];
    if (entry?.daemon === "running") {
      const blockReason = sharingBlockReason(entry);
      if (blockReason) {
        new import_obsidian4.Notice(blockReason);
        return false;
      }
      return true;
    }
    if (this.settings.backgroundHostingPreference === "never") {
      new import_obsidian4.Notice("This note is not hosted by MarkLab. Background hosting is disabled in settings.");
      return false;
    }
    if (confirmBeforeHosting) {
      const confirmed = await confirmAction(
        this.app,
        "Start MarkLab hosting?",
        "MarkLab will start a persistent local background daemon for this note so relay links can work while the daemon remains online.",
        "Start hosting"
      );
      if (!confirmed) return false;
    }
    await this.cli.openBackground(filePath, { openBrowser });
    return true;
  }
  async shareCurrentNote() {
    await this.createLinkForCurrentNote(this.settings.defaultLinkRole);
  }
  async createLinkForCurrentNote(role) {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return false;
    return this.createLinkForFile(filePath, role);
  }
  async createLinkForFile(filePath, role) {
    if (!await this.checkSetup()) return false;
    try {
      if (!await this.ensureHosted(filePath)) return false;
      const link = await this.cli.createLink(filePath, role);
      await this.presentCreatedLink(link);
      return true;
    } catch (error) {
      new import_obsidian4.Notice(humanizeCliError(error));
      return false;
    }
  }
  async createLinksForFiles(files, role, scope) {
    if (files.length === 0) {
      new import_obsidian4.Notice("Choose at least one Markdown page before creating MarkLab links.");
      return false;
    }
    const confirmed = await this.confirmBatchSharing(files.length, role, scope);
    if (!confirmed) return false;
    if (!await this.checkSetup()) return false;
    const result = {
      scope,
      role,
      links: [],
      failures: []
    };
    for (const file of files) {
      try {
        const hosted = await this.ensureHosted(file.filePath, {
          confirmBeforeHosting: false,
          openBrowser: false
        });
        if (!hosted) {
          result.failures.push({
            label: file.label,
            filePath: file.filePath,
            message: "MarkLab could not start or verify background hosting for this page."
          });
          continue;
        }
        const link = await this.cli.createLink(file.filePath, role);
        if (isLocalDaemonUrl(link.url)) {
          result.failures.push({
            label: file.label,
            filePath: file.filePath,
            message: "MarkLab returned a local daemon URL, not a relay link."
          });
          continue;
        }
        result.links.push({
          label: file.label,
          filePath: file.filePath,
          role: link.role,
          url: link.url
        });
      } catch (error) {
        result.failures.push({
          label: file.label,
          filePath: file.filePath,
          message: humanizeCliError(error)
        });
      }
    }
    await this.presentCreatedLinkSet(result);
    return result.links.length > 0;
  }
  confirmBatchSharing(fileCount, role, scope) {
    const title = scope === "vault" ? "Share vault Markdown?" : "Create MarkLab link set?";
    const pageLabel = `${fileCount} Markdown page${fileCount === 1 ? "" : "s"}`;
    const scopeCopy = scope === "vault" ? `MarkLab will create one ${role} relay link for each of the ${pageLabel} in this vault. Attachments and non-Markdown files are excluded.` : `MarkLab will create one ${role} relay link for each of the ${pageLabel} you selected.`;
    return confirmAction(
      this.app,
      title,
      `${scopeCopy} This may start local background hosting for each page, but it will not open a browser tab for every file.`,
      "Create links"
    );
  }
  async presentCreatedLink(link) {
    if (isLocalDaemonUrl(link.url)) {
      new import_obsidian4.Notice("MarkLab returned a local daemon URL, so it was not copied as a share link.");
      return;
    }
    const copied = this.settings.copyCreatedLinksAutomatically ? await copyToClipboard(link.url) : false;
    if (copied) {
      new import_obsidian4.Notice(`Copied MarkLab ${link.role} link.`);
      return;
    }
    new TextModal(this.app, `MarkLab ${link.role} link`, ["Copy this relay link and send it to your collaborator."], link.url).open();
  }
  async presentCreatedLinkSet(result) {
    const scopeLabel = result.scope === "vault" ? "vault Markdown" : "multiple pages";
    const title = result.links.length > 0 ? `MarkLab ${result.role} link set` : "MarkLab link set failed";
    const summary = `Created ${result.links.length} link${result.links.length === 1 ? "" : "s"} for ${scopeLabel}.`;
    const failureSummary = result.failures.length > 0 ? `${result.failures.length} page${result.failures.length === 1 ? "" : "s"} could not be shared.` : "";
    const text = this.formatLinkSet(result, scopeLabel);
    if (result.links.length > 0 && result.failures.length === 0 && this.settings.copyCreatedLinksAutomatically) {
      const copied = await copyToClipboard(text);
      if (copied) {
        new import_obsidian4.Notice(`Copied MarkLab ${result.role} link set for ${result.links.length} page${result.links.length === 1 ? "" : "s"}.`);
        return;
      }
    }
    const paragraphs = failureSummary ? [summary, failureSummary, "Copy the links that were created successfully, and review any failed pages below."] : [summary, "Copy these relay links and send them to your collaborator."];
    new TextModal(this.app, title, paragraphs, text).open();
  }
  formatLinkSet(result, scopeLabel) {
    const lines = [
      `MarkLab ${result.role} link set (${scopeLabel})`,
      `Created: ${result.links.length}`,
      `Failed: ${result.failures.length}`,
      ""
    ];
    if (result.links.length > 0) {
      lines.push("Links:");
      for (const link of result.links) {
        lines.push(`- ${link.label}: ${link.url}`);
      }
      lines.push("");
    }
    if (result.failures.length > 0) {
      lines.push("Failures:");
      for (const failure of result.failures) {
        lines.push(`- ${failure.label}: ${failure.message}`);
      }
    }
    return lines.join("\n").trimEnd();
  }
  async showCurrentNoteStatus() {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!await this.checkSetup()) return;
    try {
      const status = await this.cli.status(filePath);
      const entry = status.files[0];
      let shareState = null;
      if (entry?.daemon === "running") {
        try {
          shareState = await this.cli.shareState(filePath);
        } catch {
          shareState = null;
        }
      }
      const linkCount = shareState?.shareState.links?.length ?? 0;
      const paragraphs = [
        `File: ${filePath}`,
        `State: ${statusLabel(entry, shareState)}`,
        `Relay room: ${shareState?.shareState.relayRoomId ?? entry?.relayRoomId ?? "not shared"}`,
        `Host online: ${shareState?.shareState.hostOnline === void 0 ? "unknown" : shareState.shareState.hostOnline ? "yes" : "no"}`,
        `Links: ${linkCount}`
      ];
      new TextModal(this.app, "MarkLab status", paragraphs).open();
    } catch (error) {
      new import_obsidian4.Notice(humanizeCliError(error));
    }
  }
  async openCurrentNote() {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!await this.checkSetup()) return;
    try {
      const status = await this.cli.status(filePath);
      const alreadyRunning = status.files[0]?.daemon === "running";
      if (!alreadyRunning) {
        const confirmed = await confirmAction(
          this.app,
          "Open in MarkLab?",
          "MarkLab will start persistent local background hosting for this note and open the local browser editor.",
          "Open"
        );
        if (!confirmed) return;
      }
      await this.cli.openBackground(filePath);
      new import_obsidian4.Notice("Opened current note in MarkLab.");
    } catch (error) {
      new import_obsidian4.Notice(humanizeCliError(error));
    }
  }
  async copyAiHandoffInstructions() {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    const instructions = buildAiHandoffInstructions({
      filePath,
      cliCommand: this.settings.cliCommand
    });
    const copied = await copyToClipboard(instructions);
    if (copied) {
      new import_obsidian4.Notice("Copied MarkLab AI handoff instructions.");
      return;
    }
    new TextModal(this.app, "MarkLab AI handoff instructions", ["Copy these instructions into your local AI agent."], instructions).open();
  }
  async stopSharingCurrentNote() {
    const filePath = this.activeMarkdownPath();
    if (!filePath) return;
    if (!await this.checkSetup()) return;
    const confirmed = await confirmAction(
      this.app,
      "Stop sharing?",
      "MarkLab will stop the local daemon for this note. Existing relay links will not work while the host is offline.",
      "Stop sharing"
    );
    if (!confirmed) return;
    try {
      await this.cli.stop(filePath);
      new import_obsidian4.Notice("Stopped MarkLab sharing for this note.");
    } catch (error) {
      new import_obsidian4.Notice(humanizeCliError(error));
    }
  }
};
