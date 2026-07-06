"use strict";

(function (root) {
  function truncate(s, max) {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function firstStringValue(input, names) {
    for (const name of names) {
      const value = input[name];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function formatAntigravityDetail(name, input) {
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    if (!toolName) return "";

    if (toolName === "run_command" || toolName === "bash" || toolName === "shell") {
      return truncate(firstStringValue(input, ["CommandLine", "command", "Command", "cmd"]), 160);
    }
    if (
      toolName === "write_to_file" ||
      toolName === "replace_file_content" ||
      toolName === "multi_replace_file_content" ||
      toolName === "write" ||
      toolName === "edit" ||
      toolName === "multiedit"
    ) {
      const filePath = firstStringValue(input, ["TargetFile", "AbsolutePath", "file_path", "path", "filePath", "FilePath"]);
      const description = firstStringValue(input, ["Description", "Instruction"]);
      return truncate(description && filePath ? `${filePath}: ${description}` : (filePath || description), 160);
    }
    if (toolName === "view_file" || toolName === "read") {
      return truncate(firstStringValue(input, ["AbsolutePath", "file_path", "path", "filePath", "FilePath"]), 160);
    }
    if (toolName === "list_dir") {
      return truncate(firstStringValue(input, ["DirectoryPath", "path", "directory"]), 160);
    }
    if (toolName === "find_by_name") {
      const searchPath = firstStringValue(input, ["SearchDirectory", "DirectoryPath", "path"]);
      const pattern = firstStringValue(input, ["Pattern", "pattern"]);
      return truncate(pattern && searchPath ? `${searchPath}: ${pattern}` : (searchPath || pattern), 160);
    }
    if (toolName === "grep_search") {
      const searchPath = firstStringValue(input, ["SearchPath", "SearchDirectory", "DirectoryPath", "path"]);
      const query = firstStringValue(input, ["Query", "query"]);
      return truncate(query && searchPath ? `${searchPath}: ${query}` : (searchPath || query), 160);
    }
    if (toolName === "ask_permission") {
      const target = firstStringValue(input, ["Target", "target", "Permission", "permission"]);
      const reason = firstStringValue(input, ["Reason", "reason", "Description", "description"]);
      return truncate(reason && target ? `${target}: ${reason}` : (target || reason), 160);
    }
    if (toolName === "read_url_content") {
      return truncate(firstStringValue(input, ["Url", "url"]), 160);
    }
    if (toolName === "search_web") {
      return truncate(firstStringValue(input, ["query", "Query"]), 160);
    }
    return "";
  }

  function formatDetail(name, input, options) {
    if (!input || typeof input !== "object") return "";
    if (typeof input.description === "string" && input.description.trim()) return truncate(input.description.trim(), 120);
    if (name === "Bash" && input.command) return truncate(input.command, 120);
    if ((name === "Edit" || name === "Write" || name === "Read") && input.file_path)
      return truncate(input.file_path, 120);
    if ((name === "Glob" || name === "Grep") && input.pattern)
      return truncate(input.pattern, 120);
    if (options && options.isAntigravity) {
      const antigravityDetail = formatAntigravityDetail(name, input);
      if (antigravityDetail) return antigravityDetail;
    }
    for (const v of Object.values(input)) {
      if (typeof v === "string" && v.trim()) return truncate(v.trim(), 100);
    }
    return truncate(JSON.stringify(input), 100);
  }

  // Issue #445: MCP tool names arrive as opaque, scary-looking identifiers
  // (e.g. "MCP__CODEX_APPS__VERCEL__LIST_PROJECTS"). Parse them into a friendly
  // "server · tool" label for display ONLY. Naming differs across agents —
  // Codex uses upper-case 4-segment names, Claude Code uses lower-case 3-segment
  // ("mcp__github__list_issues") — so we are case-insensitive and key off the
  // last two segments. Returns null for anything that is not MCP-shaped, so the
  // caller falls back to the raw name. This must never throw and must never
  // decide safety/approval behavior.
  // Irreversible-action hint (display-only). Conservative patterns — precision over
  // recall: a false badge is noise on a minimalist pet, a missed one just means no hint.
  // Like the MCP relabel (#445), this never touches Allow/Deny semantics or the
  // no-decision fallback — it only routes the human's attention to decisions that
  // cannot be undone (force-push, publish, bulk delete, history rewrite).
  const IRREVERSIBLE_PATTERNS = [
    { tag: "force-push", re: /\bgit\s+push\b[^\n]*(\s--force(-with-lease)?\b|\s-f\b)/ },
    { tag: "remote-delete", re: /\bgit\s+push\b[^\n]*\s--delete\b/ },
    { tag: "branch-delete", re: /\bgit\s+branch\b[^\n]*\s-D\b/ },
    { tag: "history-rewrite", re: /\bgit\s+(reset\s+--hard|filter-branch|filter-repo)\b/ },
    { tag: "file-delete", re: /\brm\s+-[a-zA-Z]*[rf]/ },
    { tag: "git-clean", re: /\bgit\s+clean\b[^\n]*\s-[a-zA-Z]*f/ },
    { tag: "publish", re: /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b|\bcargo\s+publish\b/ },
    { tag: "repo-delete", re: /\bgh\s+(repo|release)\s+delete\b/ },
    { tag: "go-public", re: /\bgh\s+repo\s+(create|edit)\b[^\n]*--(public\b|visibility[= ]public)/ },
    { tag: "db-destroy", re: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i },
    { tag: "infra-destroy", re: /\bterraform\s+destroy\b|\bkubectl\s+delete\b/ },
  ];
  const SHELL_TOOLS = new Set(["bash", "shell", "run_command", "exec", "run_terminal_cmd"]);

  function detectIrreversible(name, input) {
    const toolName = typeof name === "string" ? name.trim().toLowerCase() : "";
    const obj = input && typeof input === "object" ? input : {};
    // Shell-ish tools: scan the command string.
    if (SHELL_TOOLS.has(toolName)) {
      const cmd = firstStringValue(obj, ["command", "CommandLine", "Command", "cmd", "script"]);
      if (!cmd) return null;
      for (const p of IRREVERSIBLE_PATTERNS) {
        if (p.re.test(cmd)) return { tag: p.tag };
      }
      return null;
    }
    // Explicit destructive file tools only (generic "delete" substrings would
    // over-match MCP tools like delete_draft — stay conservative).
    if (toolName === "delete_file" || toolName === "deletefile" || toolName === "remove_file") {
      return { tag: "file-delete" };
    }
    return null;
  }

  function parseMcpToolName(toolName) {
    if (typeof toolName !== "string" || !toolName) return null;
    const segs = toolName.split("__");
    if (segs.length < 2 || segs[0].toLowerCase() !== "mcp") return null;
    const rest = segs.slice(1);
    // Any empty segment (leading / middle / trailing "__") means a malformed
    // name: fall back to the raw display rather than a misleading partial label
    // (e.g. "MCP__CODEX_APPS__VERCEL__" must NOT render as "codex_apps · vercel").
    if (rest.some((seg) => seg === "")) return null;
    const tool = rest[rest.length - 1].toLowerCase();
    const server = rest.length >= 2 ? rest[rest.length - 2].toLowerCase() : null;
    const display = server ? `${server} · ${tool}` : tool;
    return { server, tool, display };
  }

  const api = { formatDetail, formatAntigravityDetail, truncate, firstStringValue, parseMcpToolName, detectIrreversible };

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else if (root && typeof root === "object") {
    root.ClawdBubbleFormat = api;
  }
})(typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : globalThis));
