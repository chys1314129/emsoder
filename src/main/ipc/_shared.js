/**
 * Shared context object passed to each IPC domain module's register().
 *
 * @typedef {Object} IpcCtx
 * @property {object} cfg - mutable config object
 * @property {Function} saveConfig
 * @property {object} sessions - SessionStore
 * @property {object} runner - AgentRunner
 * @property {object} terminals - TerminalManager
 * @property {object} ptyBridge - PtyBridge
 * @property {object} memoryStore - MemoryStore
 * @property {object} mcpManager - McpManager
 * @property {object} questStore - QuestStore
 * @property {object} questRunner - QuestRunner
 * @property {object} nodeDebugger - NodeDebugger
 * @property {BrowserWindow|null} getWindow - () => mainWindow
 * @property {object} dialog - electron dialog
 * @property {Function} publicConfig
 * @property {Function} publicSession
 * @property {Function} askConfirm
 */

// Re-export shared helpers that multiple domain modules need.
const { app } = require("electron");
const path = require("path");

function draftsPath() {
  return path.join(app.getPath("userData"), "emsoder-drafts.json");
}

module.exports = { draftsPath };
