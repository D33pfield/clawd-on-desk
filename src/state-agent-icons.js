"use strict";

const path = require("path");
const fs = require("fs");
const { pathToFileURL } = require("url");

let nativeImage;
try { ({ nativeImage } = require("electron")); } catch { nativeImage = null; }

// Official logos from assets/icons/agents/.
const AGENT_ICON_DIR = path.join(__dirname, "..", "assets", "icons", "agents");
const _agentIconCache = new Map();
const _agentIconUrlCache = new Map();

function getAgentIcon(agentId) {
  if (!nativeImage || !agentId) return undefined;
  if (_agentIconCache.has(agentId)) return _agentIconCache.get(agentId);
  const iconPath = path.join(AGENT_ICON_DIR, `${agentId}.png`);
  if (!fs.existsSync(iconPath)) return undefined;
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  _agentIconCache.set(agentId, icon);
  return icon;
}

function getAgentIconUrl(agentId) {
  if (!agentId) return null;
  if (_agentIconUrlCache.has(agentId)) return _agentIconUrlCache.get(agentId);
  const iconPath = path.join(AGENT_ICON_DIR, `${agentId}.png`);
  const iconUrl = fs.existsSync(iconPath) ? pathToFileURL(iconPath).href : null;
  _agentIconUrlCache.set(agentId, iconUrl);
  return iconUrl;
}

module.exports = {
  AGENT_ICON_DIR,
  getAgentIcon,
  getAgentIconUrl,
};
