"use strict";

async function startMobilePreviewServerSafely(server, options = {}) {
  if (!server || typeof server.start !== "function") return null;
  const source = options.source || "runtime";
  const onError = typeof options.onError === "function"
    ? options.onError
    : (err) => console.warn(
      `[mobile-preview] ${source} start failed:`,
      err && err.message ? err.message : err,
    );
  try {
    return await server.start();
  } catch (err) {
    onError(err, source);
    return null;
  }
}

module.exports = { startMobilePreviewServerSafely };
