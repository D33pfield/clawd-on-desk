"use strict";

// Fills the Mood window's bars. Nothing numeric is shown on screen; the meter
// role needs aria-valuenow, and aria-valuetext gives screen readers a plain
// level instead.
(function () {
  const POLL_MS = 1000;

  function levelText(value) {
    if (value < 0.2) return "low";
    if (value < 0.6) return "moderate";
    return "high";
  }

  function apply(values) {
    for (const row of document.querySelectorAll(".row[data-mood]")) {
      const raw = Number(values && values[row.dataset.mood]);
      const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      row.querySelector(".fill").style.width = `${(value * 100).toFixed(1)}%`;
      const meter = row.querySelector(".track");
      meter.setAttribute("aria-valuenow", value.toFixed(2));
      meter.setAttribute("aria-valuetext", levelText(value));
    }
  }

  async function refresh() {
    try {
      apply(await window.moodAPI.get());
    } catch {}
  }

  refresh();
  setInterval(() => {
    if (!document.hidden) refresh();
  }, POLL_MS);
})();
